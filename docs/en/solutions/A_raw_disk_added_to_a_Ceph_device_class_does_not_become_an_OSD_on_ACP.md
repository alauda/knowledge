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

# A raw disk added to a Ceph device class does not become an OSD on ACP

## Issue

A bare disk is attached to a node for Ceph distributed storage on Alauda Container Platform, but it never becomes an OSD in the device class the pool uses:

- The raw disks are attached and Ceph storage has to be expanded (routine expansion).
- A disk was added to the device class from the page and the configuration was accepted. `CephCluster` lists the disk under `spec.storage.nodes`, but nothing happens: `ceph osd tree` shows no new OSD and the capacity does not grow.
- The prepare log shows `skipping device "<device>": ["Has GPT headers"]`.
- The disk was already wiped with `dd`, `wipefs`, or `sgdisk`, and Ceph still does not use it.
- Rook-Ceph raises an abnormal alert, `osd-prepare` is never created for the node, and the node has a taint.

Work in the `rook-ceph` namespace (`CephCluster` `cephclusters.ceph.rook.io`, operator Deployment `rook-ceph-operator`, toolbox Deployment `rook-ceph-tools`). Ceph commands run in the toolbox unless the step says to run on the node.

Related articles: [Ceph storage pool cannot be created or never finishes because the deployment created no OSD on ACP](./Ceph_storage_pool_cannot_be_created_or_never_finishes_because_the_deployment_created_no_OSD_on_ACP.md), [Ceph OSD crash-loops with not a block device, or an OSD has to move to another device class on ACP](./Ceph_OSD_crash-loops_with_not_a_block_device_or_an_OSD_has_to_move_to_another_device_class_on_ACP.md), [Ceph device class page rejects a disk, or Ceph does not show the new capacity on ACP](./Ceph_device_class_page_rejects_a_disk_or_Ceph_does_not_show_the_new_capacity_on_ACP.md) (the page offers no device, `至少需要 3 个节点`, USB devices, a grown virtual disk).

## Root Cause

### Cause 1: skipping device "<device>": ["Has GPT headers"]

Rook does not create an OSD on a disk that still has a GPT (or other) signature. A replacement disk and a disk that once belonged to another Ceph cluster both look like this. The disk is not bad; it is not empty enough for prepare.

### Cause 2: the raw disk is on the node but not in the device class

The disk is visible in `lsblk` with no filesystem mounted, but `ceph osd tree` has no OSD for it. A pool only places data on its CRUSH device class. Until the disk is added to that class from the Device Class page (or an equivalent `CephCluster` `spec.storage` entry), capacity does not grow. This path assumes healthy, unused disks; damaged disks have to be repaired or replaced first.

On ACP 4.3.1 the page that adds disks to an existing device class sometimes does not list disks that are already members, and submitting the form can drop those disks from `spec.storage`.

### Cause 3: the whole disk still carries an LVM2_member label, so no osd-prepare pod starts on the node

`CephCluster` has the new device, other nodes have `osd-prepare` pods in `Completed`, and the node with the new disk has no prepare pod at all. `lsblk -f` shows the whole disk with `FSTYPE` `LVM2_member`, no partitions, and no mount. `pvs`, `lvs`, and `dmsetup ls` can be empty: no active volume group uses the disk, but the LVM label is still on it. `sgdisk --zap-all` and `fdisk` clear only partition tables, not this label. As long as `blkid` reports a filesystem type for the whole disk, the disk is treated as occupied.

### Cause 4: disk still occupied after dd, wipefs, and sgdisk

The disk was cleaned with `dd if=/dev/zero of=/dev/<device> bs=4k count=512`, `wipefs -af /dev/<device>`, and `sgdisk --zap-all /dev/<device>`, `blkid -p` no longer reports a type, and Ceph still does not use it. Those commands clear signatures and the partition table (the `dd` overwrites about the first 2 MiB) but do not release leftover OSD occupancy of the device on the node. Restarting the node released it.

### Cause 5: osd-prepare not created because the node is tainted

Operator logs suggest the affected node may have been deleted, the `osd-prepare` object is not created, and `kubectl describe node` shows a taint. That taint blocks `osd-prepare` on the node.

## Resolution

### Cause 1: skipping device "<device>": ["Has GPT headers"]

1. On the node, confirm the device. It must be the skipped disk, not the OS disk and not a device that backs an `up` OSD:

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINT,MODEL,SERIAL /dev/<device>
wipefs /dev/<device>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

2. If `lsblk` shows a leftover `ceph-*` device-mapper node on this disk only, remove it first. Skip this if there is none.

> **Warning:** `dmsetup remove` detaches the mapping immediately; if it is an active OSD, that OSD crashes and its PGs go degraded. Precondition: `lsblk` shows the mapping only on the skipped disk, and `ceph osd tree` lists no `up` OSD on it. Rollback: none.

```bash
dmsetup remove /dev/mapper/<ceph-mapper-name>
```

3. Wipe the disk.

> **Warning:** This destroys every signature, the partition table, and the first 100 MiB of `/dev/<device>`. Irreversible. Precondition: a second person has checked the device name against `lsblk`, the disk is not mounted or in `findmnt`, and it is not the OS disk or a live OSD disk. Rollback: none.

```bash
wipefs -af /dev/<device>
sgdisk --zap-all /dev/<device>
dd if=/dev/zero of=/dev/<device> bs=1M count=100 oflag=direct,dsync
```

4. Restart the operator so prepare runs again.

> **Warning:** Restarting `rook-ceph-operator` restarts only the operator pod; OSD pods keep running, but prepare and reconcile pause until the new pod is Ready. Precondition: the wipe finished on the intended disk. Rollback: none needed; the Deployment spec is unchanged.

