---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# TopoLVM PVC expansion stays Resizing, spans two disks, or pods stay on the old node on ACP

## Issue

One of the following is seen with TopoLVM (LVM storage, CSI driver `topolvm.cybozu.com`, operands in `nativestor-system`) on Alauda Container Platform:

- After a PVC was expanded (for example from 10Gi to 40Gi), `lvs -o devices` shows its logical volume on two physical disks, and it looks as if the volume were split.
- A TopoLVM volume has to be expanded, or a PVC expansion stays in `Resizing` / expanding and never finishes. This often happens when several PVCs (for example the brokers of a three-replica Kafka) are given all remaining capacity of the device class at once.
- New TopoLVM nodes were added and have free capacity, but existing pods stay on the old nodes. After the old storage node was deleted, the pod stays `Pending` with an event such as `0/15 nodes are available: 3 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 4 node(s) didn't match Pod's node affinity/selector, 8 node(s) had volume node affinity conflict`.
- The expansion entry of a TopoLVM PVC looks grayed out in the console while editing the YAML works, or a second disk was added to a node and the existing PVC still cannot grow into it.

For rejected access modes, mount errors, and new claims that cannot be scheduled, see [TopoLVM PVC rejects an access mode, fails to mount, or cannot be scheduled on ACP](./TopoLVM_PVC_rejects_an_access_mode_fails_to_mount_or_cannot_be_scheduled_on_ACP.md).

## Root Cause

### Cause 1: an expanded LV shows extents on two physical disks

This is ordinary LVM. When the volume group was built from two physical volumes, `lvextend` takes free extents from either disk. The filesystem stays one filesystem. The pod does not have to move, and the extents do not have to be migrated onto one disk.

### Cause 2: a PVC has to be expanded, or the expansion stays in progress

Two different operations are called "expansion":

- Adding capacity to the device class (the pool): **Add Storage Device** on the Local Storage page, with a whole bare disk.
- Growing one claim: editing `spec.resources.requests.storage` of the PVC. The application manifest does not have to change. In a multi-replica application, every replica PVC is a separate volume and is expanded on its own.

An expansion stalls in two known situations:

- The new disk added to the pool still carries old signatures, so the pool did not actually grow.
- Several PVCs are enlarged in one step to consume all remaining published capacity. The volume group cannot satisfy every request plus LVM metadata, so one or more PVCs stay in `Resizing`. TopoLVM on ACP does not support a `spare-gb` setting to keep free extents in reserve.

### Cause 3: pods remain on the old node after new TopoLVM nodes are added

A TopoLVM PV has node affinity `topology.topolvm.cybozu.com/node` set to the node that holds its logical volume. The scheduler will not place the pod on another node, and TopoLVM does not copy logical volumes between nodes. Replacing a server and reusing its IP address does not move the old volume group onto the new machine. When the old node object has been deleted, the pod event shows `volume node affinity conflict`, because the volume still points at the deleted node.

### Cause 4: the expansion entry looks grayed out, or a second disk does not add capacity to the existing PVC

TopoLVM PVCs support expansion, from **Actions > Expand** on the PVC detail page or by editing the PVC YAML. A PVC is one logical volume in one volume group, so it can only grow by the free space of that volume group.

The platform supports several disks on one node. A disk added with **Storage Management > Local Storage > topolvm > Storage Devices > Add Storage Device** (`添加存储设备`, "Add Storage Device"; it asks for a node, a device class, and a storage device) can become a separate volume group instead of joining the volume group of the existing disk. In that case it serves new PVCs only and does not add capacity to existing ones.

## Resolution

### Cause 1: an expanded LV shows extents on two physical disks

No repair is needed. Confirm that the volume group contains both disks and leave the logical volume where LVM placed it:

```bash
vgs --units g
pvs --units g
lvs -o lv_name,vg_name,lv_size,devices --units g <vg-name>
```

Do not run `pvmove` to make the layout look tidier. It is a long exclusive operation on the volume group and is not required.

### Cause 2: a PVC has to be expanded, or the expansion stays in progress

1. To grow the pool, add a whole bare disk to the device class from **Storage Management > Local Storage**. This does not resize existing PVCs.
2. To grow a claim, edit its request. TopoLVM expands online; the pod does not need a restart.

