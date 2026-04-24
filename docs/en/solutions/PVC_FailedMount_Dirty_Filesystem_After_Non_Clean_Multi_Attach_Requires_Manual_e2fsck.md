---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A pod stays in `ContainerCreating` with a `FailedMount` error. `kubectl describe pod` surfaces a CSI-level refusal:

```text
Warning  FailedMount  ... kubelet
  MountVolume.MountDevice failed for volume "pvc-xxxx":
  rpc error: code = Internal desc = Failed to stage volume pvc-xxxx,
  err: Filesystem issues has been detected and will not be repaired
  for the volume pvc-xxxx as the fsRepair parameter is not set in the StorageClass.
```

In most cases the FailedMount is preceded by a Multi-Attach warning on the same volume:

```text
Warning  FailedAttachVolume  ... attachdetach-controller
  Multi-Attach error for volume "pvc-xxxx"
  Volume is already exclusively attached to one node and can't be attached to another.
```

The sequence is "volume was yanked off a previous node (node eviction, pod reschedule, abrupt disconnect), the filesystem was left in an inconsistent state, and the CSI driver refuses to mount it on the new node because the `StorageClass` does not authorise it to auto-repair."

## Root Cause

Block-mode CSI drivers that host a Linux filesystem on top (ext4, xfs, etc.) must run a consistency check on the filesystem metadata before mounting, whenever the previous dismount was not clean. If the filesystem is marked dirty, the driver has two choices:

1. **Auto-repair**: run `fsck` (or the filesystem-specific equivalent) before mounting. Safe only when the driver knows the integrity guarantees it should enforce.
2. **Refuse to mount**: leave the PVC stuck and surface the error to the operator.

Many CSI drivers default to option (2). They expose a `fsRepair` parameter on the `StorageClass` that, when set to `true`, authorises option (1). Without that parameter, the driver refuses the mount rather than risk corrupting the filesystem.

The Multi-Attach error that precedes this is the trigger: a volume that was attached to two nodes momentarily (because the first node did not release its attachment cleanly before the second tried to take over) almost always ends up with a dirty filesystem. The CSI driver then enforces its safety gate on the next mount attempt.

Fixing the mount requires either manually running `fsck`, or telling the driver it is safe to do so going forward. `StorageClass` parameters are **immutable after creation** — the fix must therefore be on either the specific PVC (by repairing its filesystem once) or on a **new** StorageClass (by setting `fsRepair: true` going forward).

## Resolution

### Immediate — manually run the filesystem check

Recover the specific PVC by running `fsck` on the underlying device on the node where the volume is attached.

**Step 1 — find the VolumeAttachment for the stuck PVC.**

```bash
PVC_UID=<pvc-uid>   # e.g. pvc-71f1ab1b-bd36-460d-bd83-65fe67e40de5
kubectl get volumeattachments.storage.k8s.io | grep "$PVC_UID"
# csi-234f67... csi.hpe.com ...
```

**Step 2 — identify the node and the volume's serial number.**

```bash
ATT=csi-234f67255a8b6884a407e56533c17329d8db3398f8e9ed9213659b751f8d9f52
kubectl describe volumeattachments.storage.k8s.io "$ATT"
# Spec.NodeName: <node-name>
# Status.AttachmentMetadata.SerialNumber: 60002ac000000000010047610001fde2
```

Note the node name and the LUN serial number — both are needed in the next step.

**Step 3 — find the device-mapper name on the node.**

```bash
NODE=<node-from-step-2>
SERIAL=<serial-from-step-2>
kubectl debug node/$NODE --image=busybox -- \
  chroot /host sh -c "multipath -ll | grep $SERIAL"
# mpathfj (360002ac000000000010047610001fde2) dm-8 3PARdata,VV
```

The `mpathXX` name is the device-mapper device to run `fsck` against. The exact prefix depends on the storage vendor — `mpath`, `mpathX`, or a vendor-specific pattern.

**Step 4 — run the filesystem check.**

