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

# TopoLVM PVC rejects an access mode, fails to mount, or cannot be scheduled on ACP

## Issue

A PVC on a TopoLVM StorageClass, or the pod that uses it, does not come up on Alauda Container Platform:

- The PVC stays `Pending` with `ProvisioningFailed` and `rpc error: code = InvalidArgument desc = unsupported access mode: MULTI_NODE_MULTI_WRITER`.
- The pod reports `FailedMount` / `MountVolume.SetUp failed` with `target device is already formatted with different filesystem: volume=<volume-id>, current=jmicron_raid_member, new=xfs`.
- Creating a pod fails with a scheduling error, and some nodes are already at their pod limit.
- Pods stay `Pending` with `0/N nodes are available: ... did not have enough free storage`, for example after a disk was removed from TopoLVM and added to a new device class, or the node's available TopoLVM space shows 0 although its device class is Ready.

Background: TopoLVM is node-local LVM, and the provisioner is `topolvm.cybozu.com`. The stock StorageClass on current clusters is `topolvm-hdd` (`csi.storage.k8s.io/fstype=xfs`, `topolvm.cybozu.com/device-class=hdd`); other clusters use another name such as `sc-topolvm`. `CSIDriver/topolvm.cybozu.com` uses `fsGroupPolicy: ReadWriteOnceWithFSType` and `attachRequired: false`. The stock class uses `volumeBindingMode: WaitForFirstConsumer`, so a PVC with no consuming pod stays `Pending` without a `ProvisioningFailed` event; that wait is not a storage failure.

## Root Cause

### Cause 1: unsupported access mode: MULTI_NODE_MULTI_WRITER

`spec.accessModes` is `ReadWriteMany` or `ReadOnlyMany`. A TopoLVM logical volume exists on one node only, and there is no shared backend behind the StorageClass, so the driver rejects every multi-node mode. Adding the annotation `cpaas.io/access-mode` with `ReadWriteOnce,ReadWriteMany` to the StorageClass does not change this: the annotation is saved and the driver still rejects the request. See also [TopoLVM rejects ReadWriteMany PVCs on Alauda Container Platform](./TopoLVM_rejects_ReadWriteMany_PVCs_on_Alauda_Container_Platform.md).

### Cause 2: target device is already formatted with different filesystem

The logical volume handed to kubelet still carries a foreign signature (for example leftover RAID metadata, reported as `current=jmicron_raid_member`) next to the real filesystem, so the node plugin refuses to mount or format it. The decisive sign is that two tools disagree about the same LV: `blkid -c /dev/null -o export <lv-path>` prints `TYPE=jmicron_raid_member`, while `lsblk -f` shows the same LV as `xfs` with a filesystem UUID. The xfs filesystem is intact; the `current=` value is the stale signature. This can show up when a pod is rebuilt (for example after an image change) and remounts an existing volume whose data is still needed.

### Cause 3: some nodes are at the pod limit and the other nodes have almost no TopoLVM space

The scheduler cannot place the new pod anywhere: the nodes with free TopoLVM capacity have already reached their maximum schedulable pod count (the standard scheduler message for this is `Too many pods`), and the nodes that still have pod slots have almost no free space in the TopoLVM device class.

### Cause 4: did not have enough free storage because no device class on the node has default: true

A StorageClass without the parameter `topolvm.cybozu.com/device-class` is served by the device class marked `default: true` on each node. If the node's class entry in `TopolvmCluster` (namespace `nativestor-system`) does not have `default: true`, TopoLVM finds no default device class on that node and treats its capacity as unavailable. The node then shows 0 available TopoLVM space and the scheduler reports `did not have enough free storage`, even though the cluster status looks healthy (`phase: Ready`, `failClasses: []`, the class in `successClasses` with `state: Ready` and `message: create successful`).

This happens, for example, after a disk is removed from TopoLVM and added to a new device class on a node, and the pods use the default StorageClass. The event often also lists `volume node affinity conflict`, a node affinity or selector miss, and the master taint; those lines alone are not this cause.

## Resolution

### Cause 1: unsupported access mode: MULTI_NODE_MULTI_WRITER

Recreate the PVC with `ReadWriteOnce` or `ReadWriteOncePod`. The access mode of an existing claim cannot be changed into one the driver accepts; create a new claim. Use the StorageClass name this cluster actually has:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <pvc>
  namespace: <namespace>
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: topolvm-hdd
  resources:
    requests:
      storage: 10Gi
