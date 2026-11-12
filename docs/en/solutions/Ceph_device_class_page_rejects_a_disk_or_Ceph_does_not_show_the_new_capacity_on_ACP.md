---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Ceph device class page rejects a disk, or Ceph does not show the new capacity on ACP

## Issue

A disk is on the node, but Ceph distributed storage on Alauda Container Platform will not take it, or Ceph does not show the size the operating system already shows:

- Adding a storage node says no devices are available, although `dd if=/dev/zero of=/dev/<device> bs=4k count=512`, `wipefs -af`, and `sgdisk --zap-all` were already run. The data disk (for example `vdb`) is still missing from the list.
- A pool already exists on three nodes, a fourth node has one raw disk, and the page says `至少需要 3 个节点` ("at least 3 nodes are required"). The question is why expanding Ceph needs three nodes.
- A device class cannot be added for a device on a node that just joined, and the device is USB.
- A newly added disk is listed only on the `CephCluster` resource.
- A virtual disk under an existing OSD was enlarged; the OS shows the new size, but Ceph (or the device class capacity on the distributed storage page) still reports the old capacity, and the OSD cannot be deleted from the interface.
- Deploying a storage cluster stops with a message that the selected disks do not have sufficient identifying information and may lose identification after a reboot. The disks have names from custom udev rules such as `/dev/data1`.

Environment: namespace `rook-ceph`, cluster object `CephCluster`, operator Deployment `rook-ceph-operator`, toolbox `deploy/rook-ceph-tools`. Adding a disk through the device class page assumes a healthy, unused disk; check for I/O or medium errors first (`dmesg`, `smartctl -H`).

## Root Cause

### Cause 1: no devices available after dd, wipefs, and sgdisk

A disk that still holds an operating system or data is not listed, which is why wiping is the first check. Sometimes a leftover survives the short `dd`, `wipefs -af`, and `sgdisk --zap-all` sequence, and the disk still does not show up. Partitioning the disk with `fdisk` and then running the same wipe again makes it appear. A node restart is not needed for this.

### Cause 2: at least 3 nodes are required when one new node's disk is added on the pool path

The three-node check belongs to creating a storage pool. A replicated pool with `size 3` and failure domain `host` needs OSDs on at least three different hosts to place its three copies, so the create path rejects a submission with only one new node. Adding a disk to an existing pool is done from the device class section, on the device class that the existing pool uses; it does not require three new nodes.

### Cause 3: the new device is USB

Ceph storage on the platform does not accept USB devices, so the page cannot add a device class for one. Wiping does not make a USB device eligible.

### Cause 4: the new disk is only in CephCluster, or an expanded disk keeps the old OSD size

A disk added to existing Ceph storage can appear only in the `CephCluster` resource at first and in the other views after a wait. That is the normal add, not a reason to wipe again.

When a disk under an existing OSD is enlarged in the virtualization platform, the OSD does not use the new space by itself. Restarting the OSD pod can make the expanded size display. If it does not, BlueStore itself has to be expanded onto the larger device before the device class capacity changes. Growing the disk under an existing OSD is not the recommended way to add capacity; adding a new OSD is.

### Cause 5: selected disks do not have sufficient identifying information

The deployment-phase disk check (confirmed on ACP 4.2.0) requires every selected disk to have a persistent `/dev/disk/by-id/` link. A disk without one is rejected. A name created by a custom udev rule (for example `/dev/data1`) is not a by-id link and does not satisfy the check. The check is about stable identification; filesystems, `/etc/fstab`, `UUID=`, or `LABEL` are not relevant for a Ceph raw disk.

A disk is offered for selection when its type is `disk` or `mpath`, no filesystem is detected, and its capacity is larger than 10 GiB; `rbd`, `nbd`, and `dm-*` devices are not listed. Whole raw disks are recommended over partitions.

## Resolution

### Cause 1: no devices available after dd, wipefs, and sgdisk

