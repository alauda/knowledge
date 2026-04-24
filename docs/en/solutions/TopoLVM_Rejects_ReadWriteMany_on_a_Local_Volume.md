---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A PVC bound to a local-LVM `StorageClass` stays in `Pending` and the provisioner emits the same error every minute:

```text
failed to provision volume with StorageClass "lvms-vg1":
rpc error: code = InvalidArgument desc = unsupported access mode: MULTI_NODE_MULTI_WRITER
```

The PVC manifest asked for `ReadWriteMany`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: example
  namespace: default
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 1Gi
  storageClassName: lvms-vg1
  volumeMode: Filesystem
```

On ACP the local-volume tier is delivered through TopoLVM (`storage/storagesystem_topolvm`), which is the platform-preferred path for thin-provisioned LVM-backed PVs from on-node volume groups. TopoLVM is a single-node CSI driver by design — the same constraint that triggers this error.

## Root Cause

TopoLVM provisions a logical volume on **one** node's volume group. The PV that backs the claim is the LV on that node; pods that consume it must be scheduled to that same node. CSI exposes this contract through the `accessModes` field — TopoLVM advertises only `ReadWriteOnce` and `ReadWriteOncePod`, mapped to the CSI access modes `SINGLE_NODE_WRITER` and `SINGLE_NODE_SINGLE_WRITER`.

A PVC asking for `ReadWriteMany` (CSI's `MULTI_NODE_MULTI_WRITER`) is asking for a volume that can be mounted read-write from multiple nodes simultaneously. There is no general way to deliver that on top of an LV on a single host — the LV is local, and a network filesystem layer above it would defeat the latency benefit that motivates using a local backend in the first place.

The CSI driver therefore rejects the request at the provisioning step. Confirming with the driver and class definitions:

```bash
kubectl describe csidriver topolvm.io | grep -i policy
# Fs Group Policy: ReadWriteOnceWithFSType

kubectl describe sc lvms-vg1 | grep -e Annotations -e Parameters
# Annotations: description=Provides RWO and RWOP Filesystem & Block volumes
# Parameters:  csi.storage.k8s.io/fstype=xfs,topolvm.io/device-class=vg1
```

## Resolution

Choose between staying on the local backend with a single-node access mode, or moving the workload to a backend that genuinely supports cross-node read-write access.

1. **For a workload that does not need multi-node access, use `ReadWriteOnce` on TopoLVM.** This is the common case — a single-replica StatefulSet or a Deployment with one pod that wants fast local storage. The PVC and the pod will be co-scheduled to the node where the LV lives.

   ```yaml
   apiVersion: v1
   kind: PersistentVolumeClaim
   metadata:
     name: example
     namespace: default
   spec:
     accessModes: ["ReadWriteOnce"]
     resources:
       requests: { storage: 1Gi }
     storageClassName: lvms-vg1
     volumeMode: Filesystem
   ```

2. **For a workload that wants pod-level exclusivity, use `ReadWriteOncePod`.** This is stricter than `ReadWriteOnce` — the volume can be mounted by only one pod at a time, even when two pods land on the same node. Useful for workloads that assume a single writer (databases, single-leader queues) and want the kernel to enforce it.

   ```yaml
   spec:
     accessModes: ["ReadWriteOncePod"]
   ```

3. **For a workload that genuinely needs `ReadWriteMany`, switch to a backend that exposes a shared filesystem.** Two natural targets are available on the platform:

   - **CephFS** (delivered through `storage/storagesystem_ceph`) for general-purpose multi-writer file storage.
   - **MinIO** (delivered through `storage/storagesystem_minio`) when the application can speak S3 instead of POSIX.

   Pick a `StorageClass` from the chosen backend and re-create the PVC against it. The local-LVM tier is not the right place for shared-write data.

4. **Do not try to wrap TopoLVM with NFS to get RWX.** That recreates the failure mode the design was meant to avoid: a single-node bottleneck masquerading as a shared filesystem, with cross-node fencing problems on top.

5. **For a multi-pod read-only workload, an `ReadOnlyMany` PVC is allowed against drivers that support it; TopoLVM does not.** The same advice applies — switch to CephFS for the read-only case if multi-node access is essential.

## Diagnostic Steps

Confirm what access modes the driver actually advertises before re-applying:

```bash
kubectl get csidriver topolvm.io -o jsonpath='{.spec.fsGroupPolicy}{"\n"}'
kubectl get sc lvms-vg1 -o yaml | head -30
```

Inspect the failed claim and its events to confirm the error is at provisioning time and not at attach/mount:

```bash
kubectl get pvc example -o jsonpath='{.status.phase}{"\n"}'
kubectl describe pvc example | tail -20
```

Once the access mode is corrected, the next reconciliation creates the PV on the node where the volume group has free space:

```bash
kubectl get pvc example -o wide
kubectl get pv $(kubectl get pvc example -o jsonpath='{.spec.volumeName}') \
  -o jsonpath='{.spec.nodeAffinity}{"\n"}'
```

The `nodeAffinity` block tells the scheduler the volume only exists on one node — pods that consume the PVC will be confined there. If a future pod needs to land elsewhere, that workload is a candidate for the shared-filesystem alternatives listed under Resolution rather than for further LVM tuning.