```bash
kubectl -n rook-ceph rollout restart deploy/rook-ceph-operator
kubectl -n rook-ceph rollout status deploy/rook-ceph-operator
```

5. Add the disk to the device class (Cause 2). `ceph osd tree` then shows a new OSD `up` and `in`.

### Cause 2: the raw disk is on the node but not in the device class

This is the normal expansion path; wiping is not part of it. If a disk added here never becomes an OSD, read the prepare log and go to the matching cause.

1. Check each disk's health first. I/O or medium errors, or a failed health check, are not this cause; plan a repair or replacement with the storage owner.

```bash
dmesg -T | grep -i -E '<device>|I/O error|medium error' | tail -n 20
smartctl -H /dev/<device>
```

2. Save the cluster object:

```bash
kubectl -n rook-ceph get cephcluster -o yaml > cephcluster-before.yaml
```

3. In the console, open **Storage Management** > **Distributed Storage** > the cluster > **Device Class**, open the class the pool uses, choose **Add Device**, select the node, and enter the disk name (`sde`, `nvme0n1`, or whatever `lsblk` showed). Two disks on one node are two names on that node, for example `nvme0n1` and `nvme1n1`. On ACP 4.0.3 the page path was Storage Management, Distributed Storage, Access Storage. Create a new class the same way when the pool is to use a separate class.

4. After the operator prepares the disk, check from the toolbox:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd df
```

Adding disks starts backfill, and available-capacity numbers settle only after backfill finishes.

5. Diff `spec.storage.nodes` against `cephcluster-before.yaml`; every previous device must still be present. If the ACP 4.3.1 page dropped existing disks, put only the missing device entries back with `kubectl -n rook-ceph edit cephcluster <name>`. Do not `kubectl apply` the whole backup over a cluster that has moved on. See also [Ceph OSDs nearfull, backfill blocked, or OSD usage uneven on ACP](./Ceph_OSDs_nearfull_backfill_blocked_or_OSD_usage_uneven_on_ACP.md), Cause 2.

### Cause 3: the whole disk still carries an LVM2_member label, so no osd-prepare pod starts on the node

1. Confirm the label and that no prepare pod exists for the node:

```bash
lsblk -f /dev/<device>
blkid -p /dev/<device>; echo exit:$?
pvs; lvs; dmsetup ls
kubectl -n rook-ceph get pods -o wide | grep -i prepare
```

2. Clear the label and refresh udev.

> **Warning:** Impact: `wipefs -af` removes every signature on `/dev/<device>` and `dd` zeroes its first 100 MiB. Irreversible. Precondition: only when `lsblk -f` shows `LVM2_member` on this whole disk, `pvs`, `lvs`, and `dmsetup ls` show no volume group or mapping you still use on it, it is not mounted, and it is not the OS disk. Rollback: none.

```bash
wipefs -af /dev/<device>
dd if=/dev/zero of=/dev/<device> bs=1M count=100 oflag=direct conv=fsync
udevadm trigger --action=change /sys/class/block/<device>
udevadm settle
blkid -p /dev/<device>; echo exit:$?
lsblk -f /dev/<device>
```

`blkid -p` printing nothing with `exit:2` and `lsblk -f` showing no `FSTYPE` confirm the disk is clean. The operator then prepares it; restart `rook-ceph-operator` as in Cause 1 if no prepare pod appears, and check `ceph osd tree`.

### Cause 4: disk still occupied after dd, wipefs, and sgdisk

Use this only when the wipe already ran, `blkid -p` reports nothing (Cause 3 is excluded), and Ceph still does not use the disk.

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT /dev/<device>
findmnt | grep <device> || true
```

> **Warning:** Restarting the node stops every OSD and any MON on it; PGs peer again, and a second storage-node failure during the reboot can drop a replica set. Precondition: the disk is still occupied after the wipe, other replicas are `up`, and you are in a maintenance window. Rollback: the node comes back on its own; a reboot does not restore a wiped disk.

Restart the node with your node maintenance procedure. When it is `Ready` and the device is free in `lsblk`, add it with Cause 2.

### Cause 5: osd-prepare not created because the node is tainted

```bash
kubectl describe node <node> | grep -i -A3 Taints
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=200 | grep -i prepare
```

> **Warning:** Removing the taint allows pods to schedule on `<node>`, including workloads the taint was holding off. Precondition: you saved the full taint key, value, and effect, and this node is supposed to host OSDs. Rollback: `kubectl taint node <node> <key>=<value>:<effect>`.

```bash
kubectl taint node <node> <taint-key>-
```

Then restart `rook-ceph-operator` as in Cause 1 (same Warning) and check that prepare is created:

```bash
kubectl -n rook-ceph rollout restart deploy/rook-ceph-operator
kubectl -n rook-ceph get pods -o wide | grep -i prepare
```

## Diagnostic Steps

1. List the prepare pods with their nodes, and read the skip reason:

```bash
kubectl -n rook-ceph get pods -o wide | grep -i prepare
kubectl -n rook-ceph logs <prepare-pod> | grep -E 'skipping device|Has GPT|<device>'
```

Make sure the prepare pod you read runs on the node that holds the disk.

2. On the node, separate an empty disk from one that still has a signature, a partition, or a mount:

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINT
blkid -p /dev/<device>; echo exit:$?
findmnt
```

A disk with partitions or a mounted filesystem (for example a container runtime disk) is in use; do not wipe it, choose a free disk instead.

3. Check OSDs and classes:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush class ls
```

- `Has GPT headers` in the prepare log: Cause 1.
- Clean disk not yet in the device class: Cause 2.
- No prepare pod on the node, `FSTYPE` `LVM2_member` on the whole disk: Cause 3.
- Wipe done, `blkid -p` empty, disk still not used: Cause 4.
- No prepare pod and a taint on the node: Cause 5.
