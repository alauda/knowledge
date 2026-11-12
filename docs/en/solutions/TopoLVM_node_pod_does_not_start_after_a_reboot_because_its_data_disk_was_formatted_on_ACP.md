---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# TopoLVM node pod does not start after a reboot because its data disk was formatted on ACP

## Issue

After a kernel upgrade or a node reboot on Alauda Container Platform, the TopoLVM pod on that node does not start. Workloads whose PVCs live on the node cannot mount, and new TopoLVM volumes are not created there.

The `driver-registrar` container of the node's `topolvm-node` pod in `nativestor-system` waits for the CSI socket and gives up:

```text
"Still connecting" address="unix:///run/topolvm/csi-topolvm.sock"
"Error connecting to CSI driver" err="context deadline exceeded"
```

The previous log of the `lvmd` container (`/lvmd --config=/etc/topolvm/lvmd.yaml --container=true`) loads the configuration with `socket_name="/run/topolvm/lvmd.sock"` and exits with `not found` / `Error: not found`.

On the node, `pvs`, `vgs`, and `lvs` print nothing for the data disks, `pvscan` prints `No matching physical volumes found`, and `lsblk -f` shows a filesystem (for example `xfs`) on the disk TopoLVM used, with no `LVM2_member` anywhere.

The same `Error: not found` while `pvs` still lists the data disk is a different problem; see [TopoLVM lvmd exits with should have at least one device-class or Error: not found on ACP](./TopoLVM_lvmd_exits_with_should_have_at_least_one_device-class_or_Error_not_found_on_ACP.md).

## Root Cause

### Cause 1: lvmd Error: not found, empty pvs and vgs, and the TopoLVM data disk now carries a filesystem

The LVM physical volume, the volume group, and the logical volumes TopoLVM used on the node no longer exist, because the data disk was formatted. `lvmd` cannot find any volume group named in `lvmd.yaml` and exits, so the CSI socket `/run/topolvm/csi-topolvm.sock` is never created and `driver-registrar` times out.

A typical way this happens: the node does not come up cleanly during the reboot after a kernel upgrade, and a disk is formatted to bring it back (for example as `/var/lib/containerd`). Kernel device names such as `sdb` and `sdc` can swap between boots, so the disk formatted as `sdb` may be the disk TopoLVM used before the reboot. The LVM data on the formatted disk is lost.

A loaded device-mapper (`lsmod | grep dm` lists `dm_mod`) and the new kernel are not the fault; the missing LVM metadata is.

## Resolution

### Cause 1: lvmd Error: not found, empty pvs and vgs, and the TopoLVM data disk now carries a filesystem

Use this only when all of these hold on the node: `lvmd` ends with `Error: not found`; `pvs`, `vgs`, and `lvs` show no TopoLVM physical volume or volume group; `pvscan` prints `No matching physical volumes found`; and `lsblk -f` shows a filesystem instead of `LVM2_member` on the disk TopoLVM used. Ask whether anyone formatted or wiped a disk on that node after the reboot.

The TopoLVM volumes that lived on that disk are gone and cannot be recovered in place. Plan to restore those applications from their own backups or replicas.

1. Work out which physical disk TopoLVM expects and what is on each disk now. Kernel names can change between boots; the device paths in `TopolvmCluster` may be stable `/dev/disk/by-id/...` paths.

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm -o yaml > /tmp/topolvmcluster.before.yaml
grep -A 8 "nodeName: <node>" /tmp/topolvmcluster.before.yaml
```

On the node:

```bash
ls -l /dev/disk/by-id/ | grep -v part
lsblk -f
findmnt -o TARGET,SOURCE,FSTYPE | grep -E '/dev/sd|/dev/vd|/dev/nvme'
```

A disk that now holds a mounted filesystem the node needs (for example `/var/lib/containerd`) is not a candidate for TopoLVM.

2. List the claims that the removal will delete:

```bash
kubectl get pv -o json | jq -r --arg NODE "<node>" '
  .items[]
  | select(.spec.csi.driver=="topolvm.cybozu.com")
  | select(.spec.nodeAffinity.required.nodeSelectorTerms[]?.matchExpressions[]?
      | select(.key=="topology.topolvm.cybozu.com/node") | .values[]? == $NODE)
  | [.metadata.name, .status.phase, .spec.claimRef.namespace, .spec.claimRef.name]
  | @tsv'
```

> **Warning:** The removal sequence scales `topolvm-operator` to 0, deletes every TopoLVM PVC, PV, and LogicalVolume pinned to this node, and removes the node from `TopolvmCluster`. Workloads using those claims stop until new claims are created. Precondition: this cause is confirmed, so the logical volumes behind those objects are already gone, and the application owners agree to recreate their volumes. Rollback: none for the deleted claims; restore the node element from `/tmp/topolvmcluster.before.yaml` to undo the spec edit.

3. Remove the node from TopoLVM with the sequence in [Removing a TopoLVM storage node or releasing its disks on ACP](./Removing_a_TopoLVM_storage_node_or_releasing_its_disks_on_ACP.md), Cause 1.
4. Add the node back, from **Storage Management > Local Storage > Storage Devices > Add Storage Device**, or by restoring the node's element with `kubectl -n nativestor-system edit topolvmclusters.topolvm.cybozu.com topolvm`. Select the data disk by its stable `/dev/disk/by-id/` path and check it against step 1: it must not be the disk that now holds a mounted filesystem. If the page does not offer the disk because it still carries the filesystem from the format, the leftover signature has to be cleared first; confirm with `lsblk -f` that the disk is the intended, unmounted one before wiping anything.
5. Verify:

```bash
kubectl -n nativestor-system get pod -o wide | grep <node>
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm \
  -o jsonpath='{.status.nodeStorageState}' | jq .
```

The prepare pod for the node finishes `Completed`, `topolvm-node` is Running with all containers ready, and the node's class is Ready. Then let the affected workloads create new PVCs and restore their data.

To prevent this: before formatting or wiping a disk on a TopoLVM node, especially after a reboot, check it with `lsblk -f` and `ls -l /dev/disk/by-id/`. An `LVM2_member` signature means it is a TopoLVM physical volume. Using `/dev/disk/by-id/` paths in `TopolvmCluster` also protects against kernel name changes; see [TopoLVM storage breaks when VM disk names change: use /dev/disk/by-id paths in TopolvmCluster on ACP](./TopoLVM_storage_breaks_when_VM_disk_names_change_use_devdiskby-id_paths_in_TopolvmCluster_on_ACP.md).

## Diagnostic Steps

```bash
kubectl -n nativestor-system get pod -o wide | grep topolvm-node
kubectl -n nativestor-system logs <topolvm-node-pod> -c driver-registrar --tail=50
kubectl -n nativestor-system logs <topolvm-node-pod> -c lvmd --previous --tail=50
```

On the node:

```bash
uname -r
pvs
vgs
lvs -a
pvscan
lsblk -f
```

- `driver-registrar` timing out on `/run/topolvm/csi-topolvm.sock` only says the node plugin never became ready; read the `lvmd` log next.
- `Error: not found` with empty `pvs`, `vgs`, and `lvs`, `No matching physical volumes found` from `pvscan`, and a filesystem on the disk TopoLVM used: Cause 1.
- `Error: not found` while `pvs` still lists the data disk: see the article linked in the Issue.
