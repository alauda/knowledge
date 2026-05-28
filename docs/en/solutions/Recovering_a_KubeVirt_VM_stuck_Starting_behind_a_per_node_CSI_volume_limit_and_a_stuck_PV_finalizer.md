---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500299
---

# Recovering a KubeVirt VM stuck Starting behind a per-node CSI volume limit and a stuck PV finalizer

## Issue

On Alauda Container Platform with KubeVirt (namespace `kubevirt`, Kubernetes `v1.34.5`), a `virtualmachines.kubevirt.io` object can report a `Starting` state while the `virt-launcher-<vm>-<hash>` pod that virt-controller created for it stays in `ContainerCreating` and never reaches `Running`. The launcher pod cannot finish starting when the `persistentvolumeclaims` backing the VM disk cannot be attached to the node where the pod is scheduled, because the pod's disk mount depends on that volume attachment completing first.

## Root Cause

A CSI driver advertises a per-node maximum attachable volume count through the `csinodes.storage.k8s.io` object's `.spec.drivers[].allocatable.count` field (an integer, beta in `storage.k8s.io/v1`); when that field is set it caps how many unique volumes the driver may use on a single node, and when it is left unspecified the number of supported volumes on the node is unbounded. ACP's default `topolvm` CSI driver leaves `allocatable.count` unset, so it imposes no per-node attach limit by itself; the per-node limit is a generic CSI mechanism that takes effect only when a CSI driver in use populates the field.

A second factor compounds the stuck state through storage finalizers. A `persistentvolumes` (core/v1) object marked for deletion can carry a `deletionTimestamp` while still retaining the `kubernetes.io/pv-protection` finalizer in its `metadata.finalizers` list; the object is not deleted from the registry until that finalizer list is empty, so a non-nil `deletionTimestamp` alone does not remove it. The `kubernetes.io/pv-protection` finalizer is present on every live PV (alongside the external-provisioner finalizer) and keeps the PV — and its bound PVC — from being garbage-collected while a pod still references the storage. The bound `persistentvolumeclaims` carry the corresponding `kubernetes.io/pvc-protection` finalizer, so deleting such a PVC leaves it in `Bound` status with a `deletionTimestamp` set until its in-use condition is cleared.

## Diagnostic Steps

Confirm the VM is `Starting` and its launcher pod is wedged in `ContainerCreating` in the `kubevirt` namespace:

```bash
kubectl get vm,vmi -A
kubectl get pod -n <vm-namespace> -l kubevirt.io=virt-launcher -o wide
```

Inspect the stuck PV to reveal a lingering pv-protection finalizer: `kubectl get pv <name> -o yaml` exposes the PV's `deletionTimestamp` and `finalizers` list, which together show whether the object is held open by `kubernetes.io/pv-protection`:

```bash
kubectl get pv <name> -o yaml
kubectl get pv <name> -o jsonpath='{.metadata.deletionTimestamp}{"\n"}{..finalizers}{"\n"}'
```

Check the bound PVC the same way; a PVC showing `Bound` together with a `deletionTimestamp` is being held by the `kubernetes.io/pvc-protection` finalizer until its in-use reference is cleared:

```bash
kubectl get pvc <name> -n <vm-namespace> -o yaml
```

Inspect the `csinodes.storage.k8s.io` object for the node to see whether the driver in use advertises a per-node attach limit; an empty `.spec.drivers[].allocatable.count` means that driver imposes no limit on the node:

```bash
kubectl get csinode <node-name> -o jsonpath='{.spec.drivers[*].allocatable.count}{"\n"}'
```

## Resolution

Force-delete the unresponsive `virt-launcher-<vm>-<hash>` pod to release the volume locks it held; `kubectl delete pod --force --grace-period=0` is a generic core/v1 operation, and because the launcher pods are owned by virt-controller they are recreated after the force-delete:

```bash
kubectl delete pod virt-launcher-<vm>-<hash> -n <vm-namespace> --force --grace-period=0
```

Once node capacity is available, provision a healthy replacement volume by cloning or restoring a snapshot so the VM can transition to `Running` with a correctly `Bound` PVC. ACP's KubeVirt provides the `virtualmachinesnapshots` and `virtualmachinerestores` primitives along with CDI `volumeclonesources` for this purpose:

```yaml
apiVersion: snapshot.kubevirt.io/v1beta1
kind: VirtualMachineRestore
metadata:
  name: <vm>-restore
  namespace: <vm-namespace>
spec:
  target:
    apiGroup: kubevirt.io
    kind: VirtualMachine
    name: <vm>
  virtualMachineSnapshotName: <vm>-snapshot
```

After the replacement PVC reaches `Bound` and any held finalizer has cleared, the VM resumes its normal lifecycle: the recreated `virt-launcher-<vm>-<hash>` pod attaches the disk and proceeds past `ContainerCreating` toward `Running`.
