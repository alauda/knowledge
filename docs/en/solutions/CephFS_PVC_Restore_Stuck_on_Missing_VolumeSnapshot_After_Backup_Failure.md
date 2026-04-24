---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A backup or restore workflow that creates a `PersistentVolumeClaim` from a `VolumeSnapshot` data source never reaches `Bound`. The namespace fills with repeating `Provisioning` events for the same PVC, and the CephFS CSI provisioner logs a tight loop of "snapshot not found" errors:

```text
External provisioner is provisioning volume for claim "<ns>/<pvc>"
error syncing claim "<pvc>": failed to provision volume with StorageClass "<sc>":
  error getting handle for DataSource Type VolumeSnapshot by Name:
  error getting snapshot from api server:
  volumesnapshots.snapshot.storage.k8s.io "<snap>" not found
```

The retry counter on the offending claim climbs into the thousands while the volume is never created. New PVCs that reference snapshots which *do* exist are still serviced, but throughput on the provisioner pod degrades because every iteration of its work queue chews through the stale request first.

## Root Cause

The CephFS CSI external-provisioner caches in-flight provisioning requests in its work queue. When a `VolumeSnapshot` referenced as the `dataSource` of a PVC is deleted (for example, the backup job that owned it was rolled back, or retention pruned the snapshot before the PVC was applied), the provisioner has no signal to abandon the request — it keeps re-resolving the snapshot name against the API server, gets `not found`, and re-queues the work.

Restarting the provisioner pod evicts the stale items from memory and lets new requests through. The bug shape is generic to any CSI external-provisioner that takes its data source from a `VolumeSnapshot`; CephFS happens to expose it visibly because backup tooling regularly chains snapshot → PVC restore.

## Resolution

The platform-preferred path on ACP is to drive backup and restore through the `configure/backup` surface (Velero-based) on top of the Ceph storage stack documented under `storage/storagesystem_ceph`. Going through that path lets the platform clean up orphaned `VolumeSnapshot` references when a backup is invalidated, so the provisioner never sees the dangling work item in the first place.

When the symptom has already manifested (legacy backup tooling, manual restore experiment, or a snapshot that was deleted out-of-band), recover by recycling the provisioner pods that own the stale queue:

1. **Identify the namespace and the provisioner workload.** On ACP storage clusters using the Ceph storage system, the CephFS CSI provisioner is a Deployment in the storage namespace:

   ```bash
   kubectl get pods -A -l app=csi-cephfsplugin-provisioner -o wide
   ```

   Note both the namespace and the number of replicas (typically 2 for HA).

2. **Restart the provisioner pods.** A rolling delete clears the in-memory queue without disrupting other CSI operations on the cluster:

   ```bash
   kubectl -n <storage-namespace> delete pod -l app=csi-cephfsplugin-provisioner
   ```

   The Deployment recreates the pods within seconds and they re-list active `VolumeSnapshotContent` objects from a clean slate.

3. **Verify the stale events stop.** The repeating `Provisioning` event in the affected namespace should stop within a minute of the new provisioner pods becoming `Ready`. PVCs that still reference a missing snapshot will go to `Pending` with a single, stable `ProvisioningFailed` event instead of the previous flapping log.

4. **Clean up the dangling claims.** Delete any PVC whose `dataSource` points at a snapshot that is genuinely gone. The provisioner will not recover them on its own, and leaving them behind only invites a repeat of the problem the next time the controllers restart:

   ```bash
   kubectl get pvc -A -o json | \
     jq -r '.items[] | select(.spec.dataSource.kind=="VolumeSnapshot") |
            "\(.metadata.namespace) \(.metadata.name) \(.spec.dataSource.name)"'
   kubectl -n <ns> delete pvc <pvc>
   ```

5. **Decouple snapshot retention from restore lifecycle.** Backup tooling should keep a `VolumeSnapshot` alive for the entire window during which a `PVC` referencing it might still be applied. The platform-managed backup surface does this automatically; rolled-your-own scripts should add a guard that fails the prune step if a downstream PVC still references the snapshot.

## Diagnostic Steps

Confirm the provisioner is the source of the noise:

```bash
kubectl -n <storage-namespace> logs -l app=csi-cephfsplugin-provisioner -c csi-provisioner --tail=200 | \
  grep -E "VolumeSnapshot|not found"
```

A tight repetition of `error syncing claim` lines that all reference the same PVC, all on the same retry counter, confirms the stale-queue diagnosis.

Inspect the affected PVC and the snapshot it points at:

```bash
PVC=<pvc-name>
NS=<namespace>
kubectl -n "$NS" get pvc "$PVC" -o jsonpath='{.spec.dataSource}{"\n"}'
SNAP=$(kubectl -n "$NS" get pvc "$PVC" -o jsonpath='{.spec.dataSource.name}')
kubectl -n "$NS" get volumesnapshot "$SNAP" 2>&1
```

If `kubectl get volumesnapshot` returns `NotFound`, the snapshot is genuinely gone — the PVC cannot be satisfied and should be deleted as part of the cleanup. If the snapshot exists but its `readyToUse` is `false`, the issue is upstream in snapshot creation, not in the provisioner cache.

After restarting the provisioner pods, watch the events in the affected namespace for at least one full reconcile cycle to confirm the loop is broken:

```bash
kubectl -n "$NS" get events --sort-by=.lastTimestamp | tail -n 20
```

A clean tail with no further `Provisioning` lines for the deleted claim is the green light.
