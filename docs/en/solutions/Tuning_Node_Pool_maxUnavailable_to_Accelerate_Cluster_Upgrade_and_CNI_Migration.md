---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Tuning Node-Pool maxUnavailable to Accelerate Cluster Upgrade and CNI Migration
## Issue

A cluster operator wants to widen the concurrency of node rollouts — either during a platform upgrade, or when migrating the cluster network from one CNI to another (for instance, between revisions of Kube-OVN, or from a legacy CNI to Kube-OVN). The default policy rolls nodes one at a time, which is safe but slow on large clusters with hundreds of workers: a full rollout can take several hours or overnight.

The question is whether the concurrency cap on the node-pool controller (conceptually a `maxUnavailable` for node-config rollouts) can be raised to allow the controller to pick and drain multiple worker nodes simultaneously, and whether that is supported for both upgrades and CNI migrations.

## Root Cause

This is a configuration decision rather than a defect. The platform's node-config controller (in ACP this is the **Immutable Infrastructure** stack; in other distributions the name varies) treats the rendered configuration for a pool as the target, then rolls nodes toward that target one (or a few) at a time. The concurrency is capped by a `maxUnavailable` field on the pool, defaulting to `1` so that a bad configuration only disables a single node at once. Operators with sufficient slack (capacity headroom, pod-level HA via multiple replicas, DaemonSets tolerant of one replica down, etc.) can safely raise the cap to speed rollouts.

Worker pools can be tuned; control-plane pools should not. Control-plane nodes typically run etcd, and losing etcd quorum is a cluster-wide outage. The node-config controller itself refuses to bring down multiple control-plane nodes at once for that reason.

## Resolution

ACP's node-configuration story is delivered through **`configure/clusters/nodes`** in-core and the **Immutable Infrastructure** extension product (rendered node configuration, atomic rollouts). The same `maxUnavailable` concept applies: raising it on a worker pool speeds up both upgrade and CNI-migration rollouts; raising it on a control-plane pool is not supported.

### Preferred: ACP Immutable Infrastructure with a worker-pool override

1. **Confirm which node pools exist.** In ACP managed clusters there is typically one pool per role (`master` / `worker`) plus any custom pools created for specialised workloads (GPU, infra, edge).

   ```bash
   kubectl get machineconfigpool
   ```

2. **Plan the new concurrency.** A good starting point on a worker pool is:

   - **Small clusters (< 20 workers):** `maxUnavailable: 2` — buys a 2× speedup with one-node slack.
   - **Medium clusters (20–100 workers):** `maxUnavailable: 5–10` — balances rollout time against blast radius if a render is bad.
   - **Large clusters (> 100 workers):** `maxUnavailable: 10%` (percentage form) — scales linearly with pool size.

   The correct upper bound is workload-driven: cluster-critical pods must still have enough surviving replicas to serve traffic while `maxUnavailable` nodes are cordoned and draining. Anything with a `PodDisruptionBudget` set to `minAvailable: 1` on a two-replica Deployment will stall the rollout — rather than fight the PDB, raise replicas first.

3. **Patch the worker pool.** The field is `.spec.maxUnavailable` on the pool object. Apply with a merge patch:

   ```bash
   kubectl patch machineconfigpool worker \
     --type=merge \
     -p '{"spec":{"maxUnavailable": 3}}'
   ```

   The percentage form is accepted as a string:

   ```bash
   kubectl patch machineconfigpool worker \
     --type=merge \
     -p '{"spec":{"maxUnavailable":"10%"}}'
   ```

4. **Observe the rollout.** Once the pool has a pending render (during an upgrade or a CNI migration), the controller should now drain and reboot several workers in parallel:

   ```bash
   kubectl get machineconfigpool worker -w
   kubectl get node -l node-role.kubernetes.io/worker -w
   ```

   The `UPDATED`, `UPDATING`, `READY`, and `MACHINECOUNT` columns on the pool reflect progress. `UPDATING` should now read up to your chosen `maxUnavailable` rather than always `1`.

5. **Revert after the roll-out completes.** The higher concurrency is only valuable while large batches of nodes need to change. Once steady state is reached, set `maxUnavailable` back to `1` to minimise blast radius if a single subsequent render is bad:

   ```bash
   kubectl patch machineconfigpool worker \
     --type=merge \
     -p '{"spec":{"maxUnavailable": 1}}'
   ```

### Control-plane pools: do not tune

The `master` pool must roll one node at a time. Control-plane nodes run etcd (or, on Hosted Control Plane topologies, other single-writer components). Draining two at once risks losing quorum; the node-config controller refuses to do so even if `maxUnavailable` is raised, but the field should not be changed to avoid confusing later operators inspecting the pool spec.

### Fallback: stock Kubernetes without a managed node-config controller

If the cluster is not running under Immutable Infrastructure (or an equivalent rendered-config controller), then the concept of "node-config `maxUnavailable`" does not exist — node-level configuration is applied out of band via DaemonSets, `kubectl cordon/drain` loops, or configuration management tools. In that case, the operator's own rollout script controls concurrency directly. The capacity-planning guidance above still applies: do not cordon more nodes at once than the cluster can absorb without violating PDBs.

## Diagnostic Steps

Confirm the pool actually picks up the new `maxUnavailable`:

```bash
kubectl get machineconfigpool worker \
  -o jsonpath='{.spec.maxUnavailable}{"\n"}'
```

During a rollout, count the workers the controller has in flight:

```bash
kubectl get node -l node-role.kubernetes.io/worker \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.unschedulable}{"\n"}{end}' \
  | awk '$2=="true"{c++} END{print c+0 " cordoned"}'
```

If this number stays pinned at `1` when `maxUnavailable` is set higher, the controller is being rate-limited by something else — usually a PDB. Identify the blocking budget:

```bash
kubectl get pdb -A
kubectl get event -A --field-selector reason=FailedEviction --sort-by=.lastTimestamp | tail -20
```

If a PDB is the blocker, the fix is either raising the application's replica count so evictions can proceed, or tolerating a longer rollout and leaving `maxUnavailable` at its default.

For CNI migration specifically, also watch the Kube-OVN (or other CNI) components that sit on each node, since the rollout window is when they switch between versions:

```bash
kubectl get pods -n kube-system -l app=kube-ovn -o wide
```

Any component stuck `CrashLoopBackOff` on a migrated node is a signal to pause the rollout (temporarily drop `maxUnavailable` back to `1`) until the offending node is recovered, rather than letting several nodes transition into the same bad state in parallel.
