---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

An operator wants to trigger a live migration of a running virtual machine and, as part of that migration, force the VM to land on a specific destination node — for example to drain a failing host, to consolidate workloads onto a smaller node set before a maintenance window, or to put a latency-sensitive workload next to a specific accelerator. The ACP virtualization stack (`docs/en/virtualization/`, KubeVirt-based) does not expose a first-class "target node" field on the `VirtualMachineInstanceMigration` object: the scheduler picks any node that satisfies the VM's constraints, which may or may not be the node the operator had in mind.

## Root Cause

Live migration in KubeVirt is implemented as a scheduler-driven placement: when a `VirtualMachineInstanceMigration` (VMIM) is created, the control plane starts a new `virt-launcher` pod for the VM, the scheduler picks a node for that pod according to the VM's `spec.template.spec.nodeSelector`, affinity rules, tolerations, and cluster-wide constraints, and then KubeVirt performs the memory/state handoff. There is deliberately no "pin me to node X for this single migration" API on the VMIM object itself — letting a user bypass the scheduler at migration time would break eviction semantics and drain protection.

Newer KubeVirt (and the corresponding virtualization stack versions) expose targeted-destination-node selection as a first-class feature. On the versions shipped with older deployments that feature is not yet available, which means the only way to influence the destination is through the same scheduler inputs the VM already uses — namely `nodeSelector` or affinity on the VM template.

## Resolution

Force the desired destination by temporarily constraining the VM's scheduler inputs so the only node that can host the next launcher pod is the intended target, trigger the migration, then restore the original scheduling surface once the VM has landed.

### 1. Record the current VM scheduling hints

```bash
NS=<vm-namespace>
VM=<vm-name>

kubectl -n $NS get vm $VM \
  -o jsonpath='{.spec.template.spec.nodeSelector}{"\n"}{.spec.template.spec.affinity}{"\n"}'
```

Copy the output somewhere you can restore from — the edit below will overwrite it.

### 2. Pin the target node on the VM template

Patch the VM to set `nodeSelector` (or a more precise `requiredDuringSchedulingIgnoredDuringExecution` affinity) to a label that only the target node carries. The Kubernetes-managed `kubernetes.io/hostname` label is present on every node and is usually the simplest handle:

```bash
TARGET_NODE=<destination-node-name>

kubectl -n $NS patch vm $VM --type=merge -p "$(cat <<EOF
{
  "spec": {
    "template": {
      "spec": {
        "nodeSelector": {
          "kubernetes.io/hostname": "${TARGET_NODE}"
        }
      }
    }
  }
}
EOF
)"
```

Setting this on `spec.template.spec.nodeSelector` (as opposed to `spec.template.metadata` or anywhere else) is load-bearing — the VMI inherits that field and the next launcher pod created for migration uses it.

### 3. Trigger the live migration

Create a `VirtualMachineInstanceMigration` for the VM:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstanceMigration
metadata:
  generateName: migrate-to-target-
  namespace: <vm-namespace>
spec:
  vmiName: <vmi-name>   # usually identical to the VM name
```

```bash
kubectl apply -f migration.yaml
kubectl -n $NS get vmim -w
```

The scheduler evaluates the new launcher pod against the newly-added `nodeSelector` and places it on the target node; KubeVirt then performs the memory handoff as usual.

### 4. Restore the original scheduling surface once migration completes

As soon as the VMIM phase reaches `Succeeded` and `kubectl get vmi -n $NS $VM -o jsonpath='{.status.nodeName}'` returns the target node, clear the pin so future scheduling decisions are not locked to that one node:

```bash
kubectl -n $NS patch vm $VM --type=json -p '[
  {"op": "remove", "path": "/spec/template/spec/nodeSelector/kubernetes.io~1hostname"}
]'
```

If the original `nodeSelector` had other entries, re-apply those from the value you captured in step 1. Leaving the hostname pin in place is dangerous: a subsequent reschedule (e.g. node reboot) would find no other candidate and the VM would stay pending.

### Caveats

- The target node must satisfy **all** the VM's other constraints — CPU / memory capacity, any existing affinity / anti-affinity, PVC topology, accelerator device plugins, etc. If not, the launcher pod stays `Pending` and the VMIM eventually fails. Pre-check with `kubectl describe node <target>` and run a dry-run placement if the cluster has the admission hooks for it.
- This workaround changes the VM spec (and therefore its generation). If GitOps reconciles the VM, the pin may be undone between step 2 and step 3 unless the change is applied through the GitOps source of truth or the reconciler is paused for the duration.
- On newer virtualization stack versions that expose a first-class destination-node field on the VMIM, prefer that API instead — it avoids mutating the VM spec and is robust to GitOps drift.

## Diagnostic Steps

1. Confirm the patch landed on the VM template and not somewhere else:

   ```bash
   kubectl -n $NS get vm $VM \
     -o jsonpath='{.spec.template.spec.nodeSelector}{"\n"}'
   ```

2. Watch the newly-created launcher pod being scheduled during the migration:

   ```bash
   kubectl -n $NS get pods -l kubevirt.io=virt-launcher,vm.kubevirt.io/name=$VM \
     -o wide -w
   ```

   During migration, two launcher pods are briefly visible — the original (on the source node) and the new one (expected to appear on the target node). Once the handoff completes, the source pod terminates.

3. If the new launcher pod stays `Pending`, describe it and confirm the reason is scheduling, not image pull or PVC binding:

   ```bash
   POD=$(kubectl -n $NS get pods -l vm.kubevirt.io/name=$VM \
     --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1].metadata.name}')
   kubectl -n $NS describe pod $POD | sed -n '/Events/,$p'
   ```

   A `FailedScheduling` event naming the pinned hostname is expected only if the target node is tainted, full, or labelled out of consideration — resolve whichever of those the message points at.

4. After the migration, verify the VMI is actually on the target node and that the pin has been removed from the VM:

   ```bash
   kubectl -n $NS get vmi $VM -o jsonpath='{.status.nodeName}{"\n"}'
   kubectl -n $NS get vm $VM -o jsonpath='{.spec.template.spec.nodeSelector}{"\n"}'
   ```

   The first command should show `<destination-node-name>`. The second should show whatever the original `nodeSelector` was (or an empty map) — not the pinned value.
