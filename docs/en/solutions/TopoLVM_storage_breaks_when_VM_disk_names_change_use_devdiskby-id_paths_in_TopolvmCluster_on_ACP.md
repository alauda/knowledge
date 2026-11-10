---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# TopoLVM storage breaks when VM disk names change: use /dev/disk/by-id paths in TopolvmCluster on ACP

## Issue

The cluster nodes are virtual machines, and TopoLVM (LVM storage) uses their virtual disks. When a VM is rebuilt, its disks can come back under different kernel names (for example `/dev/sdb` becomes `/dev/sdc`, or `/dev/vdb` becomes `/dev/vdc`), and TopoLVM storage on that node becomes abnormal. The question is whether disks can be added to TopoLVM by a stable path such as `/dev/disk/by-id/...` instead.

## Root Cause

The disk picker in the console fills the TopolvmCluster with kernel device names such as `/dev/sdb` or `/dev/vdb`. Kernel device names are assigned at boot in discovery order and are not guaranteed to stay the same when a VM is rebuilt or its disks are reattached. After a rename, `spec.storage.deviceClasses[].classes[].devices[].name` in the TopolvmCluster no longer points to the disk that holds the volume group.

Using kernel names is a console behavior, not a backend limitation. The TopolvmCluster accepts a `/dev/disk/by-id/...` path in `devices[].name`, both when a TopolvmCluster is created and when an existing one is edited in YAML.

Pick the right kind of stable path:

- Use the `by-id` link that is derived from the disk serial number or WWN (prefixes `virtio-`, `wwn-`, `scsi-`, `nvme-`).
- Do not use `/dev/disk/by-path/...`. It follows the PCI slot and changes when the slot changes, so it does not solve this problem.
- A `by-id` link is only as stable as the disk serial. If a rebuild also changes the serial, the `by-id` link changes too. Keep the disk serial unchanged on the virtualization side.

## Resolution

### New TopolvmCluster

Write the TopolvmCluster in YAML and set each `devices[].name` to the serial-based `/dev/disk/by-id/...` path of the disk instead of the kernel name.

### Existing TopolvmCluster: switch one node to by-id paths

The switch is safe only when the path points to the same disk that is already in the volume group, and only when the change replaces paths without adding or removing disks.

> **Warning:** Do not add or remove disks in the same edit as the path change. When the number of devices changes, the volume-group shrink logic compares device paths as strings and can treat the existing physical volume (still known by its old kernel name) as a disk to remove. Do one node at a time. Save the TopolvmCluster first. Rollback: apply the saved YAML, which puts the kernel names back.

1. Save the current TopolvmCluster:

   ```bash
   kubectl -n nativestor-system get topolvmcluster
   kubectl -n nativestor-system get topolvmcluster <name> -o yaml > /tmp/topolvmcluster-<name>.yaml
   ```

2. On the node, confirm that the `by-id` link resolves to the disk that `pvs` reports for the volume group:

   ```bash
   ls -l /dev/disk/by-id/
   readlink -f /dev/disk/by-id/<disk-id>
   pvs -o pv_name,vg_name,pv_uuid
   ```

   The output of `readlink -f` must be the same device as the `pv_name` of the volume group, for example `/dev/vdb`.

3. Edit the TopolvmCluster and change only `devices[].name` of that node under `spec.storage.deviceClasses[].classes[]` from the kernel name to the `by-id` path:

   ```bash
   kubectl -n nativestor-system edit topolvmcluster <name>
   ```

4. Wait for the node's `topolvm-prepare-vg` run to finish and check its log. With an unchanged number of devices, the shrink step is skipped with the message `no need shrink vg for disk name change`, and the existing volume group and logical volumes are not touched:

   ```bash
   kubectl -n nativestor-system get pods -o wide | grep topolvm-prepare-vg
   kubectl -n nativestor-system logs <topolvm-prepare-vg-pod> | grep -i shrink
   ```

   The `lvmd.yaml` in the node's lvmd configuration needs no change. It records only the volume group name, not device paths.

5. Align the status with the spec. The TopolvmCluster status does not switch to the `by-id` path on its own. After `topolvm-prepare-vg` has finished, edit the node's ConfigMap in `nativestor-system` (named `lvmdconfig-<node-name>`). In its `status.json`, set `successClasses[].deviceStates[].name` to the same `by-id` path as in the spec, and leave `serial` unchanged. The controller syncs this status into `TopolvmCluster.status`.

   ConfigMap names are truncated for long node names, so match the ConfigMap by its `node-name` annotation:

   ```bash
   kubectl -n nativestor-system get cm -l topolvm/lvmdconfig=lvmdconfig \
     -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.node-name}{"\n"}{end}'
   kubectl -n nativestor-system get cm <lvmdconfig-cm> -o yaml > /tmp/<lvmdconfig-cm>.yaml
   kubectl -n nativestor-system edit cm <lvmdconfig-cm>
   ```

6. Repeat for the next node.

### Known side effect

On ACP 4.3.3, the storage performance monitoring page queries metrics by kernel device name. After a disk is switched to a `by-id` path, storage keeps working, but the performance page may show no data for that disk.

## Diagnostic Steps

1. See which device names the TopolvmCluster uses:

   ```bash
   kubectl -n nativestor-system get topolvmcluster <name> -o yaml | grep -n -A3 'devices:'
   ```

   Kernel names such as `/dev/sdb` or `/dev/vdb` mean that the node is exposed to renaming.

2. On an affected node, compare the configured name with the disk that LVM actually uses:

   ```bash
   pvs -o pv_name,vg_name,pv_uuid
   ls -l /dev/disk/by-id/ | grep -v part
   ```

   If the `pv_name` of the volume group differs from the name in the TopolvmCluster, the disk was renamed.

3. Check that the `by-id` link you plan to use is based on the serial and stays the same across a rebuild. Compare the link before and after a test rebuild, or check the serial that the virtualization platform assigns to the disk:

   ```bash
   lsblk -o NAME,SERIAL,WWN
   ```

   An empty `SERIAL` and `WWN` means that the disk has no serial-based `by-id` link. Set a serial on the virtualization side first.
