---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# PodDisruptionBudget Blocking a Node Drain During Rolling Node Config
## Issue

A rolling node-configuration change (kernel parameter update, chrony push, kubelet config change) applied through the node-config controller gets stuck. One or more nodes sit in `Ready,SchedulingDisabled`, the rollout progress never advances past that node, and the controller's log stream keeps retrying an eviction for the same pod:

```text
error when evicting pod "test-1-xxxxx" (will retry after 5s):
  Cannot evict pod as it would violate the pod's disruption budget.
```

Node listing shows cordoned nodes the drain never completes:

```bash
kubectl get node
# NAME                          STATUS                      ROLES    VERSION
# ip-10-0-111-11.example.com    Ready,SchedulingDisabled    worker   v1.29.x
# ip-10-0-222-22.example.com    Ready                       worker   v1.29.x
```

The pod referenced in the error is running healthy — it simply cannot be evicted because an associated `PodDisruptionBudget` (PDB) has its allowed-disruptions count at zero. Until the PDB lets the pod go, the node does not drain, the new node configuration cannot be applied, and the whole rolling change pauses indefinitely.

## Root Cause

A `PodDisruptionBudget` caps how many pods of a selector may be voluntarily disrupted at once. The typical setting is `minAvailable: 1`, which is sensible for a two-replica service: at most one pod can go away at a time.

This interacts badly with a node drain when:

- The pod's `replicas` is exactly `1`. `minAvailable: 1` then means zero allowed disruptions, and eviction always returns the PDB error above, forever.
- Several replicas of the same service happen to be scheduled on a single node. Pod anti-affinity not being set on the Deployment, or nodes having been rebooted earlier and all replicas rescheduling to whichever node came up first, both produce this. The PDB refuses to let any of them move until another replica is healthy elsewhere — but there is no elsewhere because the other node is cordoned.
- The PDB was configured against a workload whose lifecycle is actually not eligible for voluntary disruption (single-replica batch job, stateful singleton with manual failover). These need manual handling, not a blocker PDB against an automated drain.

When the rolling node-config is driven by the ACP node-config controller (the in-core `configure/clusters/nodes` surface, or the extension product **Immutable Infrastructure**), the symptom is the same as on any Kubernetes cluster: the drain the controller issues is a normal eviction API call and honours every PDB in the cluster.

## Resolution

Before touching a PDB, confirm which offending pod it guards and decide whether that pod is actually safe to disrupt. Some PDBs are in place for a reason.

- **Storage-backed singletons** such as a Ceph monitor pod — forcibly evicting one below a quorum threshold risks data loss. Resolve the storage cluster's health first and let the drain proceed naturally.
- **Virtualization workloads** — a `virt-launcher` pod backed by a KubeVirt live VM inside the ACP `virtualization` area should not be killed outright. The PDB is expressing a real constraint (the VM is live-migrating or cannot migrate fast enough). Debug the migration first (usually RAM dirty rate vs network bandwidth), not the PDB.

Once you have confirmed the pod is safe to disrupt, pick one of the following.

### 1. Check whether co-scheduling is the real problem

Many "stuck drain" incidents are not a PDB problem — they are a co-location problem. Three replicas of a Deployment with a PDB of `minAvailable: 2` sitting on the same node will block any drain of that node even though the cluster has room for them elsewhere:

```bash
kubectl -n <namespace> get pod -o wide -l <selector>
```

If the replicas cluster on one node, it means scheduling is not spreading them. Adding pod anti-affinity (`topologyKey: kubernetes.io/hostname`) or topology spread constraints to the Deployment and waiting for the replicas to redistribute often unblocks the drain on its own, without touching the PDB.

### 2. Delete the blocked pod to force rescheduling

The PDB stops the eviction API path but not a direct `delete`. If another node has capacity, deleting the pod re-creates it elsewhere and the drain proceeds:

```bash
kubectl -n <namespace> delete pod <pod-name>
watch -n 10 'kubectl get node -o wide; echo; kubectl get pdb -A'
```

Use this when the PDB is protecting a real invariant at normal load (say, 3 replicas with `minAvailable: 2`) but the drain itself does not invalidate that invariant — moving one replica to another node keeps two available.

### 3. Relax the PDB temporarily

When the workload is a single-replica Deployment where the PDB author intended "do not disrupt casually" but accepts planned disruption, patch the PDB to allow zero minimum available for the duration of the drain, then restore it afterwards:

```bash
kubectl -n <namespace> patch pdb <pdb-name> \
  --type=merge -p '{"spec":{"minAvailable":0}}'

# after the node-config rollout reports complete
kubectl -n <namespace> patch pdb <pdb-name> \
  --type=merge -p '{"spec":{"minAvailable":1}}'
```

If the patch is rejected with `updates to poddisruptionbudget spec are forbidden`, the PDB is using an older immutable-spec schema. Back it up, delete it, let the drain complete, then recreate it:

```bash
kubectl -n <namespace> get pdb <pdb-name> -o yaml > pdb.yaml
kubectl -n <namespace> delete pdb <pdb-name>
# after the rollout completes, strip status and uid from pdb.yaml, then
kubectl -n <namespace> apply -f pdb.yaml
```

### 4. Scale the workload to zero across the maintenance window

For workloads that do not need to run during the rollout — batch consumers, test harnesses, any workload flagged as "best-effort" — the simplest unblock is to scale the Deployment to zero replicas. A Deployment at `replicas: 0` disrupts nothing, so any PDB against its selector has `ALLOWED DISRUPTIONS = 0` vacuously and the drain proceeds. Scale the Deployment back after the rollout completes.

## Diagnostic Steps

List every PDB in the cluster and look for entries with zero allowed disruptions — those are the candidates blocking drains:

```bash
kubectl get pdb -A \
  -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,MIN:.spec.minAvailable,MAX:.spec.maxUnavailable,ALLOW:.status.disruptionsAllowed,DESIRED:.status.desiredHealthy,CURRENT:.status.currentHealthy \
  | awk 'NR==1 || $5=="0"'
```

Correlate a specific eviction failure to a specific PDB by looking at the controller logs for the node-config controller and matching the pod name it is retrying on:

```bash
kubectl -n <node-config-namespace> logs <controller-pod> \
  | grep -E 'evicting pod|disruption budget' | tail
```

Confirm where replicas of the stuck pod's workload are sitting:

```bash
kubectl -n <namespace> get pod -l <selector> -o wide
```

Watch the rollout as corrective action is taken — once the blocking pod either moves, is deleted, or is scaled out of existence, the node drain should progress within one or two eviction retry cycles:

```bash
watch -n 10 'kubectl get node -o wide; echo; \
  kubectl get pdb -A; echo; \
  kubectl get clusteroperator 2>/dev/null || true'
```

If the rollout still does not advance after the PDB stops blocking, look for a second PDB guarding a different workload on the same node — drains fail against the *first* eviction error but another pod on the same node may become the new blocker after the first unblocks.
