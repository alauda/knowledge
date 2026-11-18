---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.16.x
  - 3.18.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# TopoLVM does not offer a disk or topolvm-prepare-vg fails to create the volume group on ACP

## Issue

A data disk cannot be used by TopoLVM on Alauda Container Platform:

- TopoLVM deployment reports an error on a data disk, TopoLVM cannot be created because the disk shows as unavailable, or a bare disk is missing from the addable device list.
- `pvcreate` reports `Device /dev/<disk> excluded by a filter.`, or a device class reports `disk may has filesystem or is not raw disk please check`.
- The `topolvm-prepare-vg` log shows `Cannot use /dev/<disk>: device is partitioned` followed by `create vg <class>-<uuid> retry failed err:exit status 5`.
- A newly added disk stays "device unavailable" while the TopoLVM pod for that node keeps being recreated.
- A device class stays Offline or shows `0 GiB`, and `topolvm-prepare-vg` logs `device:/dev/mapper/mpatha is not available`.
- Adding a disk for expansion finishes with no extra capacity.

The operands live in `nativestor-system`. The cluster object is `topolvmclusters.topolvm.cybozu.com/topolvm` (`TopolvmCluster`). Preparation is the Job `topolvm-prepare-vg`; discovery is the `discover-device` pod.

TopoLVM needs a whole disk of type `disk`. A partition such as `/dev/sdb1` is rejected. TopoLVM does not require a particular RAID level: a hardware RAID volume (for example RAID 5) qualifies when the operating system sees it as a whole disk with no partitions, no filesystem, and no RAID member signature. `/dev/sda` is often the operating-system disk; never wipe a disk because its name matches an example.

Related articles: [Former TopoLVM data disk stays unavailable because old LVM and thin-pool mappings remain on ACP](./Former_TopoLVM_data_disk_stays_unavailable_because_old_LVM_and_thin-pool_mappings_remain_on_ACP.md), [TopoLVM device class capacity does not change after the underlying disk is expanded on ACP](./TopoLVM_device_class_capacity_does_not_change_after_the_underlying_disk_is_expanded_on_ACP.md) (a disk TopoLVM already uses was grown in place), [TopoLVM lvmd exits with should have at least one device-class or Error: not found on ACP](./TopoLVM_lvmd_exits_with_should_have_at_least_one_device-class_or_Error_not_found_on_ACP.md).

## Root Cause

### Cause 1: Device excluded by a filter, or the disk still has a filesystem, partition, or LVM signature

The disk still carries an old signature: `wipefs -n` or `lsblk -f` shows `LVM2_member`, a partition table, a filesystem, or a foreign member such as `jmicron_raid_member`. TopoLVM does not offer such a disk, `pvcreate` refuses it, and pool expansion does nothing until those signatures are removed. A partition table on a whole disk shows up as the `pvcreate` that prepare runs on the host failing:

```text
prepare-vg: start provision with node status
nsenter -u -i -n -m -p -t 1 lvm pvcreate /dev/nvme0n1
Cannot use /dev/nvme0n1: device is partitioned
prepare-vg: create vg <class>-<uuid> retry failed err:exit status 5
```

The message `disk may has filesystem or is not raw disk please check` is also written when the device is already a physical volume of a TopoLVM volume group whose name differs from the one TopoLVM recorded. Then `pvs` shows the device in a VG named `<class>-<uuid>` and `lvs` shows live logical volumes. That is not a dirty disk, and wiping it destroys the PVC data (see the related article on lvmd). Run `pvs` and `lvs` before any wipe.

If `wipefs -n` is empty and `pvcreate` still prints `excluded by a filter`, the LVM devices file is the next check, not a format.

### Cause 2: the disk is not in TopolvmCluster.spec.storage.deviceClasses

`TopolvmCluster` lists other devices on that `nodeName` and not the target path, and the `discover-device` logs have no line for it. A disk that was wiped but never added is not used. The UI **Add Storage Device** action is the normal path once an initial device class exists. On a cluster whose Local Storage page shows a healthy TopoLVM install but refuses the first node and disk, writing the node and device into `TopolvmCluster` by hand makes later UI adds work.

### Cause 3: prepare-vg: device:/dev/mapper/mpatha is not available

The prepare log shows `sys: device:dm-12 is available` and, on the next line, `prepare-vg: device:/dev/mapper/mpatha is not available`. Inventory and prepare disagree about one multipath device (`/dev/mapper/mpath*`, type `mpath`), for example an iSCSI LUN. The device class becomes Offline with `0 GiB`, and the prepare Job can show Succeeded while a new Job is created about every 30 seconds. `wipefs -n` is empty; this is not a dirty disk. The TopoLVM operator of ACP 3.16 (v3.16.6) does not support multipath devices. `/dev/dm-N` is not a stable name to configure instead.

