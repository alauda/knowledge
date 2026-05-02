---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500009
---

# Pod fails to mount Ceph RBD volume with "is still being used

## Issue

A pod backed by a ReadWriteOnce Ceph RBD PVC fails to start. The kubelet reports:

```text
MountVolume.MountDevice failed for volume "pvc-xxxxxxxx":
rpc error: code = Internal desc = rbd image
<pool>/csi-vol-<uuid> is still being used
```

The affected RBD image is not visible in `lsblk` on the current node — it is not mounted locally. From the Ceph RBD CSI node plugin on the same worker:

```text
GRPC error: rpc error: code = Internal desc =
rbd image <pool>/csi-vol-<uuid> is still being used
```

Usually this surfaces after a disruption — network partition, node hard reboot, or uncontrolled detach — where the original consumer did not release the image cleanly. A companion symptom on the attach side is:

```text
Warning  FailedAttachVolume  attachdetach-controller
Multi-Attach error for volume "pvc-..." — Volume is already
exclusively attached to one node and can't be attached to another
```

## Root Cause

For a ReadWriteOnce RBD PVC, two cooperating mechanisms guarantee single-writer semantics:

1. **Ceph RBD `exclusive-lock` image feature.** The RBD image is created with `exclusive-lock` (together with `object-map` / `fast-diff` that depend on it). The lock is held by the kernel or user-space client mapping the image. While the lock is held, no other client may open the image for write.
2. **Kubernetes `VolumeAttachment`.** The attach-detach controller records which node "owns" the PV via a `VolumeAttachment` object. Until that object is removed, the scheduler/CSI refuses to attach the PV elsewhere.

After a disruption, one or both of these can be left stale:

- The old node went away before its CSI node plugin could release the lock, so the RBD image still has a watcher / exclusive-lock entry pointing to the dead node's IP.
- The `VolumeAttachment` still references the dead node because no kubelet is alive there to complete the detach flow.

Either stale record produces the "still being used" error — the RBD image reports `is still being used` via a live watcher, and the Kubernetes layer refuses the multi-attach.

## Resolution

ACP runs Ceph through Rook in the `rook-ceph` namespace. The toolbox pod (`deploy/rook-ceph-tools`) is the canonical place to invoke `rbd` commands; the RBD CSI components live alongside it (`rook-ceph.rbd.csi.ceph.com-ctrlplugin` Deployment plus `rook-ceph.rbd.csi.ceph.com-nodeplugin` DaemonSet, container name `csi-rbdplugin` in both).

Before touching Ceph, rule out the legitimate case: the image really is still attached somewhere. If the old consumer is still running and writing, forcibly removing the lock will cause data corruption or filesystem inconsistency. Proceed only once you have confirmed:

- no pod using the PVC is scheduled anywhere (controller scaled to 0, or all replicas verifiably terminated),
- no mount of the RBD image exists on any node (`lsblk` on every candidate node shows no `/dev/rbd*` for this image),
- the node that previously owned the `VolumeAttachment` is gone or rebooted and cannot race you.

For a safer, Kubernetes-first approach, prefer the sibling workflow — "RWO RBD PVC fails to mount with Multi-Attach error" — which resolves most cases by deleting only the stale `VolumeAttachment`:

```bash
kubectl get volumeattachment | grep <pv-name>
kubectl delete volumeattachment <va-name>
```

In many recovery scenarios, deleting the stale `VolumeAttachment` is enough: the attach-detach controller then issues a fresh attach on the correct node and the CSI plugin reconciles the lock.

If after the `VolumeAttachment` is gone the lock is still present on the RBD image (the image is not mapped anywhere and no pod is running), clear the lock directly. Open a shell in the Ceph toolbox:

```bash
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash
```

Inside the toolbox, inspect and remove the stale lock:

```bash
# Show the current watcher / locker:
rbd status   <pool>/csi-vol-<uuid>

# Confirm it is not mapped on any running client:
rbd showmapped

# Enumerate the locks:
rbd lock ls   <pool>/csi-vol-<uuid>
# Example output:
# There is 1 exclusive lock on this image.
# Locker        ID                     Address
# client.33448456  auto 18446462598732840967  10.130.4.1:0/481160532

# Remove it. Escape the space in the lock id with a backslash.
rbd lock rm <pool>/csi-vol-<uuid> 'auto 18446462598732840967' client.33448456
```

Note: every lock is a watcher, but not every watcher is a lock. Removing the lock frees the RBD image so the legitimate owner can map it again. Do not remove the lock while a client is actively writing.

After the lock is cleared, restart the pod. The CSI node plugin will re-map the image on the current node and mount the filesystem.

## Diagnostic Steps

Identify the PV and the underlying RBD image:

```bash
kubectl get pvc -n <ns> <pvc-name> -o jsonpath='{.spec.volumeName}{"\n"}'
kubectl get pv <pv-name> -o yaml | grep -E "clusterID|pool|imageName|imageFeatures"
```

Check the current `VolumeAttachment` state:

```bash
kubectl get volumeattachment | grep <pv-name>
```

Inspect the CSI node plugin logs on the node where the pod is scheduled. The plugin DaemonSet uses one pod per node; pick the one running on the target node:

```bash
NODE=<node-name>
kubectl -n rook-ceph get pod \
  -l app=rook-ceph.rbd.csi.ceph.com-nodeplugin -o wide | grep "$NODE"
kubectl -n rook-ceph logs <csi-rbdplugin-pod-on-node> -c csi-rbdplugin | tail -200
```

From the Ceph toolbox, verify the image is not actually mapped anywhere before intervening:

```bash
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash -c '
  rbd status <pool>/csi-vol-<uuid>
  rbd showmapped
  rbd lock ls <pool>/csi-vol-<uuid>
'
```

If `rbd status` lists a watcher whose address matches a node that is still alive, stop and reconcile at the Kubernetes layer instead of forcing the lock off.
