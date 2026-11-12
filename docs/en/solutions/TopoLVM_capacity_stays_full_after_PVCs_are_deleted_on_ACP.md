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

# TopoLVM capacity stays full after PVCs are deleted on ACP

## Issue

The Local Storage page, or a node capacity alert, still shows a TopoLVM device class as full on Alauda Container Platform:

- PVCs and PVs were deleted, the PVs show as pending reclaim, and `vgs` free space did not come back. Sometimes the logical volume was deleted on the host with `lvremove` and the page still did not change.
- The PVCs and PVs are gone, a search by their UUID finds no PVC, and the space still shows as used.
- One node sits at the alert threshold while another TopoLVM node on the same cluster is mostly free.
- The TopoLVM capacity alert stays firing after a NAS was expanded and `df` on the NAS mount already dropped.
- The Local Storage page shows `0/0` capacity while a test pod mounts a TopoLVM volume normally.
- A workload deployment (for example GitLab) stays on Deploying and never finishes.

How TopoLVM counts capacity: published capacity is the volume group size minus the logical volumes the driver still accounts for. It is not `df` inside a pod. A 500Gi PVC consumes 500Gi of schedulable capacity even when its filesystem is almost empty, and deleting files inside the container does not shrink the logical volume. The storage-node usage percentage is the sum of the PVC requested sizes. The StorageClass reclaim policy decides whether deleting a PVC also deletes its logical volume.

This describes a thick device class. A thin device class (`thinPoolConfig` in `TopolvmCluster`) publishes over-provisioned capacity, and its real limit is the thin pool's data usage on the node; see [TopoLVM thin provisioning, over-provisioned capacity, and pod IOPS limits on ACP](./TopoLVM_thin_provisioning_over-provisioned_capacity_and_pod_IOPS_limits_on_ACP.md).

## Root Cause

### Cause 1: Bound TopoLVM PVs still reserve the capacity

`kubectl get pv` still shows `Bound` volumes of driver `topolvm.cybozu.com` on the node that looks full, and their pods or StatefulSets are running. The page is correct: those volumes are the workload.

A node at the alert threshold while another TopoLVM node is much lower is the same accounting, split unevenly across nodes. If the sum of PVC requests on the alerting node matches the reported usage, the usage is expected. TopoLVM is local storage, so restarting a pod does not move it to an emptier node.

### Cause 2: PV Released with reclaim policy Retain, LogicalVolume still present

The PVC is gone, the PV phase is `Released`, and `persistentVolumeReclaimPolicy` is `Retain`. With Retain, Kubernetes does not call CSI `DeleteVolume` when the PVC is removed, so a `LogicalVolume` object with the same name as the PV still exists and `lvs` still shows the LV. The console lists such PVs as pending reclaim. A StorageClass created with reclaim policy Retain leaves one of these behind for every deleted PVC. Running `lvremove` on the host without deleting the API objects does not update the page.

Example from `kubectl get pv`:

```text
NAME          CAPACITY  RECLAIM POLICY  STATUS    CLAIM                    STORAGECLASS
pvc-<uid-1>   30Gi      Retain          Released  <namespace>/<pvc-name>   sc-topolvm
pvc-<uid-2>   5Gi       Retain          Released  <namespace>/<pvc-name>   sc-topolvm
```

### Cause 3: spare-gb is not a supported parameter

TopoLVM on ACP (confirmed on ACP 4.3 with TopoLVM 4.3.6) does not accept a `spare-gb` parameter to make the scheduler keep free extents. There is no values key that turns it on.

### Cause 4: the capacity alert stays firing after NAS usage drops

The TopoLVM capacity alert reports space allocated by the TopoLVM device class. It does not measure the bytes used inside a PVC or the utilization of a NAS export. Expanding a NAS changes the NAS `df` number and not the device-class allocation the alert uses.

### Cause 5: Local Storage capacity shows 0/0 because Prometheus is not installed

The TopoLVM pods are Running and a test claim mounts, but the Local Storage page shows `0/0`. Prometheus is not installed on the platform. Once Prometheus is installed, the capacity figures are displayed; storage itself was never affected.

### Cause 6: a deployment stays on Deploying because one component's storage request is larger than TopoLVM can allocate

One component asks for more storage than the free capacity of the device class (for example the Gitaly component of GitLab), so that volume is never created and the deployment never finishes.

### Cause 7: LogicalVolume objects remain with no matching PV

