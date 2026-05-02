---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# vTPM/EFI persistent-state PVC stays on the source storage during VM storage migration
## Issue

A VM is migrated from one storage backend to another using the storage-migration flow. The main disks (root, data) move to the new StorageClass as expected, but a small (~10 MiB) PVC named like `persistent-state-for-<vm>` is left behind on the source storage. The migration reports success even though that one volume did not move.

`kubectl get pvc -n <ns>` shows the main disks bound on the new StorageClass and the `persistent-state-for-<vm>` PVC still bound on the old one.

## Root Cause

`persistent-state-for-<vm>` is the PVC the virtualization stack creates automatically when a VM has a persistent vTPM device or persistent EFI/NVRAM. Its job is to hold the small amount of state that has to survive across reboots — vTPM key blobs, NVRAM variables — separately from the OS disk.

The StorageClass for that PVC is **not** taken from the VM's other disks. It is taken from a single cluster-wide field, `vmStateStorageClass`, on the cluster-level virtualization configuration CR. Because the StorageClass is selected globally and not from the VM spec, the storage-migration controller has nothing per-VM to rewrite — the PVC's StorageClass is, from its point of view, an unrelated cluster setting. So it migrates everything that *is* per-VM and leaves `persistent-state-for-*` where it was.

This is by design today; per-VM migration of vTPM/EFI state is tracked as a future enhancement.

## Resolution

There is no per-VM migration path for the persistent-state PVC at the moment. Pick the workaround that matches the goal.

### Goal: every *new* VM lands its persistent state on the new StorageClass

Update the cluster virtualization CR so future VMs use the new class. Find the CR (its exact kind/name depends on which virtualization operator is installed; the field name is the same):

```bash
kubectl get hyperconverged -A
# or:
kubectl get kubevirt -A
```

Then patch `vmStateStorageClass`:

```bash
kubectl -n <virt-namespace> patch <kind>/<name> --type=merge -p '
spec:
  vmStateStorageClass: <new-storage-class>
'
```

After the patch, every newly-created VM that enables persistent vTPM or persistent EFI will provision its `persistent-state-for-<vm>` PVC on `<new-storage-class>`. Existing PVCs are not touched.

### Goal: an *existing* VM's persistent state ends up on the new StorageClass

Two-step migration — disks first, then a compute-side migration that recreates the VM:

1. Run the storage migration of the VM's data disks to the new StorageClass as usual.
2. After the global `vmStateStorageClass` has been flipped, recreate the VM (delete and re-add via the same VirtualMachine manifest, or rebuild the VM from a snapshot/template). On re-creation the persistent-state PVC is provisioned fresh against the new `vmStateStorageClass`. The vTPM blob/NVRAM is regenerated; treat this as a TPM ownership change for any guest that depends on TPM-sealed secrets (BitLocker keys, sealed credentials), and have the recovery key handy.

If the guest cannot tolerate a TPM/NVRAM reset, leave the persistent-state PVC on the source storage until the per-VM migration capability is shipped — the small footprint (10 MiB per VM) generally does not block decommissioning the rest of the source pool.

## Diagnostic Steps

1. List the PVCs bound to the migrated VM and check their `spec.storageClassName`:

   ```bash
   kubectl get pvc -n <ns> -l kubevirt.io/created-by=<vm-uid> \
     -o custom-columns=NAME:.metadata.name,SC:.spec.storageClassName,SIZE:.status.capacity.storage
   ```

   The expected output looks like:

   ```text
   NAME                                  SC          SIZE
   <vm>-rootdisk                         new-class   60Gi
   <vm>-datadisk                         new-class   100Gi
   persistent-state-for-<vm>             old-class   10Mi
   ```

2. Confirm that VM has a persistent vTPM or persistent EFI device — that is the trigger that creates the persistent-state PVC:

   ```bash
   kubectl get vm <vm> -n <ns> -o yaml \
     | yq '.spec.template.spec.domain.devices, .spec.template.spec.domain.firmware'
   ```

   Look for `tpm: { persistent: true }` or `firmware.bootloader.efi.persistent: true`.

3. Read the current cluster-wide `vmStateStorageClass`:

   ```bash
   kubectl get <kind>/<name> -n <virt-namespace> -o yaml | yq '.spec.vmStateStorageClass'
   ```

   That value is the StorageClass any *new* persistent-state PVC will use.

4. After flipping `vmStateStorageClass`, create a throw-away test VM with a persistent vTPM and verify its `persistent-state-for-*` PVC binds on the new class — that proves the global change took effect before you start delete/recreate cycles on production VMs.