```bash
kubectl debug node/$NODE --image=busybox -- \
  chroot /host sh -c '
    # For ext4 (e2fsck):
    e2fsck -f /dev/mapper/mpathfj

    # For xfs (xfs_repair):
    # xfs_repair /dev/mapper/mpathfj
  '
```

`-f` on `e2fsck` forces the check even on a filesystem that appears clean — useful when the driver flagged dirty state that the superblock does not agree with. Follow interactive prompts, or use `-y` to accept all repairs automatically when running inside a non-interactive debug session.

Once the check completes, delete the stuck `VolumeAttachment` (the driver recreates it on the next mount attempt and now accepts the now-clean filesystem):

```bash
kubectl delete volumeattachments.storage.k8s.io "$ATT"
```

Restart the pod:

```bash
kubectl delete pod -n <pod-ns> <pod-name>
```

The new pod lands on the same or a different node, the driver mounts the (now clean) volume, and `FailedMount` clears.

### Durable — create a new StorageClass with `fsRepair: true`

`StorageClass` parameters are immutable, so the existing class cannot be upgraded in place. Create a new class with the parameter set, and migrate future workloads onto it:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: csi-hpe-auto-repair
provisioner: csi.hpe.com
parameters:
  fsType: ext4
  fsRepair: "true"          # authorise the driver to run fsck on mount
  # ... other driver-specific parameters ...
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

New PVCs referencing `csi-hpe-auto-repair` benefit from automatic repair. Existing PVCs stay on the old class until manually migrated — there is no in-place change of a PVC's storage class.

Consider the trade-off: `fsRepair: true` accepts that `fsck` runs during the critical path to mount, which lengthens the time-to-ready for pods that bounce between nodes. For workloads where predictable mount latency matters more than tolerance to node failure, the manual-repair path (option above) is preferred.

### Address the upstream cause — why was the detach unclean?

The Multi-Attach / dirty-filesystem pattern almost always traces to a node-detach that did not complete. Inspect the preceding sequence:

- **Node eviction / abrupt power loss**: the kubelet could not finalise the `VolumeDetach` gracefully before the node was unreachable. Configure taints / tolerations so reschedule waits for the detach to complete.
- **CSI driver pod died during detach**: check the CSI node pod's restart history on the problematic node. A driver pod that crashed mid-detach leaves the volume attached.
- **Storage array side refusal**: the array may be rejecting detach requests (zoning conflict, LUN mask change). Inspect the CSI controller pod's log for detach errors.

Fix the root cause to keep the issue from recurring. A manually-repaired PVC does not stay repaired if the next node transition is again unclean.

## Diagnostic Steps

Confirm the specific error path:

```bash
kubectl -n <pod-ns> describe pod <pod> | grep -A3 -E 'FailedMount|fsRepair|Multi-Attach'
```

A combination of `Multi-Attach error` and `fsRepair parameter is not set` is the exact signature.

Inspect the StorageClass to confirm `fsRepair` is unset / false:

```bash
kubectl get storageclass <sc-name> -o yaml | grep -iE 'fsRepair|fsType'
```

If `fsRepair: "true"` is already present and the driver still refuses, read the driver's logs — newer drivers expose a stricter set of dirty states that `fsRepair` does not automatically cover.

List all stuck PVCs of the same pattern (a widespread unclean detach may affect many at once):

```bash
kubectl get pvc -A -o json | \
  jq -r '.items[]
         | select(.status.phase == "Pending" or
                  (.status.conditions[]? | select(.type=="FailedMount"))) |
         "\(.metadata.namespace)/\(.metadata.name)"'
```

Repair all at once if needed by iterating through the list, or if the damage is limited to one PVC, only run the manual check on that specific volume.

After the repair, confirm the volume mounts and the pod reaches `Running`:

```bash
kubectl -n <pod-ns> get pod <pod> -w
kubectl -n <pod-ns> describe pod <pod> | head -20
```

`Ready 1/1` and no further `FailedMount` events indicates the repair took. Schedule a follow-up review of the detach chain so the same volume does not end up dirty again.
