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

# TopoLVM device class capacity does not change after the underlying disk is expanded on ACP

## Issue

A disk that TopoLVM already uses was expanded in place (a virtual disk grown in the hypervisor, or a LUN grown on the array), and the TopoLVM device class on Alauda Container Platform still shows the old capacity. Typical signs:

- The **Storage Device** tab shows the expanded block device (for example 750 Gi), while the logical-pool view keeps the previous capacity of the device class (for example 500 Gi on `hdd`).
- `lsblk` on the node shows the new size, while `pvs` and `vgs` still show the old one. For example, `lsblk` shows `vdb` at `310G`, `pvs` shows `/dev/vdb` in the TopoLVM volume group with PSize `<200.00g` and PFree `1020.00m`, and `vgs` shows the volume group at VSize `<200.00g`.
- The only report is "the disk is full and the PVC cannot be expanded". For example a ZooKeeper volume filled up, its PVC expansion did not succeed, the device class showed `400/500 Gi` on each node, and `lsblk -l` showed `sdb` at `1000G`.

The same question also comes up before expanding: on a virtual-machine node with one raw disk for TopoLVM, should the disk be grown in the IaaS layer, or should another disk be added? Growing the existing disk followed by `pvresize` adds the capacity to the volume group that already holds the PVCs. A disk added with **Add Storage Device** can become a separate volume group and then serves only new PVCs.

This article covers only a disk that is already a physical volume of a TopoLVM device class. Growing a single PVC is covered in [TopoLVM PVC expansion stays Resizing, spans two disks, or pods stay on the old node on ACP](./TopoLVM_PVC_expansion_stays_Resizing_spans_two_disks_or_pods_stay_on_the_old_node_on_ACP.md).

## Root Cause

### Cause 1: lsblk shows the new disk size, pvs and vgs still show the old size

TopoLVM is built on LVM and publishes capacity from the volume group. When the block device under an existing physical volume grows, the LVM physical-volume metadata keeps the old size until `pvresize` is run on that device. The volume group, and therefore the TopoLVM device class, keep the old size too. TopoLVM does not run `pvresize` for an in-place disk grow; the PV has to be resized by hand. Adding a new disk to the device class is the path TopoLVM handles itself.

## Resolution

### Cause 1: lsblk shows the new disk size, pvs and vgs still show the old size

Use this only when `lsblk` is larger than `pvs` for the same path, and that path is a physical volume of the device class that shows the old capacity.

1. Compare the sizes on the node that owns the disk:

```bash
lsblk -o NAME,PATH,SIZE,TYPE /dev/<disk>
pvs --units g -o pv_name,pv_size,pv_free,vg_name /dev/<disk>
vgs --units g
```

> **Warning:** `pvresize` updates the LVM physical-volume metadata so the volume group includes the extents the hypervisor added. Existing logical volumes stay in place. Precondition: the `lsblk` size is larger than the `pvs` size for this path, the path belongs to the device class that shows the old capacity, and the hypervisor or array grow has finished. Rollback: none; do not try to shrink the physical volume afterwards.

2. Resize the physical volume and confirm that the volume group grew:

```bash
pvresize /dev/<disk>
pvs --units g -o pv_name,pv_size,pv_free,vg_name /dev/<disk>
vgs --units g
```

Run `pvresize` once per grown physical volume, on the node that owns it. After that, the logical-pool capacities on the Local Storage page update.

3. If the TopoLVM capacity still shows the old size after `pvresize`, restart that node's `topolvm-node` pod.

> **Warning:** Deleting the `topolvm-node` pod pauses new mounts and capacity reporting on that node until the replacement is Ready. Mounts that already succeeded stay mounted. Precondition: `pvresize` has succeeded on this node and the capacity has not updated. Rollback: none needed; the pod is recreated.

```bash
kubectl -n nativestor-system get pod -o wide | grep topolvm-node | grep <node>
kubectl -n nativestor-system delete pod <topolvm-node-pod>
```

4. Expand the PVCs again. `pvresize` does not grow existing PVCs by itself; each PVC is expanded by editing `spec.resources.requests.storage`. In the ZooKeeper example, `pvresize /dev/sdb`, a `topolvm-node` restart, and a new PVC expansion let the expansion succeed, and the pods returned to `Running`.

## Diagnostic Steps

1. On the storage node, compare the block device with the LVM view of the same device:

```bash
lsblk /dev/<disk>
pvs /dev/<disk>
vgs <vg-name>
```

Example (shortened):

```text
NAME SIZE TYPE
vdb  310G disk

PV       VG             PSize    PFree
/dev/vdb <topolvm-vg>   <200.00g 1020.00m

VG            #PV #LV VSize    VFree
<topolvm-vg>    1  13 <200.00g 1020.00m
```

2. `lsblk` larger than `PSize` is Cause 1. A PVC expansion that fails while the device class shows less than the disk size `lsblk` reports is the same cause. Equal sizes mean the grow has not reached the node, or a different disk was expanded.

3. After `pvresize`, check the device class capacity:

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm \
  -o jsonpath='{.status.nodeStorageState}' | jq .
```

## Related Information

- [TopoLVM capacity stays full after PVCs are deleted on ACP](./TopoLVM_capacity_stays_full_after_PVCs_are_deleted_on_ACP.md): device-class usage is the sum of PVC requests.
