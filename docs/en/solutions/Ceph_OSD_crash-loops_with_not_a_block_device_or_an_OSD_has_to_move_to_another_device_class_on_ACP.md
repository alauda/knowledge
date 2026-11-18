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

# Ceph OSD crash-loops with not a block device, or an OSD has to move to another device class on ACP

## Issue

An existing Ceph OSD on Alauda Container Platform is not in the device class where it is needed:

- An OSD pod is `Init:CrashLoopBackOff` and its log contains `RuntimeError: Error: ["/dev/<device>"] not a block device`. `ceph osd tree` shows that OSD `down` with `REWEIGHT` `0`, and the storage view shows the same disk assigned to TopoLVM.
- An OSD has to move from one device class to another (for example from a CephFS class to an object-storage class). Adding `spec.storage.allowDeviceClassUpdate` to `CephCluster` and editing the OSD `deviceClass` there returns `unknown field "spec.storage.allowDeviceClassUpdate"`.

Work in the `rook-ceph` namespace; Ceph commands run in `deploy/rook-ceph-tools`.

Related articles: [A raw disk added to a Ceph device class does not become an OSD on ACP](./A_raw_disk_added_to_a_Ceph_device_class_does_not_become_an_OSD_on_ACP.md), [Ceph storage pool cannot be created or never finishes because the deployment created no OSD on ACP](./Ceph_storage_pool_cannot_be_created_or_never_finishes_because_the_deployment_created_no_OSD_on_ACP.md).

## Root Cause

### Cause 1: RuntimeError: Error: ["/dev/<device>"] not a block device

The disk that the OSD was prepared on has been taken by TopoLVM. Ceph cannot activate an OSD on a path that is no longer the block device it prepared, so the OSD init container fails on every start. The other OSDs stay `up`.

### Cause 2: unknown field "spec.storage.allowDeviceClassUpdate"

The `CephCluster` CRD of the installed version does not have `spec.storage.allowDeviceClassUpdate` (confirmed with Ceph 17.2.7, Quincy). The field is rejected and removed, and the OSD stays in the old class: `ceph osd tree` still shows the previous class name. The device class of an existing OSD is a property of the CRUSH map.

## Resolution

### Cause 1: RuntimeError: Error: ["/dev/<device>"] not a block device

Use this only when the OSD log contains `not a block device` and the storage view shows that disk assigned to TopoLVM. Give Ceph a different disk: retire the broken OSD and add a replacement disk. Do not take the disk back from TopoLVM while TopoLVM volumes live on it.

1. Confirm the signature and the OSD id:

```bash
kubectl -n rook-ceph get pods -o wide | grep rook-ceph-osd-
kubectl -n rook-ceph logs <osd-pod> --all-containers | grep -F 'not a block device'
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph get cephcluster -o yaml > cephcluster-before.yaml
```

2. Retire the OSD.

> **Warning:** `ceph osd out`, `ceph osd crush remove`, `ceph auth del`, and `ceph osd rm` retire this OSD id. Impact: any PG whose only remaining copy was on it loses that data. Precondition: the log signature and the TopoLVM assignment are both confirmed, `ceph pg dump` shows another `up` copy for the PGs that were on this OSD, and `cephcluster-before.yaml` is saved. Rollback: none for `osd rm`; add the replacement disk and let backfill restore redundancy.

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd out osd.<id>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush remove osd.<id>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph auth del osd.<id>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd rm osd.<id>
```

3. Add a replacement disk to the device class (Cause 2 of [A raw disk added to a Ceph device class does not become an OSD on ACP](./A_raw_disk_added_to_a_Ceph_device_class_does_not_become_an_OSD_on_ACP.md)). It has to be a block device that the storage view does not list under TopoLVM. Remove the old device entry from `spec.storage.nodes` of `CephCluster` so the operator does not try to prepare it again.

### Cause 2: unknown field "spec.storage.allowDeviceClassUpdate"

Do not set `allowDeviceClassUpdate` on this CRD. Change the class in the CRUSH map.

1. Record the current class:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush get-device-class osd.<id>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
```

2. Move the OSD.

> **Warning:** Removing and setting the device class makes CRUSH remap PGs; the cluster backfills, client IO rises, and a failure during backfill has less spare redundancy. Precondition: `ceph -s` is healthy enough to backfill (no full OSDs), and you saved the old class name. Rollback: run the same two commands with the saved class name. The class change itself does not delete data.

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush rm-device-class osd.<id>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush set-device-class <new-class> osd.<id>
```

3. Watch `ceph -s` until all PGs return to `active+clean`. The target pool must use a CRUSH rule that selects `<new-class>`, or the OSD does not receive that pool's data:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush rule dump
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool ls detail
```

## Diagnostic Steps

```bash
kubectl -n rook-ceph get pods -o wide | grep rook-ceph-osd-
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush class ls
```

On the node of the failing OSD:

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT /dev/<device>
```

- `Init:CrashLoopBackOff`, `not a block device` in the log, and the disk listed under TopoLVM (or `lsblk` shows TopoLVM logical volumes on it): Cause 1.
- `unknown field "spec.storage.allowDeviceClassUpdate"` when editing `CephCluster`, and `ceph osd tree` still shows the old class: Cause 2.
