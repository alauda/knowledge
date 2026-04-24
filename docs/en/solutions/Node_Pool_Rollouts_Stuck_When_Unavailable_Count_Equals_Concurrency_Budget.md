---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A worker node pool has been rendered to a new node configuration, but the rollout makes no forward progress. Inspecting the pool object shows it is in an `Updating=True`, `Degraded=False` state with zero updated machines, even though the cluster appears otherwise healthy:

```text
NAME     CONFIG            UPDATED  UPDATING  DEGRADED  MACHINECOUNT  READY  UPDATED
worker   rendered-worker   False    True      False     10            0      0
```

`unavailableMachineCount` is greater than zero, but no `Degraded` condition is set, so the rollout is not failing — it is *paused* by its own concurrency policy.

## Root Cause

A `MachineConfigPool` (the per-pool rollout controller used by the Immutable Infrastructure node-config layer on ACP) refuses to drain another node whenever:

```text
.status.unavailableMachineCount  >=  .spec.maxUnavailable
```

`maxUnavailable` defaults to `1` when not set in the spec. Any of the following counts a node toward `unavailableMachineCount`:

- the node is `NotReady` (kubelet not posting heartbeats, network partition, container runtime down, disk pressure, etc.);
- the node is `SchedulingDisabled` because the pool itself cordoned it as part of an in-progress drain.

The result is a deadlock: an unrelated `NotReady` node consumes the entire rollout budget, and the controller will not pick up the next node until that one recovers or the budget grows. The table below makes the relationship explicit:

| `unavailableMachineCount` | `maxUnavailable` | Behaviour                          |
| ------------------------- | ---------------- | ---------------------------------- |
| 0                         | 1 (default)      | rolls one node at a time           |
| 0                         | 2                | rolls two nodes in parallel        |
| 0                         | 5                | rolls five nodes in parallel       |
| 1                         | 1 (default)      | **stuck** — no further nodes drain |
| 1                         | 2                | rolls one node at a time           |
| 2                         | 5                | rolls three nodes in parallel      |

There is nothing wrong with the rollout itself; the safety budget is doing exactly what it was asked to do.

## Resolution

The preferred surface on ACP is `configure/clusters/nodes` (and the **Immutable Infrastructure** extension), which exposes node pools and their `maxUnavailable` setting in the platform UI. Adjust the budget there so the platform reconciles the underlying CR and records the change in the audit log; the steps below show the equivalent operations for an environment without the UI surface available.

> **Do not** apply any of these to control-plane pools. Increasing the control-plane `maxUnavailable` can take quorum below the etcd safe minimum.

### 1. Restore the unavailable nodes first

This is almost always the right answer; growing the budget on top of an unhealthy cluster just spreads the problem.

- Find which nodes are dragging the count up:

  ```bash
  kubectl get nodes -o wide
  kubectl get nodes -o jsonpath='{range .items[?(@.spec.unschedulable==true)]}{.metadata.name}{"\n"}{end}'
  ```

- For a node that is genuinely cordoned but healthy, uncordon it:

  ```bash
  kubectl uncordon <node>
  ```

- For a `NotReady` node, recover the kubelet / network / runtime root cause before doing anything else. A `NotReady` node that gets uncordoned will simply re-enter the unavailable count on the next reconcile.

### 2. Temporarily widen the rollout budget

If the cluster is large enough to absorb a wider drain (e.g. a 10-node worker pool with several spare capacity), bump `maxUnavailable` long enough to push the rollout past the stuck node. Set it back afterwards.

```bash
kubectl patch machineconfigpool worker --type=merge \
  -p '{"spec":{"maxUnavailable":3}}'
```

Or edit the object directly:

```bash
kubectl edit machineconfigpool worker
```

```yaml
spec:
  maxUnavailable: 3
```

### 3. Re-tighten after recovery

When the unavailable nodes are back, restore the conservative budget. A permanently-wide `maxUnavailable` is a foot-gun: a future rollout combined with even one transient `NotReady` will cause many concurrent drains.

```bash
kubectl patch machineconfigpool worker --type=merge \
  -p '{"spec":{"maxUnavailable":1}}'
```

### 4. Prefer percentage-based budgets in the platform UI

For pools that scale, declare `maxUnavailable` as a percentage instead of an integer through the node-pool surface in `configure/clusters/nodes`. The platform translates the percentage to an integer at reconcile time and the budget grows with the pool, so a 10% budget on a 30-node pool always tolerates one transient failure.

## Diagnostic Steps

Inspect the pool spec and current counts:

```bash
kubectl get mcp worker -o jsonpath='{.spec.maxUnavailable}{"\n"}'
kubectl get mcp worker -o jsonpath='{.status.unavailableMachineCount}{"\n"}'
kubectl get mcp worker -o jsonpath='{.status.machineCount}{"\n"}'
kubectl get mcp worker -o jsonpath='{.status.updatedMachineCount}{"\n"}'
```

Map the unavailable count to actual nodes — both `NotReady` and `SchedulingDisabled` count, and the two are listed differently in `kubectl get nodes`:

```bash
kubectl get nodes \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.conditions[?(@.type=="Ready")].status,CORDON:.spec.unschedulable'
```

Tail the node-controller / pool-controller logs in the namespace that owns it to see why a particular node will not drain (the controller logs each draining decision and the reason it bailed):

```bash
kubectl -n machine-config-operator logs -l k8s-app=machine-config-controller --tail=200 | grep -Ei 'drain|unavail|maxUnavail'
```

If the count never drops even after `kubectl uncordon`, check for `PodDisruptionBudget` objects that are blocking pod evictions on the cordoned node — drain budgets and eviction budgets are independent, and a workload PDB at `minAvailable: 100%` will keep a node `SchedulingDisabled` indefinitely:

```bash
kubectl get pdb -A -o wide
```
