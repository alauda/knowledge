---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A backup orchestrated by the platform's data-protection controller (Velero-based) fails. The `Backup` object's `failureReason` reports:

```text
Backup from previous reconcile still in progress. The API Server may have been down
```

Subsequent backup attempts repeat the same message. The Velero pod itself is healthy, the API server is reachable, and the `BackupStorageLocation` reconciles `Available`. The error nonetheless persists across multiple retry cycles.

## Root Cause

The object-storage bucket configured as the `BackupStorageLocation` had reached its allocated capacity — either a hard bucket quota or the underlying volume backing the storage gateway. When the previous backup tried to upload chunks of metadata or pod-volume data, the writes were rejected by the bucket. The Velero controller could not finalise the upload, so the corresponding `PodVolumeBackup` (Restic / Kopia) and the parent `Backup` object stayed in a non-terminal `InProgress` state. On the next reconcile pass the controller observed an active backup and refused to start a new one — the "previous reconcile still in progress" message is not an API server outage signal, it is a guard against double-launching a backup that has not finalised. Because the underlying upload can never complete while the bucket is full, the error reappears on every subsequent attempt until the storage layer is unblocked.

## Resolution

1. Free space on the backing object storage. The fix is on the storage side, not on the cluster:

   - Increase the bucket quota with the storage administrator, or
   - Delete obsolete backups (in the bucket and via `Backup` objects on the cluster) so the controller's garbage collector reclaims the space, or
   - Provision a fresh bucket and point the `BackupStorageLocation` at it.

2. Clear the stuck backup so the controller can issue a new one. The safest approach is to delete the `InProgress` `Backup` object together with any orphaned `PodVolumeBackup` and `DownloadRequest` artefacts:

   ```bash
   kubectl delete backup/<name> -n <data-protection-ns>
   kubectl get podvolumebackup -n <data-protection-ns> \
     -o jsonpath='{range .items[?(@.spec.backupName=="<name>")]}{.metadata.name}{"\n"}{end}' \
     | xargs -r -I{} kubectl delete podvolumebackup/{} -n <data-protection-ns>
   ```

3. Verify storage availability before restarting backups, for example by writing a small object via the configured credentials, then trigger a fresh backup:

   ```bash
   kubectl create -f - <<'EOF'
   apiVersion: velero.io/v1
   kind: Backup
   metadata:
     name: post-recovery-check
     namespace: <data-protection-ns>
   spec:
     includedNamespaces:
       - <small-namespace>
   EOF
   ```

4. Long-term: configure capacity alerts on the bucket and a `Schedule` retention policy on the `BackupStorageLocation` so that the controller prunes older backups before quota is reached.

## Diagnostic Steps

1. Inspect the failing backup and confirm the failure mode:

   ```bash
   kubectl get backup -n <data-protection-ns>
   kubectl describe backup/<name> -n <data-protection-ns>
   ```

2. Check whether `PodVolumeBackup` records are stuck `InProgress` and look at their messages — they typically reveal the storage error from Restic or Kopia (`Save(...)` failing with quota / `RequestEntityTooLarge` / write errors):

   ```bash
   kubectl get podvolumebackup -n <data-protection-ns>
   kubectl describe podvolumebackup/<name> -n <data-protection-ns>
   ```

3. Confirm the `BackupStorageLocation` is `Available` (the connection itself works; only writes fail when full):

   ```bash
   kubectl get backupstoragelocation -n <data-protection-ns>
   ```

4. Read the Velero pod logs around the time the backup stalled — the storage-side error code is usually visible:

   ```bash
   kubectl logs -n <data-protection-ns> deployment/velero --tail=300 | grep -E -i 'quota|insufficient|bucket|denied|exit status'
   ```

5. Validate bucket capacity outside the cluster, using the storage vendor's CLI or an `aws s3` / `mc` client against the same credentials.
