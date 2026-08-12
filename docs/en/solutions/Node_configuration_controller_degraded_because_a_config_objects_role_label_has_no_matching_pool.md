---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Node configuration controller degraded because a config object's role label has no matching pool
## Issue

The cluster's node-configuration operator goes degraded shortly after a new node-config object lands on the cluster. The render controller log is repeatedly emitting one entry like:

```text
error finding pools for machineconfig:
  could not find any MachineConfigPool set for MachineConfig <name>
  with labels: map[<role>:...]
```

No nodes are rolling, no rolling update is in progress, but the operator's status condition keeps the `Degraded=True` flag pinned because the render controller can't decide which pool the new object belongs to.

## Root Cause

The node-configuration model splits concerns into three resources:

- A node-configuration object (`MachineConfig`-equivalent) carries a role label such as `node-role.kubernetes.io/<role>`.
- A pool object groups nodes by a `nodeSelector` and selects which configuration objects belong to it through a `machineConfigSelector`.
- The render controller fans the matching configuration objects out into a single rendered configuration per pool and ships that to the nodes.

The render controller errors as soon as it sees a configuration object whose role label is not selected by any pool's `machineConfigSelector`. Two common causes:

- A typo in the configuration object's role label — `worker1` instead of `worker`, `Master` instead of `master`. The selector on the existing `worker` pool only matches `worker`, so the new object is orphaned.
- A new pool was intended to host the new object (for example a `worker-rt` pool for real-time workloads) but the pool's `machineConfigSelector` has not been updated to include the new role value.

The render controller does not auto-create pools, and it does not silently drop orphaned objects either — it would rather refuse to render than render an inconsistent state, hence the degraded condition.

## Resolution

Fix the mismatch on whichever side is wrong. Two paths:

If the role label in the configuration object was a typo, edit the object and put the correct role on it. The role is encoded as a label on the object — fix the value and re-apply.

A clean apply restarts the render and the degraded condition clears within seconds.

If the role label is correct but the cluster needs a new pool to host it, edit the existing pool's `machineConfigSelector` to accept the new role value, or create a new pool that selects it. Using `matchExpressions` lets one pool absorb several role values without touching nodes that are already in another pool. The selector lists the accepted role values explicitly, so adding a value is a one-line change:

```yaml
spec:
  machineConfigSelector:
    matchExpressions:
      - key: <role-label-key>
        operator: In
        values:
          - worker
          - worker1
  nodeSelector:
    matchLabels:
      node-role.kubernetes.io/worker: ""
```

After the change the pool re-renders to include the previously-orphaned configuration object, the render controller's error stops, and the operator returns to `Available`.

Two practices help avoid the recurrence:

- Manage configuration objects through a templating layer (Kustomize, Helm, GitOps controller) so the role label is parameterised and can't drift between objects in the same pool.
- Run a CI check on every node-configuration PR that asserts every object's role label is selectable by at least one pool. Catching it before merge is much cheaper than catching it through an operator degraded condition in production.

## Diagnostic Steps

Read the render controller log; the error message embeds both the offending object name and the labels it carries:

```bash
kubectl -n <node-config-namespace> logs \
  deployment/machine-config-controller \
  -c machine-config-controller \
  | grep -i 'error finding pools for machineconfig' \
  | awk '{print $18,"\t",$21}' | sort -u
```

Compare those labels against every pool's `machineConfigSelector`:

```bash
kubectl get machineconfigpool -o json \
  | jq -r '.items[] |
      "pool=\(.metadata.name)
       selector=\(.spec.machineConfigSelector.matchLabels)
       node=\(.spec.nodeSelector.matchLabels)"'
```

Any role value that appears in a configuration object's labels but in no pool's selector is the orphan. Cross-check by listing configuration objects with the offending role:

```bash
kubectl get machineconfig \
  -l <role-label-key>=<role-value> \
  -o name
```

If no pool exists for the role, decide whether to create one or to relabel the configuration object. Once either side is corrected, re-read the render controller log to confirm the error no longer appears in fresh entries and watch the operator status:

```bash
kubectl get clusteroperator machine-config -w
```

The `Degraded=False, Available=True` transition is the signal that the render is healthy again.