Use this only when the target is an unused data disk and the short wipe has already been run without the disk appearing.

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINT /dev/<device>
```

> **Warning:** `fdisk` writes a partition table, and the following `dd`, `wipefs -af`, and `sgdisk --zap-all` destroy it and the start of the disk; any data on `/dev/<device>` is gone. Precondition: this is the data disk the page refuses, not the OS disk, not mounted, and not backing an `up` OSD. Rollback: none.

```bash
fdisk /dev/<device>
dd if=/dev/zero of=/dev/<device> bs=4k count=512
wipefs -af /dev/<device>
sgdisk --zap-all /dev/<device>
```

Then add the storage node again from the page.

### Cause 2: at least 3 nodes are required when one new node's disk is added on the pool path

1. Leave the pool-create wizard. Find the device class the existing pool uses:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool ls detail
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush rule dump
```

2. Save `CephCluster` before any submit on this page; on ACP 4.3.1 a submit could drop the disks a node already had from `spec.storage`:

```bash
kubectl -n rook-ceph get cephcluster -o yaml > cephcluster-before.yaml
```

3. In the console, open **Storage Management** (`存储管理`) > **Distributed Storage** (`分布式存储`) > the cluster (for example `ceph-cluster`) > **Device Class** (`设备类`) tab.
4. Select the device class the pool uses (for example `hdd`) and click **Add Device** (`添加设备`).
5. In the **Input Device** (`输入设备`) dialog, pick the **Node** (`节点`) and the **Specified Disk** (`指定硬盘`), for example `vdb`. Use **Add Node** (`添加 节点`) for more nodes.
6. After the submit, check that the old disks are still under `spec.storage.nodes` and that the new OSD appears in `ceph osd tree`. The rebalance after the add generates backfill traffic; do it in a maintenance window.

If the Add Device dialog of the device class itself shows `至少需要 3 个节点`, collect the dialog input and `cephcluster-before.yaml` and contact support.

### Cause 3: the new device is USB

```bash
lsblk -o NAME,SIZE,TRAN,TYPE,MODEL /dev/<device>
```

`TRAN` of `usb` is the signature. Use a non-USB disk; no restart or wipe changes the result.

### Cause 4: the new disk is only in CephCluster, or an expanded disk keeps the old OSD size

If the new disk is only in `CephCluster`, wait, then read `ceph osd tree`. If it never becomes an OSD, read the OSD prepare log.

If the OS shows a larger size for a disk that backs an existing OSD and Ceph still reports the old capacity, restart that OSD first.

> **Warning:** Restarting `rook-ceph-osd-<id>` stops that OSD until the new pod is up, and its PGs peer again. Precondition: the OS size and the Ceph size disagree for this id, the other replicas are `up`, and you are not deleting the OSD. Rollback: none needed; if the new pod fails, read its log before any wipe.

```bash
kubectl -n rook-ceph rollout restart deploy/rook-ceph-osd-<id>
kubectl -n rook-ceph rollout status deploy/rook-ceph-osd-<id>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd df
```

If `ceph osd df` still shows the old `SIZE`, expand BlueStore with `ceph-bluestore-tool bluefs-bdev-expand`, which runs against the OSD data directory while the `ceph-osd` process is stopped. The steps below are general Rook practice: keep the OSD pod (its init containers prepare `/var/lib/ceph/osd/ceph-<id>`) but replace the daemon with a sleep. Compare the sizes first, and check whether the OSD sits on an LVM volume:

```bash
lsblk -o NAME,SIZE,TYPE /dev/<device>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata <id> | grep -E 'bluestore_bdev_size|devices'
```

