---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500179
---

# TopoLVM rejects ReadWriteMany PVCs on Alauda Container Platform

## Issue

On Alauda Container Platform (Kubernetes v1.34.5) a `PersistentVolumeClaim` whose `spec.accessModes` carries `ReadWriteMany` against a TopoLVM-backed `StorageClass` never binds: the external-provisioner sidecar surfaces a `ProvisioningFailed` event on the PVC and the underlying CSI `CreateVolume` RPC returns `rpc error: code = InvalidArgument desc = unsupported access mode: MULTI_NODE_MULTI_WRITER`. The PVC stays in `Pending` indefinitely and any workload referencing it cannot schedule because no `PersistentVolume` is ever materialized to satisfy the claim.

`spec.accessModes` on `PersistentVolumeClaim` is the standard `core/v1` `[]string` field, and the wire-protocol enum the CSI provisioner sees is fixed by the upstream CSI specification: `ReadWriteMany` is translated by the external-provisioner into `MULTI_NODE_MULTI_WRITER` on the `CreateVolume` request before it ever reaches the driver. A driver that does not implement that mode rejects the request at the gRPC boundary with `InvalidArgument`, which is exactly the signal that the provisioner does not advertise RWX support.

## Root Cause

TopoLVM is a node-local CSI driver: each `PersistentVolume` it provisions is carved out of an LVM volume group that lives on one specific worker node, and the per-volume state is tracked by a `LogicalVolume` custom resource (`logicalvolumes.topolvm.cybozu.com`) bound to that node. The CSIDriver advertises the topology key `topology.topolvm.cybozu.com/node`, and every `CSINode` entry in the cluster registers exactly one TopoLVM node ID equal to its own node identity — there is no cross-node volume group, no shared backing store, and no path by which a single LV can be mounted read-write from more than one node concurrently. That topology is what makes the multi-node access modes `ReadWriteMany` and `ReadOnlyMany` structurally unimplementable for this driver.

## Resolution

Use only single-node access modes on PVCs that target a TopoLVM `StorageClass`: `ReadWriteOnce` or `ReadWriteOncePod`. These are the only values the driver accepts at provisioning time; any PVC manifest that lists `ReadWriteMany` (or `ReadOnlyMany`) against a TopoLVM SC must be rewritten to one of the single-node modes before the claim can bind.

On Alauda Container Platform the default TopoLVM `StorageClass` ships as `topolvm-hdd`, with provisioner `topolvm.cybozu.com` and parameters `csi.storage.k8s.io/fstype=xfs,topolvm.cybozu.com/device-class=hdd` — that is the SC name and provisioner string to target from PVC manifests. A minimal PVC that the driver will accept looks like the following:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
  namespace: my-app
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: topolvm-hdd
  resources:
    requests:
      storage: 10Gi
```

If a workload genuinely requires shared read-write access from multiple pods on different nodes, TopoLVM is not the right backend — that requirement has to be satisfied by a network-shared filesystem provisioner, not by switching access modes on a node-local driver.

The TopoLVM CSIDriver object on Alauda Container Platform is registered under the upstream cybozu name `topolvm.cybozu.com` (not `topolvm.io`) and carries `fsGroupPolicy: ReadWriteOnceWithFSType`, `attachRequired: false` (the driver mounts node-locally, with no external attacher in the path), and `volumeLifecycleModes: [Persistent, Ephemeral]`. The `ReadWriteOnceWithFSType` policy means the kubelet applies the pod's `fsGroup` to the volume only when a filesystem type is set and the volume is mounted `ReadWriteOnce` — consistent with the single-node, filesystem-mode usage pattern the driver supports.

## Diagnostic Steps

Confirm that the TopoLVM driver and its `StorageClass` advertise only single-node semantics before re-shaping any PVC. Inspect the CSIDriver's filesystem-group policy and the SC's parameters directly — the `fsGroupPolicy` line and the `Parameters` line together show that the driver is the upstream TopoLVM driver under the cybozu name and that the SC binds to one device class on the node-local volume group:

```bash
kubectl describe csidriver topolvm.cybozu.com | grep -i policy
kubectl describe sc topolvm-hdd | grep -e Annotations -e Parameters
```

Expected output shape:

```text
Fs Group Policy:    ReadWriteOnceWithFSType
Parameters:         csi.storage.k8s.io/fstype=xfs,topolvm.cybozu.com/device-class=hdd
```

When a PVC is already stuck `Pending`, `kubectl describe pvc <name>` surfaces the `ProvisioningFailed` event with the `MULTI_NODE_MULTI_WRITER` rejection text in the message, which is the definitive signal that the requested access mode is incompatible with the driver and that the PVC manifest — not the driver or the SC — is what needs to change.
