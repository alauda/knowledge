---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500196
---

# Resize an ACP virtualization VM disk in place by expanding its backing PVC

## Issue

On Alauda Container Platform with the virtualization bundle installed (CSV `kubevirt-hyperconverged-operator.v4.3.5` in the `kubevirt` namespace, `HyperConverged` singleton `kubevirt-hyperconverged` and `CDI` singleton `cdi-kubevirt-hyperconverged` both reconciled), every persistent VM disk on a `VirtualMachine` resolves to a `PersistentVolumeClaim` — either referenced directly through `spec.template.spec.volumes[].persistentVolumeClaim.claimName`, or indirectly through `spec.template.spec.volumes[].dataVolume.name`, in which case CDI materializes the named `DataVolume` (`cdi.kubevirt.io/v1beta1`) into a PVC of the same name. Growing the guest-visible size of a VM disk therefore reduces to growing the storage request on that backing PVC.

The `virt-plus` deployment in the `kubevirt` namespace (image `build-harbor.alauda.cn/acp/kubevirt/virt-plus:v4.3.5`, owned by the same HCO CSV) provides the web UI surface for VM management on this cluster. When the disk-size field on the disk-edit form does not persist the change to the same PVC the VM disk already references, the supported way to grow the disk in place is to patch the underlying PVC directly with `kubectl` and bypass the UI form entirely.

## Root Cause

In-place expansion of a bound PVC is a generic Kubernetes capability and only takes effect when the bound `StorageClass` carries `allowVolumeExpansion: true`. On this cluster the default StorageClass is `topolvm-hdd` (provisioner `topolvm.cybozu.com`, `ALLOWVOLUMEEXPANSION=true`), which satisfies that precondition, so editing the PVC's `spec.resources.requests.storage` upward is honored by the CSI driver and the new size is propagated to the guest disk without recreating the PVC.

## Resolution

Identify the PVC that backs the VM disk, then raise its storage request directly. Because the VM disk reference inside `VirtualMachine.spec.template.spec.volumes[]` already names this PVC (either via `persistentVolumeClaim.claimName` or via a `dataVolume.name` that CDI materialized into a same-named PVC), an in-place expansion against that PVC keeps the existing reference intact and the VM continues to consume the same backing storage at the new size.

Read the disk-to-PVC mapping from the VM spec:

```bash
kubectl get virtualmachine -n <vm-namespace> <vm-name> \
  -o jsonpath='{.spec.template.spec.volumes[*]}{"\n"}'
```

Confirm the PVC exists, is `Bound`, and uses a StorageClass that allows expansion (`topolvm-hdd` is the default on this cluster and qualifies):

```bash
kubectl get pvc -n <vm-namespace> <pvc-name>
kubectl get sc topolvm-hdd \
  -o jsonpath='{.allowVolumeExpansion}{"\n"}'
```

Patch the PVC's storage request upward to the desired size:

```bash
kubectl patch pvc -n <vm-namespace> <pvc-name> \
  --type merge \
  -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'
```

The CSI driver honors the change because `topolvm-hdd` advertises `allowVolumeExpansion=true`; the PVC's `status.capacity.storage` advances to the new value once the volume has been resized at the storage layer, and the guest sees the larger block device on the existing disk reference rather than a freshly created replica PVC.

## Diagnostic Steps

If the disk size has not grown after a patch, verify the StorageClass-level precondition first. Only `StorageClass` objects with `allowVolumeExpansion: true` honor an in-place PVC `spec.resources.requests.storage` increase; on this cluster the default class `topolvm-hdd` (provisioner `topolvm.cybozu.com`) is the one that satisfies it, so a PVC bound to a different class without that flag will silently leave the request unsatisfied:

```bash
kubectl get sc
kubectl get pvc -n <vm-namespace> <pvc-name> \
  -o jsonpath='{.spec.storageClassName}{"\n"}'
```

Confirm that the VM disk reference still points at the same PVC after the patch — the workaround's whole point is that the existing `VirtualMachine.spec.template.spec.volumes[]` entry (either `persistentVolumeClaim.claimName` or `dataVolume.name`) is left untouched and continues to bind the same backing storage, now at the larger size:

```bash
kubectl get virtualmachine -n <vm-namespace> <vm-name> \
  -o jsonpath='{.spec.template.spec.volumes[*]}{"\n"}'
kubectl get pvc -n <vm-namespace> <pvc-name> \
  -o jsonpath='{.status.capacity.storage}{"\n"}'
```
