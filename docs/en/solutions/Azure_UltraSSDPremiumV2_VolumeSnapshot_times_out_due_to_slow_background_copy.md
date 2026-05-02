---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

VolumeSnapshot creation against an Azure-backed PVC on the
`UltraSSD_LRS` or `PremiumV2_LRS` storage class fails with a timeout. The
Azure Disk CSI controller log shows:

```text
ContextDeadlineExceeded
```

Subsequent retry attempts conflict with each other: the original Azure-side
operation has not finished yet, so the new attempt fails too. The PVC's
data is intact and Azure's portal eventually reports the snapshot as
`Succeeded`, but the Kubernetes-side `VolumeSnapshot` object never
transitions to `readyToUse: true` and downstream automation (backup,
clone, restore) blocks waiting for it.

## Root Cause

When Azure creates an incremental disk snapshot of a high-throughput
Ultra/PremiumV2 disk, it kicks off a background copy that moves the data
from the source storage to the standard snapshot store. For a large disk
(1 TiB and above) the copy can take well over an hour; with the disk
under heavy I/O it can be longer still.

The Azure Disk CSI driver's `waitForSnapshotReady` call has a hard 10
minute timeout. When the Azure backend takes longer than that to finish
the background copy, the driver cancels its internal gRPC call and
returns `ContextDeadlineExceeded` to the snapshot-controller. The
snapshot-controller then retries, but Azure rejects the retry because
the previous operation is still in flight, and the cycle continues until
Azure's background copy eventually finishes.

For Ultra/PremiumV2 disks specifically, Azure exposes a feature called
**instant access snapshots** that bypass the background copy: the
snapshot becomes readable immediately and stays accessible for a
configurable window. Within that window the driver's call returns
quickly, the snapshot is marked ready, and downstream consumers proceed.

## Resolution

Edit the `VolumeSnapshotClass` for the Azure Disk CSI driver and add the
`instantAccessDurationMinutes` parameter:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-azuredisk-vsc
driver: disk.csi.azure.com
deletionPolicy: Delete
parameters:
  incremental: "true"
  instantAccessDurationMinutes: "300"   # valid range: 60–300
```

Choose the duration to comfortably cover the worst-case background copy
time of any disk you snapshot. After the duration expires, Azure revokes
instant access; if the background copy has not finished by then the
snapshot becomes temporarily unavailable, so a generous value (toward the
upper bound of 300 minutes) is the safe default for Ultra/PremiumV2
disks.

Apply the change:

```bash
kubectl apply -f volumesnapshotclass-azure.yaml
```

Existing in-flight `VolumeSnapshot` objects do not retroactively pick up
the new class parameter — wait for the in-flight Azure operation to
settle (or delete the stuck VolumeSnapshot if Azure has already produced
the underlying snapshot), then issue fresh snapshots which use the new
class behaviour.

For workloads that do not need instant access (a slow backup pipeline
that can wait for the background copy), increase the snapshot
controller's tolerance instead by issuing the snapshot, leaving it in
the in-flight state, and not pruning it until Azure reports completion.
But for any production restore path that gates on
`readyToUse: true`, instant access is the only practical fix.

## Diagnostic Steps

1. Confirm the disk's storage class:

   ```bash
   kubectl get pvc <pvc> -n <ns> -o jsonpath='{.spec.storageClassName}'
   kubectl get sc <class> -o jsonpath='{.parameters}' | jq .
   ```

   Look for `skuName: UltraSSD_LRS` or `PremiumV2_LRS`.

2. Confirm the snapshot's failure mode is the timeout, not a bad
   credential or RBAC:

   ```bash
   kubectl logs -n <azure-csi-ns> deploy/csi-azuredisk-controller \
     -c csi-snapshotter --tail=200 | grep -i "ContextDeadlineExceeded"
   ```

3. Inspect the `VolumeSnapshot` and its content for the stuck state:

   ```bash
   kubectl describe volumesnapshot <name> -n <ns>
   kubectl get volumesnapshotcontent -o wide
   ```

   `readyToUse: false` for an extended period plus repeated controller
   retries is the characteristic pattern.

4. After applying the corrected `VolumeSnapshotClass`, take a fresh
   snapshot and confirm it transitions to ready within minutes rather
   than hours:

   ```bash
   kubectl get volumesnapshot <new-name> -n <ns> -w
   ```
