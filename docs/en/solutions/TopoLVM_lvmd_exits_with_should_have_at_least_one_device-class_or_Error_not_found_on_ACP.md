---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# TopoLVM lvmd exits with should have at least one device-class or Error: not found on ACP

## Issue

Storage on one node of Alauda Container Platform is abnormal, and the logs point at the TopoLVM node plugin. The `lvmd` container of `topolvm-node` in `nativestor-system` exits with one of these, or pods that should use that node stay `Pending` with no node they can schedule on:

```text
Error: should have at least one device-class
```

```text
lvmd info: "configuration file loaded: " device_classes="[0xc0005ff270 0xc0005ff2c0]" file_name="/etc/topolvm/lvmd.yaml" socket_name="/run/topolvm/lvmd.sock"
not found
Error: not found
```

The `lvmd-config` log of the operator can also report `node <node> all volume groups are not available` for several nodes. Restarting `topolvm-node` does not help.

Per-node lvmd settings are a ConfigMap in `nativestor-system`, named `lvmdconfig-<node>` or `lvmd-config-node-<node>` depending on the version; use the name `kubectl get cm -n nativestor-system` prints. The cluster object is `topolvmcluster/topolvm`.

Related articles: [TopoLVM device class or storage devices show Unavailable or Unknown on ACP](./TopoLVM_device_class_or_storage_devices_show_Unavailable_or_Unknown_on_ACP.md) (the device class was deleted after a reboot, or devices are shown unavailable); [TopoLVM node pod does not start after a reboot because its data disk was formatted on ACP](./TopoLVM_node_pod_does_not_start_after_a_reboot_because_its_data_disk_was_formatted_on_ACP.md) (`Error: not found` with no physical volume left on the disk).

## Root Cause

### Cause 1: the volume group name on the node is not the name in lvmd or in TopolvmCluster

On the node, `vgs` prints a volume group name that is not the name configured for that node, so `lvmd` has nothing to serve. A typical chain:

1. `kubectl logs -n nativestor-system <topolvm-node-pod> -c lvmd` loads `/etc/topolvm/lvmd.yaml` with `device_classes="[]"` and exits with `Error: should have at least one device-class`.
2. The `prepare-vg` container of the same pod skips other disks (for example `skipping device "nvme6n1" because it contains a filesystem "ext4"`), then logs `prepare-vg: start provision vg`, `prepare-vg: cm is existing check if need update`, `prepare-vg: device /dev/nvme1n1 is not available`, and `op-k8sutil: patching previous cm lvmdconfig-<node>`.
3. ConfigMap `lvmdconfig-<node>` then holds `device-classes: []` in `lvmd.yaml`. Its `status.json` lists the class as failed, with `vgName` `ssd-<uuid-A>`, the device in state `Offline`, and the message `disk may has filesystem or is not raw disk please check`.
4. On the node, `pvs` shows `/dev/nvme1n1` in a different volume group, `ssd-<uuid-B>`, and `lvs` shows that this group holds the active logical volumes of the existing PVCs.

The disk is not dirty. TopoLVM looks for `ssd-<uuid-A>`, finds the device used by `ssd-<uuid-B>`, marks it unavailable, and writes an empty device-class list.

### Cause 2: lvmd exits with Error: not found because the volume groups in lvmd.yaml do not exist on the node

The node's `lvmd.yaml` declares device classes whose `volume-group` names (`<class>-<uuid>`) are missing on the node. `vgs` lists only the operating-system groups, and `pvs` shows the data disks as physical volumes that belong to no volume group. `lvmd` cannot find the groups it was told to serve, so it exits. On a healthy TopoLVM node the same disks hold those volume groups.

### Cause 3: the volume group and thin pool on one node were wiped, so pods stay Pending

`topolvm-node` runs on several nodes. On one node the volume group and the logical volumes are gone and the data disk is bare. Pods stay `Pending` because no node can take them: the wiped node cannot provide TopoLVM capacity, and the healthy node already runs a replica that anti-affinity will not double up. After the volume group is recreated, the pods still fail, because their PVC objects exist while the logical volumes behind them were wiped.

## Resolution

### Cause 1: the volume group name on the node is not the name in lvmd or in TopolvmCluster

1. On the node, print the live volume group and its logical volumes. In the cluster, save the configured objects:

```bash
vgs
pvs -o pv_name,vg_name,pv_size
lvs -o lv_name,vg_name,lv_size,lv_attr <vg-name>
kubectl -n nativestor-system get cm -o name | grep -i lvmd
kubectl -n nativestor-system get cm lvmdconfig-<node> -o yaml > /tmp/lvmdconfig.before.yaml
kubectl -n nativestor-system get topolvmcluster topolvm -o yaml > /tmp/topolvmcluster.before.yaml
```

> **Warning:** A wrong volume group name makes `topolvm-node` look for a group that is not on the disk. Deleting Deployment `topolvm-node-<node>` recreates the node plugin and pauses new mounts on that node until it is Ready; mounts that already succeeded stay mounted. Precondition: `vgs` on this node shows the name you write, and both objects are saved. Rollback: restore the saved ConfigMap and cluster object, then delete the Deployment again so it reloads them.

2. Correct the ConfigMap first: `lvmd.yaml` and `status.json` must both describe the live volume group (`ssd-<uuid-B>` in the example). In `lvmd.yaml` the field is `volume-group`; the layout is:

