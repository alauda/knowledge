---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500033
---

# Pod Pending: `didn't find available persistent volumes to bind` — Local PVs Pin to a Specific Node

## Issue

A pod (typically a StatefulSet member — Prometheus, database, queue broker) stays Pending. `kubectl describe pod` shows the scheduler found **no** node where both a matching local PV and the pod's own node affinity can coexist:

```text
0/6 nodes are available:
  3 node(s) didn't find available persistent volumes to bind,
  3 node(s) didn't match Pod's node affinity/selector.
preemption: 0/6 nodes are available: 6 Preemption is not helpful for scheduling.
```

The message is unusually clear about the intersection failure: three nodes carry local PVs but fail the pod's nodeSelector, and the other three nodes satisfy the nodeSelector but have no matching local PV. The scheduler has no candidate that satisfies both constraints simultaneously, so the pod never lands.

## Root Cause

Local PVs created by the Local Storage Operator (or any equivalent tool that provisions PVs from a node's attached disks) carry a `nodeAffinity` field that hard-pins the PV to the specific node whose disk it was cut from:

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: local-pv-abcd
spec:
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values: [node-3]
```

That affinity is a hard constraint: the PV can only be consumed by a pod that runs on the named node. The PV cannot "migrate" to another node in any meaningful sense — the disk it represents is physically attached to one machine.

When a pod's template carries its own `nodeSelector` (or `affinity` stanza) that narrows the pod to a *different* set of nodes — for example, a monitoring pod that expects to run on the control plane, while the local PVs were carved out of worker disks — the intersection of the two constraints is empty. The scheduler truthfully reports "no node satisfies both" and the pod stays Pending.

Neither constraint can be relaxed without consequences: dropping the PV's nodeAffinity would allow the pod to try to mount a disk that isn't there, and dropping the pod's nodeSelector might land the pod on a node that lacks the unrelated requirements the selector was meant to enforce.

## Resolution

Align the pod's scheduling constraints with the nodes that own the local PVs.

### Step 1 — enumerate which nodes hold the local PVs the pod expects

```bash
# List the bound PVs and their hostname affinity.
kubectl get pv -o json | \
  jq -r '.items[]
         | select(.spec.nodeAffinity != null) |
         (.spec.nodeAffinity.required.nodeSelectorTerms[0]
            .matchExpressions[] |
          select(.key == "kubernetes.io/hostname") |
          .values[]) as $host |
         "\(.metadata.name)\t\(.status.phase)\t\($host)\t\(.spec.storageClassName)"'
```

Output:

```text
local-pv-abcd   Available   node-3   local-block
local-pv-efgh   Available   node-4   local-block
local-pv-ijkl   Available   node-5   local-block
```

The PVs that the pod's PVC could bind to are the rows whose `storageClassName` matches the PVC's storage class. Note their `hostname` values — those are the nodes the pod **must** be able to land on.

### Step 2 — inspect the pod's current scheduling constraints

```bash
kubectl -n <ns> get deployment <name> -o jsonpath='{.spec.template.spec.affinity}{"\n"}' | jq
kubectl -n <ns> get deployment <name> -o jsonpath='{.spec.template.spec.nodeSelector}{"\n"}' | jq
```

Identify whatever `nodeSelector` or `affinity` is narrowing the pod to nodes that do not include the PV-owning ones.

### Step 3 — update the pod's template to permit the PV-owning nodes

Two shapes, pick the one closer to the intent:

**If the pod's nodeSelector is incidental** (e.g. a label was copied from another workload without thought), remove it. The scheduler will then freely place the pod wherever both the node-affinity of the PV and normal constraints allow:

```yaml
# Before
spec:
  template:
    spec:
      nodeSelector:
        node-role.kubernetes.io/infra: ""

# After (nodeSelector removed)
spec:
  template:
    spec:
      # Let the PVC's PV-level nodeAffinity drive placement.
      # The scheduler will place this pod on whichever node has the local PV.
```

**If the pod's nodeSelector is intentional** (e.g. the pod really should run on a specific subset of nodes), **provision local PVs on those nodes instead**. Either extend the Local Storage Operator's `LocalVolumeSet` / equivalent CR to include the intended-placement nodes, or schedule the workload such that the PV-owning nodes are included in the selector:

```yaml
# LocalVolumeSet with a broader nodeSelector.
apiVersion: local.storage.alauda.io/v1alpha1
kind: LocalVolumeSet
metadata:
  name: local-block-osds
spec:
  nodeSelector:
    nodeSelectorTerms:
      - matchExpressions:
          - key: node-role.kubernetes.io/infra
            operator: Exists
  # ... filters ...
```

Then wait for new PVs to provision on the `infra` nodes before re-deploying the pod.

### Step 4 — watch the pod schedule

After aligning the constraints, trigger a new pod attempt (rollout restart, or simply delete the pending pod so the controller recreates it):

```bash
kubectl -n <ns> rollout restart deployment/<name>
# or
kubectl -n <ns> delete pod -l <selector>
```

Monitor:

```bash
kubectl -n <ns> get pod -l <selector> -w
```

The pod should transition to `Running` within a scheduling cycle. Verify the bound PV:

```bash
kubectl -n <ns> get pvc <pvc-name> -o jsonpath='{.spec.volumeName}{"\n"}'
```

The returned PV name should be one from the list in Step 1.

## Diagnostic Steps

Confirm the specific failure pattern. The telling part is the scheduler's two-clause explanation:

```bash
kubectl get events -n <pod-ns> --field-selector reason=FailedScheduling | \
  grep "didn't find available persistent volumes to bind"
```

Finding this message with the complementary `didn't match Pod's node affinity/selector` in the same line is the exact signature — if the messages differ (e.g. "didn't have free ports", "exceeded quota"), the issue is different.

Cross-check the PVC's binding state:

```bash
kubectl -n <pod-ns> get pvc
```

A PVC in `Pending` state that should have been bound to a local PV is the downstream symptom. The events on the PVC itself will repeat the scheduler's complaint:

```bash
kubectl -n <pod-ns> describe pvc <pvc-name>
```

List candidate PVs that could satisfy the PVC (matching storage class, available, capacity large enough):

```bash
PVC_SC=<pvc-storage-class>
PVC_SIZE_GIB=<pvc-requested-gib>
kubectl get pv -o json | \
  jq -r --arg sc "$PVC_SC" '.items[]
         | select(.spec.storageClassName == $sc)
         | select(.status.phase == "Available")
         | "\(.metadata.name)  \(.spec.capacity.storage)  \(.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[])"'
```

If no PV shows up, the issue is not scheduling but provisioning — the Local Storage Operator has not carved enough PVs. If PVs show up on nodes that the pod's template forbids, the fix is Step 3 above.

After the fix, the PVC transitions to `Bound`, the pod to `Running`, and no further `FailedScheduling` events should accrue.
