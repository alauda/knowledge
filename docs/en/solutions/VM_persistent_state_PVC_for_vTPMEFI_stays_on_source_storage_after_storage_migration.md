---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM persistent-state PVC for vTPM/EFI stays on source storage after storage migration

## Issue

On Alauda Container Platform KubeVirt virtualization (HCO operator 1.17.0, KubeVirt v1.7.0-alauda.2, namespace `kubevirt`), a VirtualMachine that enables persistent virtual TPM or persistent EFI/NVRAM gets a small dedicated PersistentVolumeClaim that backs that device state. When the VM's storage is migrated from one backend to another, the VM's main disk PVCs are moved to the new storage class. The small `persistent-state-for-<vm>` PVC, however, remains on the source storage class and is not moved together with the main disks.

## Root Cause

KubeVirt creates the `persistent-state-for-<vm>` PVC to hold a VirtualMachine's vTPM or EFI/NVRAM state, and it does so only when the VM opts in — both `devices.tpm.persistent` and `firmware.bootloader.efi.persistent` default to `false`, so the PVC exists only for VMs that turn on persistent TPM or persistent EFI. The storage class of that state PVC is not derived from the storage class of the VM's other disks. Instead it is governed by a single cluster-wide field, `spec.vmStateStorageClass` on the `hyperconvergeds.hco.kubevirt.io` (group `hco.kubevirt.io/v1beta1`) singleton, described as the storage class used for the PVCs created to preserve VM state such as TPM.

Because that field is a global string on the cluster-wide HyperConverged CR rather than a per-VM setting, a per-VM storage migration that moves a VM's main disks has no scope over the state PVC, leaving it on the source storage class. ACP ships KubeVirt-native VM storage migration through the `virtualmachinestoragemigrations` API (group `migrations.kubevirt.io/v1alpha1`), reconciled by the `migcontroller-kubevirt-hyperconverged` controller running in the `kubevirt` namespace; a migration plan targets a list of virtual machines and migrates their disks, and it carries no field for the cluster-wide VM-state PVC.

## Resolution

There is no direct way to migrate an existing `persistent-state-for-<vm>` PVC for a single VM — the storage-migration plan scope covers main disks, not the state PVC. Changing `spec.vmStateStorageClass` is a cluster-global change that affects all VMs and does not migrate existing persistent-state PVCs.

To place future VM-state PVCs on a chosen storage class, set `spec.vmStateStorageClass` on the HyperConverged singleton in the `kubevirt` namespace. Newly created VMs that enable persistent TPM or persistent EFI then get their persistent-state PVC on that storage class:

```bash
kubectl patch hyperconverged -n kubevirt kubevirt-hyperconverged \
 --type merge \
 -p '{"spec":{"vmStateStorageClass":"<target-storage-class>"}}'
```

This setting governs only PVCs created after the change; PVCs that already exist are left in place on their current storage class. For a VM whose state PVC must end up on a different backend, recreate the VM's persistent-state PVC under the desired storage class rather than expecting the disk migration to move it.

## Diagnostic Steps

List the VM's PVCs and compare their storage classes after a storage migration. The main disk PVCs appear on the new storage class while the `persistent-state-for-<vm>` PVC remains on the old storage class:

```bash
kubectl get pvc -n <namespace>
```

Confirm the cluster-wide setting that governs new VM-state PVCs by reading the HyperConverged singleton; an empty value means new VM-state PVCs fall back to the cluster default storage class:

```bash
kubectl get hyperconverged -n kubevirt kubevirt-hyperconverged \
 -o jsonpath='{.spec.vmStateStorageClass}'
```