### Cause 4: newly added node disk is blank, the device stays unavailable and the pod is recreated repeatedly

A disk was added to a node for TopoLVM. The device stays unavailable and the TopoLVM pod for that node keeps being recreated. `lsblk -f`, `blkid`, and `wipefs -n` show no filesystem, partition table, or LVM signature: the disk is blank, not dirty. Formatting it on the host made the device available and stopped the pod recreation. The exact filesystem type that was written is not known.

A different shape with the same symptom: `topolvm-prepare-vg` and `topolvm-node` pods rebuild forever while `pvs`, `vgs`, and `lvs` already show the complete PV, VG, and LV and the logs are quiet. That disk is not blank, so this cause does not apply.

## Resolution

Identify the device with the commands in Diagnostic Steps before any wipe. Stop if the path is mounted, is the parent of `/`, `/boot`, or `/var`, or is already a PV in `pvs` that an application still uses.

### Cause 1: Device excluded by a filter, or the disk still has a filesystem, partition, or LVM signature

> **Warning:** Impact: `wipefs -af` deletes every filesystem, RAID, LVM, and partition signature on that path, and `sgdisk --zap-all` destroys the GPT and the protective MBR; the data is not recoverable from the node. Precondition: only when `wipefs -n` lists at least one leftover signature; `lsblk`, `findmnt`, `blkid`, and `pvs` show the disk is unused; it is not the disk that holds `/`; and no bound TopoLVM PV points at it. If `wipefs -n` prints nothing, there is nothing to wipe: go to the devices-file check below, or to Cause 4. Rollback: none; restore only from a backup taken before the wipe.

```bash
lsblk /dev/<disk>
wipefs -af /dev/<disk>
sgdisk --zap-all /dev/<disk>
wipefs -n /dev/<disk>
lsblk /dev/<disk>
```

The last `lsblk` must show the disk as `disk` with no child partitions and no mountpoint, and `wipefs -n` must print nothing. If `sgdisk` is not installed and `wipefs -n` is already empty, the `wipefs -af` step alone is enough. Then add the device (Cause 2). If `topolvm-prepare-vg` already failed on the old signature, delete that Job so the operator starts a new one; deleting the Job does not delete a volume group:

```bash
kubectl delete job -n nativestor-system <topolvm-prepare-vg-job>
```

If `pvcreate` still prints `excluded by a filter` after the wipe, the LVM devices file may be omitting the disk:

```bash
lvmconfig devices/use_devicesfile
lvmdevices
```

> **Warning:** `lvmdevices --adddev` allows LVM to claim `/dev/<disk>`. Precondition: `use_devicesfile` is 1 and this is the TopoLVM data disk, not a disk you meant to keep out of LVM. Rollback: `lvmdevices --deldev /dev/<disk>`.

```bash
lvmdevices --adddev /dev/<disk>
```

Do not change the global `filter` in `/etc/lvm/lvm.conf` for this. If the disk still shows old TopoLVM thin-pool mappings in `dmsetup ls`, `wipefs` cannot remove them; see the related article on leftover mappings.

### Cause 2: the disk is not in TopolvmCluster.spec.storage.deviceClasses

Prefer **Storage Management > Local Storage > Storage Devices > Add Storage Device** and select the clean whole disk. If the page will not offer the node, edit the object.

> **Warning:** A wrong `devices[].name` makes prepare-vg operate on that path, and `useAllDevices: true` can pull in the OS disk. Precondition: Cause 1 is clear, you saved the YAML, and the path is the intended whole disk. Rollback: remove the device entry you added and save again.

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm -o yaml > /tmp/topolvmcluster.before.yaml
kubectl -n nativestor-system edit topolvmclusters.topolvm.cybozu.com topolvm
```

Add the node and device under `spec.storage.deviceClasses` (names are examples; keep `useAllDevices`, `useAllNodes`, and `useLoop` false unless the cluster already sets them):

```yaml
spec:
  storage:
    useAllDevices: false
    useAllNodes: false
    useLoop: false
    deviceClasses:
      - nodeName: <node>
        classes:
          - className: hdd
            default: true
            devices:
              - name: /dev/<disk>
                type: disk
