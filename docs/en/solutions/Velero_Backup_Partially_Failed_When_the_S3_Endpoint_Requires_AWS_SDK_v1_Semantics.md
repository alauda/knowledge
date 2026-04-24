---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Velero-based backup reaches the end of the item processing phase but is reported as `PartiallyFailed`. The backup log contains an error that points squarely at the repository component rather than at any individual item:

```text
Error backing up item
error: /failed to wait BackupRepository, timeout exceeded:
       backup repository not provisioned
```

The `BackupRepository` custom resource that backs the namespace never reaches a `Ready` condition, and in the `velero` pod logs the AWS object-storage plugin reports API errors from the S3 endpoint during repository initialisation — even though the same `BackupStorageLocation` reports `Available` for simple list/put operations.

## Root Cause

Velero's AWS object-storage integration ships as two distinct plugins, and they speak different dialects of the S3 API:

- The modern plugin (commonly distributed as `velero-plugin-for-aws`) is built against the **AWS SDK v2**.
- The compatibility plugin (`legacy-aws` / `velero-plugin-for-legacy-aws`) is built against the **AWS SDK v1**.

SDK v2 changed how it signs and frames a number of request paths, most visibly the checksum / payload signing used during multipart uploads and the metadata queries done while initialising a restic/kopia repository. Many S3-compatible object stores — on-prem S3 gateways, some storage appliances, older MinIO builds, and several hyperscaler-alternative object services — implement only the SDK v1 surface, and they reject or mis-serve the v2 request shape.

The outward symptom is exactly this failure mode: object PUTs for plain data work (so `BackupStorageLocation` is happy), but the initial repository-provisioning call that Velero makes through the plugin fails, the `BackupRepository` never becomes ready, and the next backup times out waiting for it.

## Resolution

Switch the Data Protection / Velero configuration to the legacy AWS plugin so the SDK v1 wire format is used against endpoints that require it.

1. Edit the Data Protection CR that defines the Velero deployment (the exact CRD depends on whether backup is provided by the in-cluster `configure/backup` capability or by an operator-provided integration; the `spec.configuration.velero.defaultPlugins` list is the field to change either way):

   ```bash
   kubectl -n <backup-ns> edit <dpa-cr>
   ```

2. Replace the `aws` plugin entry with `legacy-aws` in `defaultPlugins`, keeping the CSI plugin and any platform integrations in place:

   ```yaml
   spec:
     configuration:
       velero:
         defaultPlugins:
         - legacy-aws
         - csi
   ```

3. Let the operator roll the Velero deployment. Wait for the new `velero` pod to be `Ready`, then confirm the `BackupStorageLocation` re-reports `Available`:

   ```bash
   kubectl -n <backup-ns> get backupstoragelocations.velero.io
   ```

4. Re-run the backup. Watch the `BackupRepository` object transition to `Ready` before the backup starts processing items:

   ```bash
   kubectl -n <backup-ns> get backuprepositories
   ```

A `Ready` repository on the first attempt after the plugin switch confirms the fix.

If the environment genuinely needs to keep the v2 plugin (for instance, to take advantage of a feature only exposed by that build), the fix lives on the storage side instead: upgrade the S3 gateway / object store to a release that fully implements the v2 request shape, and re-test.

## Diagnostic Steps

Use the following checks to rule out look-alike failure modes before swapping plugins:

1. **Backup status.** Confirm the backup ended `PartiallyFailed` with a repository-level error rather than an item-level error:

   ```bash
   kubectl -n <backup-ns> exec deploy/velero -c velero -- \
     ./velero backup describe <backup-name> --details
   ```

2. **BackupRepository state.** If it is stuck in `NotReady` / empty `conditions` after the backup tried to run, the plugin initialisation is the problem — not the data path:

   ```bash
   kubectl -n <backup-ns> get backuprepositories -o wide
   kubectl -n <backup-ns> describe backuprepository <name>
   ```

3. **Velero pod log around the BSL / repo initialisation.** Look for an AWS SDK error during the `EnsureRepo` / `InitRepo` path. SDK v2 surfaces these as `operation error S3: …` with a signing-related message; SDK v1 surfaces them differently, so a v2 signature in the error is another confirmation that the active plugin is the modern one:

   ```bash
   kubectl -n <backup-ns> logs deploy/velero -c velero | grep -iE 'EnsureRepo|InitRepo|operation error S3'
   ```

4. **Object store sanity check.** Do a quick `put / head / get` against the same bucket using the `aws s3` CLI with `--endpoint-url` set to the object store. If the CLI's default (SDK v2) transport works, the back end is v2-capable and the problem is elsewhere; if it fails the same way, this article applies and the legacy plugin is the right fix.

5. **After the switch.** Delete the old `BackupRepository` object so Velero re-creates it under the new plugin, and re-run the backup. A successful `BackupRepository` reconcile and a `Completed` backup are the pass criteria:

   ```bash
   kubectl -n <backup-ns> delete backuprepository <name>
   ```