> **Warning:** The steps below stop `osd.<id>` for the duration and pause the Rook operator; PGs on that OSD run degraded and no Rook reconcile happens meanwhile. Precondition: the OS shows the larger device, the restart did not change `ceph osd df`, every other OSD is `up`, no PG depends only on this OSD, and you are in a maintenance window. Rollback: `kubectl -n rook-ceph rollout undo deploy/rook-ceph-osd-<id>`, then scale the operator back to 1 and unset `noout`. A completed expansion is not undone.

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set noout
kubectl -n rook-ceph scale deploy rook-ceph-operator --replicas=0
kubectl -n rook-ceph get deploy rook-ceph-osd-<id> -o yaml > rook-ceph-osd-<id>-before.yaml
kubectl -n rook-ceph edit deploy rook-ceph-osd-<id>
```

In the editor, in the container named `osd`, set `command: ["sleep", "infinity"]`, delete its `args`, and delete its `livenessProbe` and `startupProbe` if present. Save, wait for the new pod, and confirm the data directory has a `block` link. If it is empty, roll back and contact support instead of continuing.

```bash
kubectl -n rook-ceph rollout status deploy/rook-ceph-osd-<id>
kubectl -n rook-ceph exec deploy/rook-ceph-osd-<id> -c osd -- ls -l /var/lib/ceph/osd/ceph-<id>/
```

If `lsblk` showed a `ceph--*` logical volume on the disk, grow the physical volume and the logical volume on the node first; `bluefs-bdev-expand` can only use space the `block` device already has:

```bash
pvresize /dev/<device>
lvextend -l +100%FREE /dev/<ceph-vg>/<osd-block-lv>
```

Run the expansion, then restore the daemon and the operator:

```bash
kubectl -n rook-ceph exec -it deploy/rook-ceph-osd-<id> -c osd -- ceph-bluestore-tool bluefs-bdev-expand --path /var/lib/ceph/osd/ceph-<id>
kubectl -n rook-ceph rollout undo deploy/rook-ceph-osd-<id>
kubectl -n rook-ceph rollout status deploy/rook-ceph-osd-<id>
kubectl -n rook-ceph scale deploy rook-ceph-operator --replicas=1
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset noout
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd df
```

`SIZE` for the id and the device class capacity on the page now show the larger value. Repeat one OSD at a time, waiting for `active+clean` in between. For the next expansion, add new OSD disks instead of enlarging existing ones.

### Cause 5: selected disks do not have sufficient identifying information

1. On each storage node, check whether the disk has a by-id link and which serial or WWN it exposes:

```bash
lsblk -o NAME,TYPE,SIZE,FSTYPE,SERIAL,WWN
ls -l /dev/disk/by-id/ | grep -w <device>
```

A disk that is the target of some `/dev/disk/by-id/` link passes the check; a disk with no link fails it, whatever udev alias it has.

2. Make the hypervisor or storage expose a stable serial or WWN for the virtual disk so that udev creates the by-id link. Check the `ls` output rather than assuming a hypervisor setting (such as disk UUIDs on ESXi) already does it. Then select the disk by its kernel name in the wizard.
3. Prepare each disk as a whole raw disk: not partitioned, no filesystem, not mounted, not in `/etc/fstab`.

> **Warning:** `wipefs -af` and `sgdisk --zap-all` erase the signatures and partition table of `/dev/<device>`. Precondition: `lsblk` confirms this is the data disk intended for Ceph, not mounted, and not the OS disk. Rollback: none.

```bash
wipefs -af /dev/<device>
sgdisk --zap-all /dev/<device>
```

## Diagnostic Steps

```bash
lsblk -o NAME,SIZE,TRAN,TYPE,FSTYPE,MOUNTPOINT
kubectl -n rook-ceph get cephcluster -o yaml | grep -n device
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd df
```

- No device available after the short wipe: Cause 1.
- `至少需要 3 个节点` while adding one disk on a new node to an existing pool: Cause 2.
- `lsblk` `TRAN` is `usb`: Cause 3.
- A disk only in `CephCluster`, or Ceph capacity stale after a virtualization grow: Cause 4.
- The wizard says the disks lack sufficient identifying information, and `ls -l /dev/disk/by-id/` has no link for the disk: Cause 5.
- `dmesg` shows I/O or medium errors, or `smartctl -H` fails: a disk health problem, not a page problem.