```

`type` must be `disk`. Wait until `status.nodeStorageState` shows the class Ready and the UI capacity includes the new size; a Job phase of Succeeded is not that check. After a device is added the capacity can take about 10 minutes to appear, for each extra raw disk.

### Cause 3: prepare-vg: device:/dev/mapper/mpatha is not available

1. Do not wipe the LUN and do not switch the class to `/dev/dm-N`.
2. To stop the 30-second Job recreation, remove the `mpath` device from `spec.storage.deviceClasses` with the same edit as Cause 2. That leaves the class without this LUN; it does not delete data on the LUN.
3. Give TopoLVM a non-multipath whole disk, or upgrade to an ACP version whose TopoLVM release notes list multipath support and add the LUN with the path that version's device list offers.

### Cause 4: newly added node disk is blank, the device stays unavailable and the pod is recreated repeatedly

Decide by what the disk holds, not by the error alone:

- `wipefs -n` or `lsblk -f` lists old signatures: Cause 1.
- `wipefs -n` prints nothing and `pvcreate` prints `excluded by a filter`: neither wipe nor format; check the LVM devices file as in Cause 1.
- `wipefs -n` and `blkid` print nothing, there is no filter error, and the disk is the new, empty data disk: this cause.
- `pvs`, `vgs`, and `lvs` already show the complete TopoLVM PV, VG, and LV: neither wipe nor format here. Removing the node from `TopolvmCluster`, wiping the disk, and enrolling the node again is the recovery for that shape, and only when `lvs` shows no logical volume that backs a bound PV (see [Removing a TopoLVM storage node or releasing its disks on ACP](./Removing_a_TopoLVM_storage_node_or_releasing_its_disks_on_ACP.md)).

Take the format from a disk that already works in the same device class on another node:

```bash
# on a node where the same device class is Ready
lsblk -f /dev/<working-disk>
blkid /dev/<working-disk> || true
# on the new node
lsblk -o NAME,PATH,TYPE,SIZE,FSTYPE,MOUNTPOINT,PKNAME /dev/<disk>
wipefs -n /dev/<disk> || true
findmnt -n -o SOURCE /
```

> **Warning:** Impact: formatting writes a new signature to the whole disk and destroys anything on it. Precondition: the device is the newly added data disk, not the disk that holds `/`, `/boot`, or `/var`, not mounted, not in `pvs`, and `wipefs -n` shows no signatures. Rollback: none. If you cannot tell which format the working disk uses, do not guess; collect the output above and contact support.

After the disk matches the working disk, delete a failed `topolvm-prepare-vg` Job so the operator creates a new one, and confirm the class is Ready in `status.nodeStorageState` and the pod on that node stops being recreated.

## Diagnostic Steps

1. Confirm the operands are up, then read device-class status. A missing `TopolvmCluster` is a controller problem, not a reason to wipe.

```bash
kubectl get deploy,ds,job,pod -n nativestor-system -o wide
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm \
  -o jsonpath='{.status.nodeStorageState}' | jq .
```

2. On the node, prove identity and ownership:

```bash
lsblk -o NAME,KNAME,PATH,TYPE,SIZE,FSTYPE,MOUNTPOINT,PKNAME /dev/<disk>
blkid /dev/<disk> || true
wipefs -n /dev/<disk> || true
findmnt -n -o SOURCE /
pvs; vgs; lvs
multipath -ll
```

3. Read the prepare log:

```bash
kubectl logs -n nativestor-system job/<topolvm-prepare-vg-job> --all-containers --tail=200
```

- `excluded by a filter`, `device is partitioned`, or `disk may has filesystem` with a signature in `wipefs -n` and no TopoLVM VG in `pvs`: Cause 1.
- `disk may has filesystem or is not raw disk please check` while `pvs` shows the device in a TopoLVM `<class>-<uuid>` VG with live LVs: a VG-name mismatch, see the related lvmd article.
- Clean disk not listed in `TopolvmCluster`: Cause 2.
- `device:/dev/mapper/mpath* is not available` and a new prepare Job every 30 seconds: Cause 3.
- Blank disk, no filter error, pod recreated repeatedly: Cause 4.
- A pod mount error `target device is already formatted with different filesystem` is a signature on the logical volume, not on the disk; see [TopoLVM PVC rejects an access mode, fails to mount, or cannot be scheduled on ACP](./TopoLVM_PVC_rejects_an_access_mode_fails_to_mount_or_cannot_be_scheduled_on_ACP.md), Cause 2.
- In-use disk grown in place, so the Storage Device size is larger than `pvs`: see the related capacity article.
