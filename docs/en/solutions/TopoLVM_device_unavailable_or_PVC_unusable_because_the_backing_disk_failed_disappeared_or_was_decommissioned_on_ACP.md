---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# TopoLVM device unavailable or PVC unusable because the backing disk failed, disappeared, or was decommissioned on ACP

## Issue

On **Storage Management > Local Storage > topolvm > Storage Devices** a TopoLVM device (for example `/dev/sdc`) is listed as unavailable (`不可用`, "Unavailable"), and one of the following is reported:

- After the servers were powered off and on again, TopoLVM on a node does not start, and the workloads whose PVCs live on that node (for example a registry or a Git service) do not start either.
- A disk on a TopoLVM node is damaged, and a PVC on it can no longer be recognized or mounted. The question is whether rebuilding the PVC helps.
- `discover-device` fails with `failed to list all devices: exit status 127` on some nodes, although `lsblk`, `blkid`, and the `lvm2` packages are installed.
- A disk that TopoLVM used has been taken offline for good, and its entries still show in TopoLVM.

TopoLVM volumes are LVM logical volumes on the node's own disk. When that disk is gone, the logical volumes on it are gone too; TopoLVM does not keep a second copy. Recovering the data means restoring it from the application's own backup or replica.

Operands run in `nativestor-system`; the cluster object is `topolvmclusters.topolvm.cybozu.com/topolvm`; the per-node lvmd settings are ConfigMap `lvmdconfig-<node>`.

Related articles: [TopoLVM does not offer a disk or topolvm-prepare-vg fails to create the volume group on ACP](./TopoLVM_does_not_offer_a_disk_or_topolvm-prepare-vg_fails_to_create_the_volume_group_on_ACP.md) (the disk is present but still carries old signatures, or a new disk has to be added), [TopoLVM lvmd exits with should have at least one device-class or Error: not found on ACP](./TopoLVM_lvmd_exits_with_should_have_at_least_one_device-class_or_Error_not_found_on_ACP.md) (the disk is present but the volume group named in `lvmd.yaml` is missing or named differently), [TopoLVM device class or storage devices show Unavailable or Unknown on ACP](./TopoLVM_device_class_or_storage_devices_show_Unavailable_or_Unknown_on_ACP.md).

## Root Cause

### Cause 1: the device is unavailable after a power cycle and lsblk no longer lists the disk

`lsblk` on the node lists the other disks (the operating-system disk and its partitions) but not the disk that the TopoLVM device names. The disk dropped off the node after the power cycle, so the device class on that node has no volume group, TopoLVM on that node does not start, and the pods whose PVCs live there stay down. This is a hardware or virtualization-layer fault of the disk, and the disk may have to be replaced.

### Cause 2: a damaged disk leaves a PVC on it unusable

A disk on a TopoLVM node is damaged, and the PV and PVC on it can no longer be recognized or mounted. Rebuilding the PVC creates a new, empty volume; it does not recover what was on the damaged disk.

### Cause 3: discover fails with exit status 127 and the GPT main header of the disk is corrupted

`discover-device` logs `failed to list all devices: exit status 127` on some nodes while the device tools are installed, and `topolvm-controller` repeats `probe failed` with `csidrivers.storage.k8s.io "topolvm.cybozu.com" not found`. A GPT check of a disk on those nodes reports a damaged primary partition table:

```text
Invalid CRC on main header data; loaded backup partition table.
Main and backup partition tables differ!
One or more CRCs don't match. You should repair the disk!
Main header: ERROR
Backup header: OK
Main partition table: ERROR
Backup partition table: OK
Invalid partition data!
```

The failure was resolved by repairing that disk and rebuilding TopoLVM. The same `exit status 127` is also the signature of a CPU without `x86-64-v2` support, see [TopoLVM operator or discover-device crashes with CPU does not support x86-64-v2 on ACP](./TopoLVM_operator_or_discover-device_crashes_with_CPU_does_not_support_x86-64-v2_on_ACP.md); check the CPU flags as well.

### Cause 4: a disk taken offline for good still appears in TopolvmCluster and in the lvmd ConfigMap

A disk was physically taken offline, but TopoLVM still lists it. The device is still in the node's `devices` list under `spec.storage.deviceClasses` of `TopolvmCluster`, and it is still an entry of `deviceStates` in `status.json` of ConfigMap `lvmdconfig-<node>`, for example:

```json
"deviceStates": [{"name":"/dev/vdb","state":"Online"},{"name":"/dev/vdc","state":"Online"}]
```

