---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500398
---

# Drain blocked by a PodDisruptionBudget that cannot be satisfied

## Issue

On Alauda Container Platform (Kubernetes v1.34.5, where the `policy` API group serves `poddisruptionbudgets` only at `policy/v1` and the `v1beta1` shape is no longer registered), a node drain that goes through the Eviction subresource can stall indefinitely when the targeted pod is selected by a PodDisruptionBudget that cannot tolerate one more disruption. The Eviction endpoint rejects the request with `HTTP 429 TooManyRequests` (the top-level Status `reason` field) and a `details.causes[].reason` of `DisruptionBudget`; the verbatim message `Cannot evict pod as it would violate the pod's disruption budget.` is surfaced on the Status, and the `causes.message` field names the offending budget and the current / required healthy-pod counts (for example, `The disruption budget pdb-canary-block needs 2 healthy pods and has 2 currently`).

`kubectl drain` issues these Eviction calls rather than direct DELETEs — its built-in help confirms that drain "evicts the pods if the API server supports eviction" — so any PDB that selects the pods on the targeted node is honored end-to-end by the drain workflow. The Immutable Infrastructure node-rollout path on Alauda Container Platform, which cordons and drains nodes in turn during a controlled rotation, exercises the same cordon-then-drain sequence (the cordon step flips `Node.spec.unschedulable=true` and `kubectl` then renders `SchedulingDisabled` in the node STATUS column) and is therefore subject to the same PDB gate on the Eviction call; if a budget cannot be satisfied the rollout cannot make progress past the affected node.

## Root Cause

A PodDisruptionBudget governs voluntary disruptions for the set of pods matched by its `selector`. Only the Eviction subresource (`POST .../pods/<name>/eviction`) consults the budget at admission — a direct `DELETE` against the pod resource bypasses the check entirely, because PDB only gates evictions. When the current healthy-replica count of the matched workload equals the budget's `minAvailable` (or has already reached the `maxUnavailable` ceiling), every eviction would drop the workload below the configured floor and the API server denies the request with `429`.

The canonical mis-configuration is a single-replica workload paired with `minAvailable: 1`: the one running replica is simultaneously the last healthy pod and the only eviction candidate, so the budget is never satisfiable and the drain client retries the same pod forever, logging `error when evicting pods/<name>: Cannot evict pod as it would violate the pod's disruption budget. will retry after 5s` on each retry. The same failure mode also surfaces during rolling node reboots: if successive drains concentrate every replica of a workload onto one remaining node, evicting the last replica would violate the budget and that node's drain is blocked from completing.

## Resolution

Pick the lowest-impact path that fits the workload — relaxing the budget is preferred for stateless workloads, scale-to-zero is preferred when the workload can tolerate a brief outage, and direct delete is the last-resort knob for stuck rollouts. All four paths below take the eviction denial off the critical path either by changing what the budget evaluates to or by bypassing the Eviction subresource that consults it.

Path 1 — relax the PDB for the maintenance window. Patch `spec.minAvailable` to `0` so subsequent evictions are admitted; the Eviction subresource returns `201 Success` against the same pod once the patch lands. Restore the original value once the drain has completed:

```bash
kubectl patch pdb <name> -n <ns> --type=merge \
  -p '{"spec":{"minAvailable":0}}'
```

Path 2 — scale the workload to zero before the drain. Reducing `replicas` goes through the `/scale` subresource, which does not invoke `/eviction`, so the PDB is not consulted and the rollout has no pods left to evict from any node:

```bash
kubectl scale deployment/<name> -n <ns> --replicas=0
```

Path 3 — drain without going through the Eviction subresource. `kubectl drain --disable-eviction` switches the drain client to direct DELETE calls; its own help text states that the flag is intended to "Force drain to use delete, … This will bypass checking PodDisruptionBudgets". Because the drain no longer hits the Eviction endpoint, no `will retry after 5s ... Cannot evict` retries are emitted and any selecting PDB is ignored:

```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data --disable-eviction
```

Path 4 — delete the blocking pod directly. A `kubectl delete pod` request goes through the pod resource (not `/eviction`), so the PDB does not gate it; the workload controller then recreates the replica, and if the source node is cordoned the scheduler places it elsewhere:

```bash
kubectl delete pod -n <ns> <pod>
```

A direct DELETE is destructive — it skips the graceful disruption budget that the workload owner put in place, which is the whole point of a PDB. Two specific workload classes must not be treated with the Path 3 or Path 4 bypass without additional care:

- KubeVirt `virt-launcher` pods. The KubeVirt CRDs (`virtualmachineinstances`, `virtualmachines`) and the `virt-controller` deployment in namespace `kubevirt` are present on this cluster, so `virt-launcher` pods are real eviction targets. Bypassing the PDB on a `virt-launcher` pod terminates the wrapping Virtual Machine ungracefully instead of triggering a live migration, so the PDB-bypass paths are unsafe for KubeVirt-managed virtualization workloads.
- Quorum-sensitive stateful pods more generally. The default Alauda Container Platform install does not ship a Ceph operator, but if a third-party Ceph deployment (for example a rook-ceph operator) or any other quorum-based stateful workload is installed on the cluster, the same caution applies: bypassing a PDB that fronts a monitor- or quorum-member pod while the underlying cluster is not fully healthy can drop the surviving quorum and risk data loss. For any PDB that fronts a stateful or quorum-sensitive workload, confirm the underlying cluster is healthy before applying Path 3 or Path 4 — the PDB is the workload owner's signal that voluntary disruption is unsafe right now.

When authoring or re-creating a PodDisruptionBudget on this cluster, use the served group/version (`policy/v1`); the `v1beta1` shape is no longer offered by the API server:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: <name>
  namespace: <ns>
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: <label>
```

## Diagnostic Steps

Reproduce the symptom against the suspect pod by posting to the Eviction subresource and observing the `429 TooManyRequests` response. The status payload carries `reason: DisruptionBudget`, the verbatim message `Cannot evict pod as it would violate the pod's disruption budget.`, and a `causes.message` line that names the offending budget plus its required vs current healthy-pod counts — that string is the canonical fingerprint for this failure mode and is the cheapest reproducer to confirm a stuck drain is in fact PDB-gated rather than blocked on something else.

At the workflow level the same signal appears as a drain client that emits the `evicting pod ...` log line (drain uses the Eviction subresource, so it logs `evicting`, not `deleting`) and then retries the same pod every five seconds with `error when evicting pods/<name>: Cannot evict pod as it would violate the pod's disruption budget. will retry after 5s` until the budget changes.

A node that is partway through a controller-driven drain — for example, an Immutable Infrastructure node rotation — reports `STATUS: Ready,SchedulingDisabled` in `kubectl get node`, because the cordon step sets `Node.spec.unschedulable=true` and `kubectl` renders that boolean in the `STATUS` column. Pair that signal with PDB inspection to confirm whether the drain is merely cordoned or is also stuck on an Eviction denial:

```bash
kubectl get node
kubectl get pdb -A
kubectl describe pdb <name> -n <ns>
```
