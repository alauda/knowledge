---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A workload running inside a hosted control plane requests a PVC with `accessModes: [ReadWriteMany]` and `volumeMode: Filesystem` against a StorageClass backed by the KubeVirt CSI driver (the driver that exposes the management cluster's storage to the hosted cluster's workloads). Provisioning fails:

```text
Error: rpc error: code = InvalidArgument desc =
  non-block volume with RWX access mode is not supported
```

The same StorageClass works for `accessModes: [ReadWriteOnce]` with either `Block` or `Filesystem`. RWX with `volumeMode: Block` works. RWX with `volumeMode: Filesystem` is the combination that fails.

## Root Cause

The KubeVirt CSI driver passes a per-VM disk through to a hosted-cluster Pod. The supported access-mode/volume-mode combinations follow the disk-attachment semantics it can preserve end-to-end:

| accessMode | Block | Filesystem |
|---|---|---|
| `ReadWriteOnce` | supported | supported |
| `ReadWriteMany` | supported (when the underlying provisioner supports RWX block) | **not supported** |
| `ReadOnlyMany` | usually supported | usually supported |

`ReadWriteMany + Filesystem` is the unsupported pair because the driver would have to coordinate a clustered filesystem (multi-writer semantics on a single shared block device exposed through `qcow2`/`raw` to multiple guest VMs simultaneously). That is not in scope for the current driver — RWX has to ride a block volume so the consumer is responsible for any clustered-FS layer it wants to put on top.

The error from the controller is therefore a hard invariant of the driver, not a misconfiguration of the StorageClass.

## Resolution

Pick the option that matches the workload's actual sharing requirement.

### Option A — switch the PVC to RWX Block

If the workload's only reason for RWX was multi-pod data sharing, and it can run a clustered filesystem itself (or only needs raw-block semantics — databases, message queues that handle their own consistency), make the PVC a block volume and let the application format/mount it on each consumer:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
spec:
  accessModes: [ReadWriteMany]
  volumeMode: Block             # Block, not Filesystem
  storageClassName: <kubevirt-csi-sc>
  resources:
    requests:
      storage: 50Gi
```

Then either the pod consumes a block device directly (no `mountPath`, use `volumeDevices:`), or the workload runs a clustered filesystem (GFS2, OCFS2, GlusterFS-on-block, etc.) on top.

This requires that the management cluster's underlying provisioner — the storage class behind the KubeVirt VM that backs this PVC — actually supports RWX block. Common backends do (Ceph RBD with `mountOptions: ["allow_other"]`-style enablement; some vendor SAN drivers). Ones that don't will refuse the same way at the lower layer.

### Option B — keep Filesystem, downgrade to RWO

If only one pod ever needs the volume at a time (the "we asked for RWX defensively" case), drop the access mode to `ReadWriteOnce`. RWO + Filesystem is fully supported:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
spec:
  accessModes: [ReadWriteOnce]
  volumeMode: Filesystem
  storageClassName: <kubevirt-csi-sc>
  resources:
    requests:
      storage: 50Gi
```

For workloads that need to *fail over* between pods (single active writer, but on different nodes at different times), `ReadWriteOncePod` is even tighter and is the right choice.

### Option C — use a different StorageClass for shared filesystem volumes

If the workload genuinely needs RWX *with a filesystem* (NFS-style: multiple pods reading and writing the same files), provision the PVC against a StorageClass whose driver supports that natively — e.g. an NFS-backed CSI driver, a CephFS-backed CSI driver — instead of the KubeVirt CSI driver. The hosted cluster can carry multiple StorageClasses; route the workload that needs shared filesystem semantics to a class designed for it.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
spec:
  accessModes: [ReadWriteMany]
  volumeMode: Filesystem
  storageClassName: <cephfs-or-nfs-sc>     # not the KubeVirt-CSI one
  resources:
    requests:
      storage: 50Gi
```

This is usually the cleanest answer when the management cluster already has a shared-FS storage option available to expose into hosted clusters.

## Diagnostic Steps

1. Confirm which CSI driver the failing PVC routed to. The error message above is specific to the KubeVirt CSI driver; if the PVC went to a different driver, that driver's RWX rules are different. Inspect the StorageClass:

   ```bash
   kubectl get sc <sc-name> -o yaml | yq '{provisioner, parameters}'
   ```

2. Inspect the PVC and verify the access-mode/volume-mode pair against the table above:

   ```bash
   kubectl get pvc -n <ns> <pvc> -o yaml \
     | yq '{accessModes: .spec.accessModes,
            volumeMode:  .spec.volumeMode,
            sc:          .spec.storageClassName}'
   ```

3. Check whether the management cluster's underlying StorageClass — the one that backs the KubeVirt VM disks for this hosted cluster — supports RWX block at all. The KubeVirt CSI driver inherits that capability. If the underlying class is a typical block driver that only supports RWO, neither RWX-Block nor RWX-FS will work and Option A above falls through.

4. If the application's RWX requirement turns out to be purely about pod-to-pod data sharing, look at whether an `EmptyDir`/sidecar or a `Subpath` mount could replace the shared volume. The cheapest fix is sometimes to remove the RWX requirement altogether by changing how the application processes share data.