Those leftover entries keep the node and the device class abnormal on the Local Storage page.

## Resolution

### Cause 1: the device is unavailable after a power cycle and lsblk no longer lists the disk

1. Confirm, from the node and from the kernel log, that the disk is gone rather than renamed:

```bash
lsblk
dmesg -T | grep -i -E 'sd[a-z]|nvme|I/O error' | tail -50
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm \
  -o jsonpath='{.status.nodeStorageState}' | jq .
```

2. Have the hardware or virtualization team check the disk and, if needed, replace it.
3. A new disk does not carry the old volume group or its logical volumes. Restore the PVCs that lived there from the application's backup or replicas. Remove the old device entries as in Cause 4, and add the new raw disk with **Add Storage Device** (see the related article on adding a disk).

### Cause 2: a damaged disk leaves a PVC on it unusable

Rebuild the PVC only when the data on it is not needed or can be restored. First record which PV and node the claim uses:

```bash
kubectl get pvc -n <namespace> <pvc> -o jsonpath='{.spec.volumeName}{"\n"}'
kubectl get pv <pv-name> -o jsonpath='{.spec.csi.driver}{" "}{.spec.nodeAffinity}{"\n"}'
kubectl get pod -n <namespace> -o wide | grep <workload>
kubectl get pvc -n <namespace> <pvc> -o yaml > /tmp/<pvc>.before.yaml
```

> **Warning:** Impact: deleting the PVC and PV drops the claim and whatever data was still on that volume; the restarted pod gets a new, empty volume. Precondition: only when the disk under this PV is confirmed damaged and the data is not needed or is backed up elsewhere. Rollback: none; restore from the application's backup.

```bash
kubectl delete pvc -n <namespace> <pvc>
kubectl delete pv <pv-name>
kubectl delete pod -n <namespace> <pod>
kubectl get pvc -n <namespace>
```

The new claim is provisioned on a node whose device class is healthy. If the pod's owner does not create its PVC from a template (a StatefulSet `volumeClaimTemplates` does), recreate the PVC from the saved manifest, without its `spec.volumeName`, before you restart the pod.

### Cause 3: discover fails with exit status 127 and the GPT main header of the disk is corrupted

1. Confirm with a read-only check. `sgdisk -v` (verify) and `gdisk -l` only read the disk:

```bash
lsblk -f
sgdisk -v /dev/<disk>
gdisk -l /dev/<disk>
```

Look for `Invalid CRC on main header data`, `Main and backup partition tables differ!`, `Main header: ERROR`, or `Main partition table: ERROR`, with `Backup header: OK`. Do not use `sgdisk -e` as a check: it writes to the disk (it moves the backup GPT structures to the end of the disk and writes the partition table back).

2. Repair the disk, choosing by what it holds:
   - The disk is a TopoLVM data disk and holds nothing you need: return it to a raw disk by removing its signatures and partition table, as in Cause 1 of [TopoLVM does not offer a disk or topolvm-prepare-vg fails to create the volume group on ACP](./TopoLVM_does_not_offer_a_disk_or_topolvm-prepare-vg_fails_to_create_the_volume_group_on_ACP.md).
   - The partitions are still needed: rebuild the main header from the intact backup header. Agree this with whoever owns the disk first.

> **Warning:** Impact: `sgdisk -e` (and the recovery menu of `gdisk`) rewrites the GPT headers and partition table on `/dev/<disk>`; a wrong disk, or a backup table that is itself stale, writes a bad partition table and can make every partition on the disk unreachable. Precondition: only when this cause is confirmed with the read-only check above, the disk is the right one, the GPT has been saved with `sgdisk --backup`, and the disk owner has agreed. Rollback: `sgdisk --load-backup=/root/<disk>-gpt.bak /dev/<disk>` restores the saved headers and table.

```bash
sgdisk --backup=/root/<disk>-gpt.bak /dev/<disk>
sgdisk -e /dev/<disk>
sgdisk -v /dev/<disk>
```

3. Rebuild the TopoLVM cluster on the repaired disks afterwards, and confirm `discover-device` no longer logs `exit status 127`.

### Cause 4: a disk taken offline for good still appears in TopolvmCluster and in the lvmd ConfigMap

