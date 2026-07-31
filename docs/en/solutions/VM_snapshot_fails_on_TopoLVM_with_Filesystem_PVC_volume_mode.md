---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM snapshot fails on TopoLVM with Filesystem PVC volume mode
## Issue

Creating a `VirtualMachineSnapshot` for a VM whose disk lives on a TopoLVM-backed PVC (or any logical-volume-based local storage) fails when the source PVC was created with `volumeMode: Filesystem`. The snapshot object stays in `InProgress` and the underlying `VolumeSnapshotContent` surfaces an `OutOfRange` CSI error that refers to a size mismatch between the requested snapshot size and the source logical volume:

```text
rpc error: code = OutOfRange desc = requested size 2272473088 is smaller
than source logical volume: 2273312768
```

The `VirtualMachineSnapshot` status reflects the same failure on its error field, for example:

```text
NAME                         SOURCEKIND        SOURCENAME   PHASE        READYTOUSE
test-snapshot-filesystem     VirtualMachine    rhel8-amber  InProgress   false
# status.error: Failed to take snapshot of the volume ...:
#   "rpc error: code = OutOfRange desc = requested size 2272473088 is
#    smaller than source logical volume: 2273312768"
```

The snapshot never becomes ready to use, so VM restore-from-snapshot and clone-from-snapshot workflows are blocked for any VM whose disks are provisioned in `Filesystem` mode on top of LVM-backed storage.

## Root Cause

When `volumeMode: Filesystem` is used, KubeVirt's CDI layer and the LVM CSI driver round the logical volume size up to the physical-extent boundary, and a filesystem is laid on top of that rounded volume. The snapshot API then asks the CSI driver to create a snapshot whose size matches the Kubernetes `PersistentVolumeClaim` request. Because the actual LV has already been extended past the request to satisfy the filesystem, the driver receives a snapshot-size request that is smaller than the source LV and refuses with `OutOfRange` — the CSI contract disallows shrinking through a snapshot.

`volumeMode: Block` avoids the issue entirely because KubeVirt exposes the raw logical volume to the VM, and the LV's allocated size stays aligned with the PVC request. Snapshot creation then receives matching sizes and succeeds.

## Resolution

Provision VM disks on TopoLVM (or any LVM-based local storage) with `volumeMode: Block` rather than `volumeMode: Filesystem`. Block mode is the KubeVirt-recommended default for VM disks on any LV-backed `StorageClass` — it also yields better I/O because it skips the guest-exposed host filesystem layer.

For a new VM, reference the backing PVC in `dataVolumeTemplates` or `volumes` with `volumeMode: Block`:

```yaml
apiVersion: cdi.kubevirt.io/v1beta1
kind: DataVolume
metadata:
  name: my-vm-root
spec:
  source:
    registry:
      url: "docker://<image-ref>"
  storage:
    resources:
      requests:
        storage: 30Gi
    storageClassName: topolvm-provisioner
    volumeMode: Block
    accessModes:
      - ReadWriteOnce
```

For an existing VM whose disk is already on a `Filesystem` PVC, the PVC's `volumeMode` is immutable — the volume has to be rebuilt. The safe path is:

1. Stop the VM.
2. Create a new DataVolume in `volumeMode: Block` on the same TopoLVM `StorageClass`, using the existing PVC as the clone source:

   ```yaml
   apiVersion: cdi.kubevirt.io/v1beta1
   kind: DataVolume
   metadata:
     name: my-vm-root-block
   spec:
     source:
       pvc:
         name: my-vm-root
         namespace: <vm-namespace>
     storage:
       resources:
         requests:
           storage: 30Gi
       storageClassName: topolvm-provisioner
       volumeMode: Block
       accessModes:
         - ReadWriteOnce
   ```

3. Swap the VM's disk reference from the old PVC to the new one and start the VM.
4. Retake the snapshot — it now succeeds because source and request sizes align.

For clusters where Block mode is not an option for the workload, the only mitigation is to place those VM disks on a `StorageClass` that does not sit on top of LVM (for example a Ceph-backed or external CSI driver that rounds sizes differently). Do not rely on Filesystem-mode VM disks on LVM storage for any workflow that depends on snapshots.

## Diagnostic Steps

1. Identify the failing snapshot and the exact CSI error:

   ```bash
   kubectl -n <namespace> get virtualmachinesnapshot
   kubectl -n <namespace> get virtualmachinesnapshot <name> \
     -o jsonpath='{.status.error.message}{"\n"}'
   kubectl -n <namespace> get volumesnapshot
   ```

2. Confirm the source PVC is in `Filesystem` mode on an LV-backed `StorageClass`:

   ```bash
   kubectl -n <namespace> get pvc <vm-disk-pvc> \
     -o jsonpath='{.spec.volumeMode}{"\t"}{.spec.storageClassName}{"\n"}'
   ```

   If the output is `Filesystem` and the `StorageClass` uses the TopoLVM / LVM CSI driver, the symptom matches this root cause.

3. Inspect the LVM CSI node plugin logs to see the rounding decision the driver made on the source volume:

   ```bash
   kubectl -n <topolvm-namespace> logs ds/topolvm-node \
     --tail=200 | grep -i "snapshot\|OutOfRange"
   ```

4. After rebuilding the disk in Block mode, retry the snapshot and verify it reaches `readyToUse: true`:

   ```bash
   kubectl -n <namespace> get virtualmachinesnapshot <name> \
     -o jsonpath='{.status.phase}{"\t"}{.status.readyToUse}{"\n"}'
   ```

   A `Succeeded` phase with `readyToUse: true` confirms the fix. If the error persists, the underlying `StorageClass` or driver versions are not aligned — check the CSI driver version and whether the PVC was created from a previous Filesystem-mode source, because clone lineage can preserve the old allocation.
</content>
</invoke>