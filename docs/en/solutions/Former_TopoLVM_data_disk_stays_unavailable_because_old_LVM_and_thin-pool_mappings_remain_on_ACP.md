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

# Former TopoLVM data disk stays unavailable because old LVM and thin-pool mappings remain on ACP

## Issue

After a cluster cleanup, or after the platform was deleted and reinstalled, the old TopoLVM data disk is not raw. Creating local storage reports the disk as unavailable, `lsblk -f` shows `LVM2_member`, and `dmsetup ls` still lists thin-pool mappings (`*_tmeta`, `*_tdata`, and the pool). `lsblk` on the data disk still shows the old TopoLVM devices, named after the old volume group:

```text
vdc                                                         500G disk
├─topolvm--<uuid>-topolvm--thin--pool_tmeta                 228M lvm
│ └─topolvm--<uuid>-topolvm--thin--pool                   449.6G lvm
│   ├─topolvm--<uuid>-<lv-uuid-1>                            5G lvm
│   └─topolvm--<uuid>-<lv-uuid-2>                            5G lvm
└─topolvm--<uuid>-topolvm--thin--pool_tdata               449.6G lvm
  └─topolvm--<uuid>-topolvm--thin--pool                   449.6G lvm
```

The 5G entries are the logical volumes that backed the old PVCs.

Related articles: [TopoLVM does not offer a disk or topolvm-prepare-vg fails to create the volume group on ACP](./TopoLVM_does_not_offer_a_disk_or_topolvm-prepare-vg_fails_to_create_the_volume_group_on_ACP.md) (old signatures while TopoLVM is still installed, a blank disk, a disk missing from `TopolvmCluster`, or a multipath device), [TopoLVM device unavailable or PVC unusable because the backing disk failed, disappeared, or was decommissioned on ACP](./TopoLVM_device_unavailable_or_PVC_unusable_because_the_backing_disk_failed_disappeared_or_was_decommissioned_on_ACP.md).

## Root Cause

### Cause 1: LVM2_member and thin-pool dm mappings remain after the cluster is gone

The volume group, its thin pool, and the logical volumes of the old installation are still on the disk, and the kernel still holds their device-mapper mappings. They keep the disk occupied, so it is not offered as a raw disk. The TopoLVM operator that created them is already gone, so nothing deletes the volume group for you. `wipefs` does not remove device-mapper mappings that are still open, so wiping alone fails or leaves the disk busy.

## Resolution

### Cause 1: LVM2_member and thin-pool dm mappings remain after the cluster is gone

Use this only when the signature is on the former data disk, the path is not the disk that holds `/`, and `findmnt` and `pvs` show no consumer you still need. If `wipefs -n` is empty and `dmsetup ls` has no mappings for this disk, stop: this article does not apply (see the related article on disks TopoLVM does not offer).

The same LV, VG, PV, and `dmsetup` steps also apply on a cluster where TopoLVM is still installed, when `wipefs -a` reports the device busy on a node whose pods rebuild forever. There they apply only after that node has been removed from `TopolvmCluster` and `lvs` shows no logical volume that backs a bound PV.

1. List the volume group and mappings:

```bash
lsblk -f /dev/<disk>
dmsetup ls
lvs -a -o lv_name,vg_name,lv_attr,pool_lv
pvs
vgs
findmnt -n -o SOURCE /
```

2. Remove the logical volumes, the volume group, and the physical-volume label, in that order.

> **Warning:** Impact: `lvremove`, `vgremove`, and `pvremove` delete the logical volumes, the volume group, and the physical-volume label on `/dev/<disk>`; data on those volumes is destroyed. Precondition: TopoLVM has already been removed (or the node has been removed from `TopolvmCluster` as described above), `lsblk -f` shows `LVM2_member` on this data disk, and it is not the OS disk and not a volume another host still mounts. Rollback: none.

```bash
lvremove <vg>/<lv>
vgremove <vg>
pvremove /dev/<disk>
```

Remove every logical volume in that volume group, including the thin pool, before `vgremove`. If `vgremove` says the group is busy, run step 4 and retry.

3. Clear the remaining signatures.

> **Warning:** Impact: `dd` overwrites the start of `/dev/<disk>`, `wipefs -af` removes every filesystem, RAID, and partition signature, and `sgdisk --zap-all` destroys the GPT and the protective MBR. Precondition: step 2 has finished, or has failed only because leftover mappings are still open, and `wipefs -n` still lists a signature. Rollback: none. If `sgdisk` is not installed, run the `dd` and `wipefs` lines.

```bash
dd if=/dev/zero of=/dev/<disk> bs=4k count=512
wipefs -af /dev/<disk>
sgdisk --zap-all /dev/<disk>
```

4. Remove leftover device-mapper mappings of that volume group.

> **Warning:** Impact: `dmsetup remove` deletes the named device-mapper mapping; a mapping that still holds a thin pool drops that pool. Precondition: `dmsetup ls` still lists mappings for the volume group you just removed (`*_tmeta`, `*_tdata`, and the pool), and those names belong to this disk, not to another volume group. Rollback: none.

```bash
dmsetup ls
dmsetup remove <mapping-name>
```

Repeat `dmsetup remove` for each leftover mapping of that volume group. A hyphen in a volume-group or logical-volume name is written as two hyphens in the device-mapper name (`topolvm--<uuid>-...`). When `dmsetup ls` no longer lists those mappings and `wipefs -n /dev/<disk>` prints nothing, the disk is raw again and can be used to create local storage.

5. After a platform reinstall, if creation still reports the disk unavailable while `topolvm--<uuid>-...` nodes remain under `/dev/mapper`, remove those mapper devices and reboot the node; the reboot is part of this recovery. List them by the old volume-group prefix first:

```bash
ls -l /dev/mapper | grep topolvm
lsblk /dev/<disk>
```

> **Warning:** Impact: removing a device-mapper node drops that mapping, and a reboot interrupts every pod on the node. Precondition: the names belong to the removed TopoLVM volumes, `dmsetup ls` does not show a volume group another workload still mounts, and steps 2 to 4 are done or those groups are already gone. Drain or plan downtime for the node's workloads first. Rollback: none for the mapping; the node comes back from the reboot on its own.

```bash
dmsetup remove <mapping-name>
reboot
```

After the node is back, confirm the disk is raw and create local storage on it again:

```bash
lsblk -f /dev/<disk>
wipefs -n /dev/<disk>
```

## Diagnostic Steps

```bash
lsblk -f /dev/<disk>
lsblk /dev/<disk>
dmsetup ls
pvs; vgs; lvs -a
kubectl get topolvmclusters.topolvm.cybozu.com -A
```

- TopoLVM already removed or the platform reinstalled, `LVM2_member` on the disk, and thin-pool mappings in `dmsetup ls` or `topolvm--<uuid>-...` children under the disk in `lsblk`: this article.
- The same signatures while TopoLVM is installed and the node is still in `TopolvmCluster`: see the related article on disks TopoLVM does not offer, and check `lvs` against bound PVs before removing anything.
- `wipefs -n` empty and no mappings: the disk is already raw; the problem is elsewhere (devices file, `TopolvmCluster` entry, or a blank disk).