The PVC and PV were deleted, but `kubectl get logicalvolumes -o wide` still lists `LogicalVolume` objects whose names match no PV. Read with `-o yaml`, such an object shows `apiVersion: topolvm.cybozu.com/v1`, finalizer `topolvm.cybozu.com/logicalvolume`, `size` and `currentSize`, a `volumeID`, and the `nodeName`. On that node `lvs | grep <volumeID>` still shows the LV (attributes `-wi-a-----`), while `lsblk | grep <volumeID>` shows no mount point. The orphaned objects keep the LVs allocated. Why they were not removed with the PVs is not known.

## Resolution

### Cause 1: Bound TopoLVM PVs still reserve the capacity

Do not delete Bound PVs to change the graph. Either add another bare disk to the device class, or delete the workload that owns the claim; the claim then follows the reclaim policy. With `Delete`, removing the PVC removes the PV and the LogicalVolume, and the space returns. With `Retain`, removing the PVC turns the volume into Cause 2.

List the TopoLVM volumes and their owners before deciding:

```bash
kubectl get pv -o json | jq -r '
  .items[]
  | select(.spec.csi.driver=="topolvm.cybozu.com")
  | [.metadata.name, .status.phase, .spec.persistentVolumeReclaimPolicy, .spec.capacity.storage,
     ((.spec.claimRef.namespace // "") + "/" + (.spec.claimRef.name // "")),
     (.spec.nodeAffinity.required.nodeSelectorTerms[]?.matchExpressions[]?
       | select(.key=="topology.topolvm.cybozu.com/node") | .values[0])]
  | @tsv'
kubectl get pod -A -o json | jq -r --arg NS "<namespace>" --arg PVC "<pvc>" '
  .items[]
  | select(.metadata.namespace==$NS)
  | select(.spec.volumes[]? | .persistentVolumeClaim.claimName==$PVC)
  | [.metadata.namespace, .metadata.name, .spec.nodeName, .status.phase]
  | @tsv'
```

On the node, compare with LVM. A large LV with no Bound PV is Cause 2 or Cause 7:

```bash
vgs --units g -o vg_name,pv_count,lv_count,vg_size,vg_free
lvs -a --units g -o lv_name,vg_name,lv_size,lv_attr,pool_lv,origin,data_percent,metadata_percent --sort=-lv_size
```

To move a pod to a less-used node, its PVC has to be deleted and a new one provisioned on the other node, with the data copied by the application.

### Cause 2: PV Released with reclaim policy Retain, LogicalVolume still present

A cleanup candidate meets all of these: phase `Released`, policy `Retain`, the PVC in `claimRef` is gone, and no Pod or StatefulSet references the claim. Anything still `Bound` is Cause 1.

> **Warning:** Deleting the PV and the `logicalvolumes.topolvm.cybozu.com` object of the same name deletes the volume and its data. Precondition: all candidate conditions above are met, and a backup exists if anyone might need the files. Rollback: none. `lvremove` on the host is not a substitute and does not update the page.

1. Save both objects, then delete them. The LogicalVolume name equals the PV name:

```bash
kubectl get pv <pv-name> -o yaml > /tmp/<pv-name>.before.yaml
kubectl get logicalvolumes.topolvm.cybozu.com <pv-name> -o yaml > /tmp/<pv-name>.lv.before.yaml
kubectl delete logicalvolumes.topolvm.cybozu.com <pv-name>
kubectl delete pv <pv-name>
```

The expected output includes `logicalvolume.topolvm.cybozu.com "<pv-name>" deleted`. Deleting the LogicalVolume first and then the PV, or the other way around, ends with both gone.

2. On the node named by `topology.topolvm.cybozu.com/node`, `lvs | grep <volumeHandle>` lists the LV before the delete and prints nothing after it. `spec.csi.volumeHandle` in the PV is the LV name.
3. Repeat per candidate, then check `vgs` and the Local Storage page. The page can show the old number for several minutes after the objects and the LV are gone.

If the LV is already gone from the host but the API objects remain, still delete the PV and the LogicalVolume. If the PVC and PV were already deleted, find the LogicalVolume by the PV name and delete it the same way:

```bash
kubectl get logicalvolume | grep <pv-name>
kubectl delete logicalvolume <pv-name>
```

Never run `kubectl delete pv --all`, and never use this sequence on a Bound PV.

### Cause 3: spare-gb is not a supported parameter

