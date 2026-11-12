---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
---

# TopoLVM thin provisioning, over-provisioned capacity, and pod IOPS limits on ACP

## Issue

Questions and symptoms around TopoLVM thin provisioning on Alauda Container Platform 4.2:

- Can TopoLVM create thin-provisioned logical volumes, and how is that turned on?
- Can a pod's IOPS be capped with cgroups v2 and an `IOLimit` custom resource?
- After a thin device class was created, the StorageClass shows about twice the physical capacity (for example 6.4T while only a 3.5T disk is used).
- A PVC on a thin device class cannot be created (`ProvisioningFailed`), or an application writing to a thin volume fails with `No space left on device`, although the console shows plenty of capacity and a single disk looks big enough.

Thin provisioning here means LVM thin pools that TopoLVM is configured to use. It is not VDO deduplication under the volume group.

## Root Cause

### Cause 1: thin logical volumes are chosen with Provision Config when the TopolvmCluster is deployed

Thin-provisioned LVM is supported on ACP 4.2. It is selected with **Provision Config** when the `TopolvmCluster` is deployed: the **Provision Type** field offers `Thin` and `Thick`.

### Cause 2: pod IOPS limiting is not a supported TopoLVM feature

Limiting a pod's IOPS with cgroups v2 and an `IOLimit` custom resource is not supported by TopoLVM on the platform.

### Cause 3: capacity shows about double the disk size because the thin device class has overprovisionRatio 2

The device class has a `thinPoolConfig`, for example:

```yaml
thinPoolConfig:
  name: hdd-thin-pool
  overprovisionRatio: 2
  sizePercent: 90
```

On the node, `lvs` shows the thin pool LV (`hdd-thin-pool`) in the volume group `hdd-<uuid>`. With `overprovisionRatio: 2`, the capacity TopoLVM publishes is twice the physical pool size, so the StorageClass total is not wrong: it is thin over-provisioning.

### Cause 4: the thin pool on the selected node is full, so new volumes and writes fail

The published (over-provisioned) capacity is not physical space. What can actually be written depends on the thin pool's `Data%` and `Meta%` on the node the PVC is scheduled to. When the thin pool reaches its data limit, LVM cannot create new thin volumes there (`ProvisioningFailed` on the PVC), and writes to existing thin volumes in that pool fail (for example `No space left on device` in the application). The free space `vgs` shows outside the pool (the part not covered by `sizePercent`) cannot be used for thin volumes. For example: a pool of about 190g, three thin volumes with a combined virtual size of 240g, and `Data%` at `100.00`.

## Resolution

### Cause 1: thin logical volumes are chosen with Provision Config when the TopolvmCluster is deployed

In the console, open **Storage > Local Storage > Config local storage**, step **Create Cluster**, Storage Plan `TopoLVM`, namespace `nativestor-system`. In the storage entry, open **Provision Config** and set **Provision Type** to `Thin`. These parameters then appear:

| Parameter | Default |
|---|---|
| Over Provision Ratio | `2` |
| Size Percent | `90` |
| Metadata Size Calculation Policy | `Host` (other value: `Static`) |
| Chunk Size | none given |

Adjust them or keep the defaults. Thin is chosen at deploy time. No YAML field, ModulePlugin key, or procedure is documented for switching an existing thick device class to thin, or a thin class to thick; treat that as an open question for support rather than assuming either answer.

After a thin deploy, the volume group TopoLVM created contains a thin pool, and new volumes are allocated from it:

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm -o yaml
lvs -a -o lv_name,vg_name,lv_attr,pool_lv
```

### Cause 2: pod IOPS limiting is not a supported TopoLVM feature

There is no supported substitute: no `IOLimit` object, cgroup setting, or StorageClass parameter provides per-pod IOPS limits for TopoLVM volumes.

### Cause 3: capacity shows about double the disk size because the thin device class has overprovisionRatio 2

No repair is needed when the over-provisioning is intended. Physical writes are still limited by the thin pool, so monitor it on each node:

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm -o yaml | grep -B 2 -A 4 thinPoolConfig
lvs -o lv_name,vg_name,lv_size,data_percent,metadata_percent
```

### Cause 4: the thin pool on the selected node is full, so new volumes and writes fail

1. Find the node the PVC was scheduled to, and check the thin pool there:

```bash
kubectl get pvc <pvc> -n <namespace> -o jsonpath='{.metadata.annotations.volume\.kubernetes\.io/selected-node}{"\n"}'
lvs -o lv_name,vg_name,lv_size,lv_attr,data_percent,metadata_percent,pool_lv
vgs -o vg_name,vg_size,vg_free
```

A thin pool with `Data%` or `Meta%` at or near 100 confirms this cause.

2. Map the thin volumes to PVs and PVCs, and decide which data can go:

```bash
kubectl get logicalvolumes.topolvm.cybozu.com
kubectl get pv | grep topolvm
```

3. Free or add physical space:
   - Delete PVCs on that node that are confirmed unused. Space returns only if the reclaim policy is `Delete`; with `Retain`, see [TopoLVM capacity stays full after PVCs are deleted on ACP](./TopoLVM_capacity_stays_full_after_PVCs_are_deleted_on_ACP.md).
   - Or add a bare disk to that node's device class (**Storage Management > Local Storage > Add Storage Device**) so new PVCs can be created. A disk added this way can become a separate volume group and then does not help existing thin volumes.

> **Warning:** Do not run `lvremove` on a thin volume that backs a Bound PV. Its data cannot be recovered, and the API objects stay behind.

## Diagnostic Steps

```bash
kubectl -n nativestor-system get topolvmclusters.topolvm.cybozu.com topolvm -o yaml
kubectl -n nativestor-system get pods
lvs -o lv_name,vg_name,lv_size,lv_attr,data_percent,metadata_percent,pool_lv
```

- No `thinPoolConfig` on the device class: the cluster was not deployed with thin provisioning (Cause 1).
- An `IOLimit` object in the namespace does not change Cause 2.
- Capacity about twice the disk size on a class with `overprovisionRatio: 2`: Cause 3.
- `ProvisioningFailed` or `No space left on device` with the thin pool `Data%` near 100 on the selected node: Cause 4.