```yaml
lvmd.yaml: |
  socket-name: /run/topolvm/lvmd.sock
  device-classes:
  - name: <class>
    volume-group: <live-vg-name>
    default: true
```

```bash
kubectl -n nativestor-system edit cm lvmdconfig-<node>
```

3. Correct `TopolvmCluster`: in the node's device class entry, set `volumeGroup` to the same live name. Leave devices that are not in this volume group alone.

```bash
kubectl -n nativestor-system edit topolvmcluster topolvm
```

4. Recreate the node plugin so it reloads the configuration:

```bash
kubectl -n nativestor-system delete deploy topolvm-node-<node>
```

5. Confirm:

```bash
kubectl -n nativestor-system get cm lvmdconfig-<node> -o jsonpath='{.data.lvmd\.yaml}{"\n"}{.data.status\.json}{"\n"}'
kubectl -n nativestor-system get pods -o wide | grep <node>
```

After the names match, the components return to Running and storage on the node recovers. In this cause, `disk may has filesystem or is not raw disk please check` refers to the TopoLVM volume group that holds the PVC data: do not wipe the disk.

### Cause 2: lvmd exits with Error: not found because the volume groups in lvmd.yaml do not exist on the node

Use this only when the `lvmd` log ends with `Error: not found`, every `volume-group` name in the node's `lvmd.yaml` is absent from `vgs`, and `pvs` shows the intended data disk as a physical volume with no volume group. If `pvs` prints no physical volume at all and `lsblk -f` shows a filesystem on the data disk, the disk was formatted; see the related article on a formatted data disk instead.

1. Read the names and the disks:

```bash
kubectl -n nativestor-system get cm <lvmd-configmap> -o jsonpath='{.data.lvmd\.yaml}{"\n"}'
vgs
pvs
lsblk /dev/<disk>
```

2. Take the class-to-disk mapping from the platform storage view or from a healthy node. The healthy node's volume group names carry a different UUID; type the names from this node's `lvmd.yaml`.

> **Warning:** `vgcreate` writes volume group metadata on `/dev/<disk>`. Precondition: this cause is confirmed, `pvs` shows `/dev/<disk>` with an empty VG column, `lvs` shows nothing on it, and the `volume-group` name you type is copied exactly from this node's `lvmd.yaml` for the class mapped to this disk. Rollback: `vgremove <vg-name>` while the new group still holds no logical volume.

3. Create one volume group per missing class on its disk, then restart the node plugin pod:

```bash
vgcreate <vg-name-from-lvmd.yaml> /dev/<disk>
vgs
kubectl -n nativestor-system delete pod <topolvm-node-pod>
```

TopoLVM then starts on the node. If the class uses a thin pool, the thin pool must exist as well (see Cause 3).

### Cause 3: the volume group and thin pool on one node were wiped, so pods stay Pending

Use this only when the node's data disk is already bare and the lvmd ConfigMap still describes the volume group and thin pool the node should have.

> **Warning:** Creating a volume group on the disk destroys whatever is still on it. Precondition: `lsblk` and `vgs` show the disk bare, the ConfigMap is the only source of the names, and you accept that the old data is not coming back. Rollback: none.

1. Recreate the volume group and the thin-pool logical volume so they match the names and the disk path already in the ConfigMap. If the ConfigMap does not contain those names, stop; do not invent new names. TopoLVM scheduling on the node returns once the thin pool matches the ConfigMap.
2. Delete the PVCs whose logical volumes were wiped and the stuck pods, so the workload creates new claims and rebuilds those replicas.

> **Warning:** Deleting a PVC drops the claim; with reclaim policy `Delete` the PV object goes too. Precondition: `lvs` on every node shows no LV for that claim, and the application can rebuild a replica. Rollback: none.

```bash
kubectl get pvc -n <namespace>
kubectl delete pvc -n <namespace> <pvc>
kubectl delete pod -n <namespace> <pod>
```

Anti-affinity against the replica still running on the healthy node is why the new pods cannot start until this node is usable again. Restore the node rather than placing both replicas on the surviving node.

## Diagnostic Steps

```bash
kubectl -n nativestor-system get pods -o wide
kubectl -n nativestor-system logs deploy/topolvm-node-<node> -c lvmd --tail=100
kubectl -n nativestor-system logs deploy/topolvm-node-<node> -c prepare-vg --tail=100
kubectl -n nativestor-system get cm lvmdconfig-<node> -o yaml
kubectl -n nativestor-system get topolvmcluster topolvm -o yaml
```

On the node:

```bash
pvs
vgs
lvs -a
```

- `Error: should have at least one device-class`, `lvmd.yaml` with `device-classes: []`, and `pvs` showing the device in a `<class>-<uuid>` volume group other than the `vgName` in `status.json`: Cause 1. Do not restart repeatedly; correct the names.
- `Error: not found` while `vgs` lacks the groups named in `lvmd.yaml` and `pvs` shows the data disk with an empty VG column: Cause 2. Compare names before running `vgcreate`.
- A bare disk where the ConfigMap still describes a volume group and thin pool, and pods `Pending`: Cause 3.
- `Error: not found` with empty `pvs` and a filesystem on the data disk: the formatted-disk article in Related articles.