Do not add `spare-gb` to the StorageClass, the `TopolvmCluster`, or a ModulePlugin `valuesOverride`; it is not honored. Keep free extents by not assigning the whole volume group to PVCs. Several expansions that together request all remaining capacity will stall; that is a sizing limit. Add a disk when the device class is really out of extents.

### Cause 4: the capacity alert stays firing after NAS usage drops

Judge capacity from the device-class allocation and the PVC requests, not from the NAS percentage:

```bash
df -hT <nas-mount>
vgs --units g
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm \
  -o jsonpath='{.status.nodeStorageState}' | jq .
```

If the device class needs more space, expand the node disk or add a disk to the device class. Expanding the NAS does not clear this alert. If the disk was already grown in the hypervisor and the pool did not follow, see [TopoLVM device class capacity does not change after the underlying disk is expanded on ACP](./TopoLVM_device_class_capacity_does_not_change_after_the_underlying_disk_is_expanded_on_ACP.md).

### Cause 5: Local Storage capacity shows 0/0 because Prometheus is not installed

Use this only when the TopoLVM pods are Running, a test claim mounts, and the page shows `0/0`. Confirm that Prometheus is not installed, then install it on the platform. The capacity figures return; no TopoLVM object has to change.

### Cause 6: a deployment stays on Deploying because one component's request is larger than TopoLVM can allocate

Compare the component's storage request with the free capacity, lower that request to a size the pool can provision, and deploy again. Do not delete unrelated PVCs to force the original size through.

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm \
  -o jsonpath='{.status.nodeStorageState}' | jq .
vgs --units g
```

### Cause 7: LogicalVolume objects remain with no matching PV

1. List LogicalVolume names with no PV of the same name, and read their node and volume ID:

```bash
comm -23 \
  <(kubectl get logicalvolumes.topolvm.cybozu.com -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | sort) \
  <(kubectl get pv -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | sort)
kubectl get logicalvolume <lv-object> -o jsonpath='{.spec.nodeName}{" "}{.status.volumeID}{" "}{.spec.size}{"\n"}'
kubectl get volumeattachment | grep <volumeID>
```

2. On that node, `lvs | grep <volumeID>` shows the LV that still holds the space, and `lsblk | grep <volumeID>` shows whether anything mounts it.

> **Warning:** Deleting the LogicalVolume object lets TopoLVM delete the LV on the node; its data is gone. Precondition: no PV with the same name exists, no VolumeAttachment or mount references the `volumeID`, and the object is saved. Rollback: none for the data.

```bash
kubectl get logicalvolume <lv-object> -o yaml > /tmp/<lv-object>.yaml
kubectl delete logicalvolume <lv-object>
```

3. Repeat per orphan. After the orphans are deleted, the TopoLVM capacity displays normally.

## Diagnostic Steps

```bash
kubectl get sc -o custom-columns='NAME:.metadata.name,PROV:.provisioner,RECLAIM:.reclaimPolicy,BINDING:.volumeBindingMode'
kubectl get pv | grep -E 'topolvm|Released|Bound'
kubectl get logicalvolumes.topolvm.cybozu.com
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm \
  -o jsonpath='{.status.nodeStorageState}' | jq .
```

- The provisioner must be `topolvm.cybozu.com`; a full Ceph pool is a different product.
- If the class has `thinPoolConfig`, check `data_percent` and `metadata_percent` of the thin pool in `lvs` on the node before reading the page figure.
- `WaitForFirstConsumer` with a `Pending` PVC and no pod is not full capacity; the claim has not been provisioned yet.
- Bound PVs whose requests add up to the usage: Cause 1. `Released` + `Retain`: Cause 2. A `spare-gb` request: Cause 3. Alert still firing after a NAS `df` drop: Cause 4. `0/0` with healthy pods: Cause 5. A deployment stuck on Deploying with one oversized request: Cause 6. LogicalVolume objects with no PV of the same name: Cause 7.

## Related Information

- [TopoLVM PVC expansion stays Resizing, spans two disks, or pods stay on the old node on ACP](./TopoLVM_PVC_expansion_stays_Resizing_spans_two_disks_or_pods_stay_on_the_old_node_on_ACP.md)
- [TopoLVM PVC rejects an access mode, fails to mount, or cannot be scheduled on ACP](./TopoLVM_PVC_rejects_an_access_mode_fails_to_mount_or_cannot_be_scheduled_on_ACP.md)