```

`ReadWriteOnce` means one node, not one pod: two pods on the same node can mount the volume. A volume that must be mounted read-write from several nodes needs a shared storage class such as Ceph distributed storage. Editing `cpaas.io/access-mode` does not provide ReadWriteMany on TopoLVM.

### Cause 2: target device is already formatted with different filesystem

Use this only when the event contains `target device is already formatted with different filesystem`, `current=` is a foreign type (for example `jmicron_raid_member`), and `new=` is the filesystem the StorageClass asks for (for example `xfs`).

1. Find the logical volume. In the PV, `spec.csi.volumeHandle` is the LV name and `nodeAffinity` names the node:

```bash
kubectl get pv <pv> -o yaml
```

2. On that node, compare the views and list the signature offsets. The LV path is `/dev/<vg-name>/<volumeHandle>`; in `lsblk` the LV appears as `<vg-name>-<volumeHandle>` with each hyphen inside the names doubled.

```bash
lvs -o lv_name,lv_path,vg_name,lv_size | grep <volumeHandle>
blkid -c /dev/null -o export <lv-path>
lsblk -f | grep <first-8-characters-of-volumeHandle>
wipefs -n <lv-path>
```

`blkid -c /dev/null` bypasses the blkid cache. `wipefs -n` lists every signature with its byte offset. Note the offset of the line whose type matches `current=` only. The `xfs` line is the filesystem the pod must mount.

> **Warning:** `wipefs -o <offset>` erases the signature at that byte offset on `<lv-path>`. A wrong offset can destroy the filesystem the application needs. This is not `wipefs -a` and not a format. Precondition: the FailedMount text matches this cause, the offset belongs to the foreign type and not to `xfs`, the path is the LV of this PV, and a backup exists if the data cannot be rebuilt. Rollback: none for the erased bytes.

```bash
wipefs -o <offset> <lv-path>
```

After the foreign signature is cleared, the volume mounts and the pod recovers. If `wipefs -n` shows only the filesystem named by `new=`, there is nothing to clear; do not run `wipefs -o`.

### Cause 3: some nodes are at the pod limit and the other nodes have almost no TopoLVM space

1. Confirm both conditions before changing anything:

```bash
kubectl get node <node> -o jsonpath='capacity={.status.capacity.pods} allocatable={.status.allocatable.pods}{"\n"}'
kubectl get pods -A --field-selector spec.nodeName=<node> --no-headers | wc -l
kubectl describe pod <pod> -n <namespace> | grep -A 20 Events
```

On the nodes that still have pod slots, check TopoLVM free space with `vgs`.

2. Raise the maximum schedulable pod count (kubelet `maxPods`) on the nodes that reached the limit, using the node maintenance procedure your platform version documents. Raising it on the full nodes is what lets the pods schedule.
3. Confirm that allocatable pods increased and the `Pending` pods schedule:

```bash
kubectl get node <node> -o jsonpath='capacity={.status.capacity.pods} allocatable={.status.allocatable.pods}{"\n"}'
```

If the only nodes with free pod slots have a full TopoLVM device class, a new TopoLVM volume still cannot be placed there; that needs more device-class capacity.

### Cause 4: did not have enough free storage because no device class on the node has default: true

Use this only when the event includes `did not have enough free storage` (or the node shows 0 available TopoLVM space while its class is Ready), the node's class entry has no `default: true`, and the StorageClass in use names no device class (or is the default StorageClass after a disk move).

1. Check the StorageClass. An empty second line means it names no device class and relies on the default one:

```bash
kubectl get sc <storageclass> -o jsonpath='{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}{"\n"}{.parameters.topolvm\.cybozu\.com/device-class}{"\n"}'
```

2. Save the cluster object:

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm -o yaml > /tmp/topolvmcluster.before.yaml
```

> **Warning:** Editing `TopolvmCluster` changes which nodes the default device class schedules onto; a wrong `nodeName` marks a different node. Precondition: this cause is confirmed, the YAML is saved, and you change `default` only on the affected node's entry for the intended class. Rollback: set `default` back to `false` (or remove the field if it was absent) and save.

3. Edit the cluster object and, under `spec.storage.deviceClasses`, set `default: true` on the affected node's class. Keep the existing `devices` list:

```bash
kubectl -n nativestor-system edit topolvmclusters.topolvm.cybozu.com topolvm
```

```yaml
- nodeName: <node>
  classes:
    - className: <device-class>
      default: true
```

4. Check that the node's available space is no longer 0 and that the `Pending` PVCs bind and the pods start.

If that class must not become the default, create a new StorageClass whose `parameters` set `topolvm.cybozu.com/device-class: <device-class>`, and create new PVCs on it. Kubernetes does not allow the `parameters` of an existing StorageClass to be changed.

## Diagnostic Steps

When the only report is that a pod cannot be created, start with the scheduler event and the pod count per node:

```bash
kubectl describe pod <pod> -n <namespace> | grep -A 20 Events
kubectl get pods -A --field-selector=status.phase!=Succeeded,status.phase!=Failed -o custom-columns=NODE:.spec.nodeName --no-headers | sort | uniq -c
kubectl get nodes -o custom-columns=NAME:.metadata.name,PODS:.status.allocatable.pods
kubectl get pvc <pvc> -n <namespace> -o yaml
kubectl get sc <storageclass> -o yaml
kubectl describe csidriver topolvm.cybozu.com
```

- `ProvisioningFailed` with `MULTI_NODE_MULTI_WRITER`: Cause 1.
- A `Pending` PVC with `WaitForFirstConsumer` and no pod: waiting for a consumer, not a failure.
- `FailedMount` with `already formatted with different filesystem`: Cause 2.
- Some nodes have as many pods as allocatable pods while the others have little TopoLVM free space: Cause 3.
- `did not have enough free storage`, a StorageClass with no device-class parameter, and no `default: true` on the node's class: Cause 4.
- A pod already bound to a PV on an old or deleted node (`volume node affinity conflict`): see [TopoLVM PVC expansion stays Resizing, spans two disks, or pods stay on the old node on ACP](./TopoLVM_PVC_expansion_stays_Resizing_spans_two_disks_or_pods_stay_on_the_old_node_on_ACP.md), Cause 3.