> **Warning:** A larger PVC request allocates extents immediately and cannot be shrunk through Kubernetes. Precondition: `vgs` free space on the node that owns the volume is larger than the increase, and you are not giving the last free extents to several PVCs at once. Rollback: none for the allocated extents; setting the old request back does not shrink the logical volume.

```bash
kubectl patch pvc <pvc> -n <namespace> --type=merge \
  -p '{"spec":{"resources":{"requests":{"storage":"<new-size>"}}}}'
kubectl get pvc <pvc> -n <namespace> -o jsonpath='{.status.capacity.storage}{"\n"}{.status.conditions}{"\n"}'
```

3. Repeat for each replica PVC.
4. If the condition stays `Resizing`:
   - If the sum of the new sizes exceeds `vg_free` on the node, lower the requests, or add capacity to the device class first and then patch again. Expanding the device class first and re-running the resize is what clears the stall when several PVCs were given all remaining capacity.
   - If a disk was just added and the pool did not grow, clear the leftover signatures on that unused disk before you patch again.

Do not delete a PVC that still holds data to "unstick" an expansion.

### Cause 3: pods remain on the old node after new TopoLVM nodes are added

A pod cannot be rescheduled to a new node while it uses the old PV. To move it:

1. Copy the data at application level (dump and restore, or a replica rebuild) onto a new PVC provisioned on the new node.
2. Switch the workload to the new PVC.

The StorageClass option **PVC Reconstruction** rebuilds a claim on another node after a wait, and the rebuilt claim does not contain the original data. Do not use it as a migration tool.

A Velero backup of the claim is only useful if the copy is application-consistent. A single-node TopoLVM volume is not a portable disk, and re-adding a replacement server under the old IP does not attach the old volume group.

### Cause 4: the expansion entry looks grayed out, or a second disk does not add capacity to the existing PVC

1. Expand the PVC from **Actions > Expand** on its detail page, or edit `spec.resources.requests.storage` as in Cause 2. The same Warning applies.
2. Check which volume group holds the PVC and whether the new disk joined it:

```bash
kubectl get pv <pv> -o jsonpath='{.spec.csi.volumeHandle}{"\n"}'
lvs -o lv_name,vg_name,lv_size,devices | grep <volumeHandle>
pvs -o pv_name,vg_name,pv_size,pv_free
vgs
```

If `pvs` shows the new disk in a different volume group, it only serves new PVCs of the device class that volume group belongs to.

To give existing PVCs more room on a node whose TopoLVM disk is a virtual disk or a LUN, grow that disk in place and run `pvresize` on it. This enlarges the volume group that already holds the PVCs; see [TopoLVM device class capacity does not change after the underlying disk is expanded on ACP](./TopoLVM_device_class_capacity_does_not_change_after_the_underlying_disk_is_expanded_on_ACP.md). Adding another disk helps only new PVCs. In both cases, each PVC is then expanded on its own as in Cause 2.

## Diagnostic Steps

```bash
kubectl get pvc <pvc> -n <namespace> -o yaml
kubectl describe pvc <pvc> -n <namespace>
kubectl get pv <pv> -o jsonpath='{.spec.csi.driver}{"\n"}{.spec.nodeAffinity}{"\n"}'
kubectl get pod <pod> -n <namespace> -o jsonpath='{.spec.nodeName}{"\n"}{.status.phase}{"\n"}'
```

- `lvs -o devices` lists two physical disks of one volume group for the expanded LV: Cause 1.
- `FileSystemResizePending`, a long `Resizing` condition, or several PVCs stuck expanding after they were given all remaining capacity: Cause 2. Compare the requested increase with `vgs` free space on the node.
- The pod is `Pending` with `volume node affinity conflict`, or the PV node affinity names a node that no longer exists or is not the new node: Cause 3.
- A grayed-out expansion entry, or a second disk that `pvs` shows as a separate volume group: Cause 4.
- `did not have enough free storage` on a new claim after a disk was moved to a new device class is a scheduling problem; see the access-mode and scheduling article linked in the Issue.

## Related Information

- [TopoLVM capacity stays full after PVCs are deleted on ACP](./TopoLVM_capacity_stays_full_after_PVCs_are_deleted_on_ACP.md)
- [TopoLVM thin provisioning, over-provisioned capacity, and pod IOPS limits on ACP](./TopoLVM_thin_provisioning_over-provisioned_capacity_and_pod_IOPS_limits_on_ACP.md)
