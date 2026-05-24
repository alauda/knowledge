---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Resolving Multi-Attach Errors for ReadWriteOnce PersistentVolumes
## Issue

A pod stays in `ContainerCreating` with events similar to:

```text
Warning  FailedAttachVolume  ...  attachdetach-controller
  Multi-Attach error for volume "pvc-abc"
  Volume is already exclusively attached to one node and can't be attached to another
```

The workload appears healthy on its original node, but a new replica, a drained pod, or a replacement cannot start anywhere else.

## Root Cause

A PersistentVolume declared with `accessModes: [ReadWriteOnce]` can be published to **one** node at a time. The cluster tracks this ownership through a `VolumeAttachment` object created by the CSI attach/detach controller. When the controller observes a second pod trying to consume the same PVC on a different node before the first attachment is released, it blocks the second attach and surfaces the `Multi-Attach` error.

Common ways this state arises:

- A node became `NotReady` while a pod was running on it. The kubelet on that node can no longer confirm detach, so the `VolumeAttachment` is not cleaned up.
- A Deployment using `RollingUpdate` strategy has `maxSurge > 0` while its PVC is `RWO` — the replacement pod is scheduled before the old one releases the volume.
- A pod was force-deleted (`--grace-period=0 --force`) while still attached. The API object is gone, but the CSI driver never received a detach call.
- Workload topology drifted so two replicas that share a `RWO` PVC land on different nodes.

## Resolution

1. **Confirm the access mode and controller type.** If the volume is truly single-writer and the workload runs multiple replicas, it is the workload that needs to change, not the volume:

   ```bash
   kubectl get pvc <pvc> -o jsonpath='{.spec.accessModes}'
   kubectl get deployment <dep> -o jsonpath='{.spec.strategy}'
   ```

   For a single-writer workload use `strategy: Recreate` (or a StatefulSet with one replica). For a multi-writer workload, request `ReadWriteMany` and pick a CSI driver that supports it.

2. **If the original node is gone or stuck**, remove the stale attachment so the volume can bind elsewhere:

   ```bash
   kubectl get volumeattachment -o wide | grep <pv-name>
   kubectl describe volumeattachment <name>
   ```

   If the holder node is permanently offline and will not come back, delete the `VolumeAttachment`; the CSI controller will re-reconcile. Never delete the `VolumeAttachment` while the holder node is healthy — it will race with the in-flight attach and can corrupt the volume. Drain the node first:

   ```bash
   kubectl cordon <holder-node>
   kubectl drain <holder-node> --ignore-daemonsets --delete-emptydir-data
   # only after the node is drained / confirmed dead:
   kubectl delete volumeattachment <name>
   ```

3. **If the holder pod is terminating-but-stuck**, find it and let the kubelet finish detach. Avoid `--force`:

   ```bash
   kubectl get pod -A -o wide | grep <holder-node>
   kubectl describe pod <stuck-pod> -n <ns>
   # check kubelet logs on the node for unmount failures
   ```

4. **Prevent recurrence.** Encode the single-writer invariant in the manifests: `strategy: Recreate` on Deployments, `podAntiAffinity` to keep replicas together when shared RWO is required, and where possible move data to a shared-filesystem provisioner (e.g. a CSI driver that exposes `ReadWriteMany`).

## Diagnostic Steps

Inspect the PersistentVolume and PVC to confirm access mode and reclaim policy:

```bash
kubectl describe pv <pv-name>
kubectl describe pvc -n <ns> <pvc-name>
```

List all VolumeAttachments and identify the one holding the PV:

```bash
kubectl get volumeattachment -o custom-columns='NAME:.metadata.name,ATTACHED:.status.attached,NODE:.spec.nodeName,PV:.spec.source.persistentVolumeName' \
  | grep <pv-name>
```

Confirm the holder node is reachable and has not expired its lease:

```bash
kubectl get node <holder-node> -o wide
kubectl get lease -n kube-node-lease <holder-node> -o yaml
```

Check events on the pod, the volume, and the node:

```bash
kubectl -n <ns> describe pod <stuck-pod>
kubectl get events -A --field-selector involvedObject.kind=VolumeAttachment
kubectl get events -A --field-selector involvedObject.name=<holder-node>
```

If the CSI driver exposes metrics, scrape `csi_operations_seconds{operation="ControllerUnpublishVolume"}` — a spike usually indicates the driver is the bottleneck rather than Kubernetes.