Volumes that lived on that disk are already lost. The supported procedure is "Scenario 1: Remove a volume group device from a device-class volume group" in the product documentation topic "Remove Disks, Device-Class Volume Groups, or Nodes from LVM Storage". It applies when the node is still reachable, the device class provision type is `Thick`, and the volume group still has at least one healthy disk. If the failed disk was the only disk of that volume group, so `vgs` no longer lists the group, use Scenario 2 of the same topic (remove the device-class volume group); if the node itself is retired, use Scenario 3 (see [Removing a TopoLVM storage node or releasing its disks on ACP](./Removing_a_TopoLVM_storage_node_or_releasing_its_disks_on_ACP.md)).

1. Save both objects and identify the logical volumes that used the failed disk:

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm -o yaml > /tmp/topolvmcluster.before.yaml
kubectl -n nativestor-system get cm lvmdconfig-<node> -o yaml > /tmp/lvmdconfig.before.yaml
kubectl -n nativestor-system scale deployment topolvm-operator --replicas=0
vgs <vg-name>
lvs -a -o +devices <vg-name> 2>/dev/null | egrep "/dev/<failed-disk>|unknown" | awk '{print $1}'
```

2. Each name the `lvs` line prints is a logical volume on the failed disk; its PV has that name as `spec.csi.volumeHandle`:

```bash
kubectl get pv -o json | jq -r --arg HANDLE <lv-name> '
  .items[] | select(.spec.csi.volumeHandle == $HANDLE)
  | [.metadata.name, .spec.claimRef.namespace, .spec.claimRef.name] | @tsv'
```

3. Stop the workloads that use those PVCs.

> **Warning:** Impact: these commands delete the PVC, the PV, the `logicalvolumes.topolvm.cybozu.com` object, and the logical volume, and drop the missing disk from the volume group. Data on those volumes is not recoverable. Precondition: only when the disk is confirmed gone for good, the workloads are stopped, and the names come from the `lvs` and `jq` output above. Rollback: none.

```bash
kubectl delete pvc -n <pvc-namespace> <pvc-name>
kubectl delete pv <pv-name>
kubectl delete logicalvolumes.topolvm.cybozu.com <pv-name>
lvremove <vg-name>/<lv-name>
vgreduce --removemissing <vg-name>
```

4. Remove the device entries, then start the operator.

> **Warning:** Impact: while `topolvm-operator` is at 0 replicas no device class is reconciled on any node, and removing the entries drops TopoLVM's record of that disk. Existing mounts on other disks keep working. Precondition: only when the disk is physically offline for good, both objects are saved, and you remove only the failed device on the target node. Rollback: while the operator is still at 0, apply the saved `TopolvmCluster` and ConfigMap.

```bash
kubectl -n nativestor-system edit topolvmclusters.topolvm.cybozu.com topolvm
kubectl -n nativestor-system edit cm lvmdconfig-<node>
kubectl -n nativestor-system scale deployment topolvm-operator --replicas=1
```

In `TopolvmCluster`, delete the failed device from the target node's `devices` list. In `status.json` of `lvmdconfig-<node>`, delete that device's element from `deviceStates` and keep the others, for example leave only `{"name":"/dev/vdc","state":"Online"}` when `/dev/vdb` is the device that is gone.

5. Confirm the device is gone from status. Every node then shows Normal (`正常`) on the Local Storage view and the device class shows Available (`可用`):

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm -o jsonpath='{.status.nodeStorageState}' | jq
```

## Diagnostic Steps

```bash
lsblk
kubectl -n nativestor-system get pods -o wide
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm -o yaml
kubectl -n nativestor-system get cm -o name | grep -i lvm
kubectl logs -n nativestor-system <discover-device-pod> --tail=50
```

- A device on the Storage Devices tab that `lsblk` on its node no longer shows after a power cycle: Cause 1.
- A PVC that cannot be mounted because its disk is damaged (`dmesg` shows I/O errors for that disk): Cause 2.
- `failed to list all devices: exit status 127`, CPU flags complete, and `Main header: ERROR` from `sgdisk -v` or `gdisk -l`: Cause 3.
- A disk that is gone for good while `TopolvmCluster` `devices` and `deviceStates` in `lvmdconfig-<node>` still list it: Cause 4.
- Data inside a container is missing while the disk is healthy: check that the PVC is still bound to the original PV (`kubectl get pvc -n <namespace> <pvc> -o jsonpath='{.spec.volumeName}'`) and that `lvs -a` on the PV's node still lists the logical volume named by the PV's `spec.csi.volumeHandle`. A recreated PVC or PV is a new, empty volume. For what deletes TopoLVM data, see [Removing a TopoLVM storage node or releasing its disks on ACP](./Removing_a_TopoLVM_storage_node_or_releasing_its_disks_on_ACP.md).
