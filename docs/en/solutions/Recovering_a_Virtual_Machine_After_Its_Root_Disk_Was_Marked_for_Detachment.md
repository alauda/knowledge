---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A user operating ACP Virtualization requested a detach of the primary boot volume (the "root disk") of a running Virtual Machine — most often by accidentally clicking **Detach** on the boot entry in the VM's disk list. Because the root disk's attachment metadata (`AutoDetach`, hotplug classification) cannot be rewritten while the VM is live, the platform accepts the request but parks it in a pending state. The VM therefore:

- Continues to run normally for the moment, with the boot PVC still mounted inside the guest and the backing `PersistentVolumeClaim` still in `Bound`.
- Has a `RestartRequired` condition raised in its status, pointing at the pending root-disk change.
- Would fail to boot on the **next** restart — coming up with `No bootable device found` at the firmware stage, because the pending action would have removed the root volume from the VM spec the cluster uses to rebuild the launcher pod.

This is recoverable as long as the underlying PVC is still `Bound` and was not marked with `Delete PVC` at detach time.

## Root Cause

Inside ACP Virtualization, the boot-disk binding is not a hot-updatable field of the `VirtualMachine` CRD. Two things follow from that:

- Hotplug-class disks can be detached live, but the disk nominated as the VM's boot source cannot; the detach action is stored as a deferred spec change and takes effect only on the next cold boot.
- If a user also selected **Delete PVC** while detaching, the controller treats that as permission to reclaim the storage on the next restart — the PVC is removed and the data is gone.

Because the detach request is legal from the API's point of view but unsafe on this particular disk role, the cluster chooses the conservative path: stage the change, raise `RestartRequired`, and wait for the operator to confirm or cancel before the VM cycles.

## Resolution

### ACP-preferred path: reconcile the VM spec before restart

The goal is to stop the VM, re-declare the root disk on the `VirtualMachine` object so it is marked bootable again, then start the VM. Because the PVC is still `Bound`, guest data is untouched.

1. Confirm the underlying claim is still present and healthy — the recovery only works if the PVC was **not** deleted:

   ```bash
   kubectl -n <ns> get pvc <root-pvc>
   kubectl -n <ns> get vm <vm-name> -o jsonpath='{.status.conditions[?(@.type=="RestartRequired")]}'
   ```

2. Stop the Virtual Machine. This can be done through the virtualization console's **Stop** action, or by setting `runStrategy: Halted` / `running: false`:

   ```bash
   kubectl -n <ns> patch vm <vm-name> --type merge -p '{"spec":{"running":false}}'
   ```

   Wait for the `VirtualMachineInstance` (VMI) to disappear before editing the VM spec.

3. Re-declare the root disk as a bootable volume on the `VirtualMachine`. The volume entry points back at the same PVC; the disk entry reapplies `bootOrder: 1`:

   ```yaml
   spec:
     template:
       spec:
         domain:
           devices:
             disks:
               - name: rootdisk
                 bootOrder: 1
                 disk:
                   bus: virtio
         volumes:
           - name: rootdisk
             persistentVolumeClaim:
               claimName: <root-pvc>
   ```

   Apply the edit:

   ```bash
   kubectl -n <ns> edit vm <vm-name>
   ```

4. Clear the `RestartRequired` condition by restarting the VM:

   ```bash
   kubectl -n <ns> patch vm <vm-name> --type merge -p '{"spec":{"running":true}}'
   kubectl -n <ns> get vmi <vm-name> -w
   ```

5. Once the VMI is `Running`, confirm the guest has booted past firmware and the `RestartRequired` status has cleared:

   ```bash
   kubectl -n <ns> get vm <vm-name> -o jsonpath='{.status.conditions}'
   ```

### OSS fallback: the same flow on upstream KubeVirt

On a cluster running stock KubeVirt (no ACP wrapper), the CRDs and fields are identical — `kubevirt.io/v1/VirtualMachine`, `VirtualMachineInstance`, `disks[].bootOrder`, and the `RestartRequired` status condition all behave the same. The only difference is which console or CLI presents the **Detach** button; the underlying repair path is the spec-edit shown above.

Operational notes that apply to both paths:

- If the detach request was made with **Delete PVC** selected, do **not** restart the VM. Remove that flag (patch `.spec.template.spec.volumes[]` to reference the existing PVC and clear any `deleteOnRestart`-style annotation applied by the console) before bringing the VM back up, otherwise the claim will be reclaimed on boot.
- Taking a snapshot of the boot PVC (`VolumeSnapshot` of the same `StorageClass`) before editing the spec gives you a rollback point in case the recovery edit itself is mis-typed.

## Diagnostic Steps

- Inspect the current launcher pod to see how the root disk is actually wired into the running VM. The `volumes:` stanza still references the PVC, confirming the data is untouched:

  ```bash
  kubectl -n <ns> get pod virt-launcher-<vm-name>-<hash> -o yaml | sed -n '/volumes:/,$p'
  ```

- Verify the `PersistentVolumeClaim` is `Bound` and not marked for deletion. A PVC in `Terminating` means the detach action already reclaimed it and the data is gone:

  ```bash
  kubectl -n <ns> get pvc <root-pvc> -o jsonpath='{.status.phase} {.metadata.deletionTimestamp}'
  ```

- Read the `RestartRequired` condition to learn **why** the change was staged. The condition's `message` field spells out the pending field name — useful if more than one deferred change is queued:

  ```bash
  kubectl -n <ns> get vm <vm-name> -o yaml | sed -n '/conditions:/,/status:/p'
  ```

- If the VM has already been restarted and failed with `No bootable device found`, check whether the boot PVC survived. If yes, proceed with the resolution above — you are simply applying the repair after the bad boot. If the PVC is gone, data recovery has to come from storage-layer snapshots or backups, not from this path.
