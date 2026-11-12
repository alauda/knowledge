---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion: []
---

# Nexus database export task unreachable during migration to Alauda DevOps v4 after deleting the Nexus Services first

## Issue

While migrating a platform-deployed Nexus to Alauda DevOps v4 (the Nexus version itself does not change), the migration steps are run in their numbered order:

- 1.1 Service shutdown: uninstall the old-version operator, then delete the Nexus Services with `kubectl -n ${INSTANCE_NAMESPACE} delete service -l release=${INSTANCE_NAME}`.
- 1.2 Back up Blob storage with `kubectl cp` from the Nexus Pod.
- 1.3 Back up the database by creating an **Admin - Export databases for backup** task under **Admin Dashboard > System > Tasks** in the Nexus web UI.

After step 1.1, step 1.3 cannot be performed: the Nexus web UI, where the export task is created, is no longer reachable.

## Root Cause

### Cause 1: the Services were deleted before the backups were taken

Step 1.3 is done inside the Nexus web UI, and the UI is reached through the Nexus Services. Step 1.1 deletes those Services. Running 1.1 first removes access to the UI, so the database export task cannot be created or run.

The correct execution order is: complete steps 1.2 and 1.3 first, while the Services still exist, and only then perform step 1.1.

## Resolution

### Cause 1

1. Prepare a local backup directory with enough free disk space for the blob store and the database export, and set the variables used by the steps:

   ```bash
   mkdir -p nexus-backup
   export INSTANCE_NAME=<nexus-instance-name>
   export INSTANCE_NAMESPACE=<nexus-namespace>
   kubectl -n ${INSTANCE_NAMESPACE} get pod -l release=${INSTANCE_NAME}
   export POD_NAME=<nexus-pod-name>
   ```

2. Step 1.2, back up Blob storage:

   ```bash
   mkdir -p nexus-backup/blobs
   kubectl -n ${INSTANCE_NAMESPACE} cp ${POD_NAME}:/nexus-data/blobs nexus-backup/blobs
   ```

3. Step 1.3, back up the database in the Nexus web UI:
   1. Go to **Admin Dashboard > System > Tasks** and create a task.
   2. Type: **Admin - Export databases for backup**.
   3. Task name: any name.
   4. Backup location: a directory path inside the Nexus data volume directory.
   5. Frequency: manual.
   6. Run the task and confirm that it completes.

   The export files are written inside the Nexus data volume, and step 1.2 copies only `/nexus-data/blobs`. Copy the export out of the Pod as well, so that the database backup does not exist only on the volume being migrated:

   ```bash
   mkdir -p nexus-backup/db
   kubectl -n ${INSTANCE_NAMESPACE} cp ${POD_NAME}:<backup-location> nexus-backup/db
   ls -la nexus-backup/db
   ```

4. Step 1.1, shut down the service, only after the blob backup and the database export are both in `nexus-backup/`. Uninstall the old-version operator first; otherwise the deleted Services are recreated automatically. Then save and delete the Services:

   > **Warning:** After the Services are deleted, Nexus is no longer reachable by users, build tools or the web UI. Do this only after steps 1.2 and 1.3 have completed and the backups are confirmed. To restore access, re-apply the saved Service manifests (remove `metadata.resourceVersion`, `metadata.uid`, `spec.clusterIP` and `spec.clusterIPs` first).

   ```bash
   kubectl -n ${INSTANCE_NAMESPACE} get service -l release=${INSTANCE_NAME} -o yaml > nexus-backup/services.yaml
   kubectl -n ${INSTANCE_NAMESPACE} delete service -l release=${INSTANCE_NAME}
   ```

5. Continue with the remaining migration steps.

If the Services were already deleted before the database export, the web UI can still be reached directly on the Pod, without a Service, by port-forwarding to the Nexus HTTP port (8081 by default in Nexus):

```bash
kubectl -n ${INSTANCE_NAMESPACE} port-forward pod/${POD_NAME} 8081:8081
```

Open `http://localhost:8081` on the machine running the command, then perform step 1.3 and copy the export out of the Pod as described above.

## Diagnostic Steps

1. Check whether the Nexus Services still exist:

   ```bash
   kubectl -n ${INSTANCE_NAMESPACE} get service -l release=${INSTANCE_NAME}
   ```

   `No resources found` means step 1.1 has already been run; take the database export through the port-forward described above before going on.

2. Check that the Nexus Pod is still running, which steps 1.2 and 1.3 need:

   ```bash
   kubectl -n ${INSTANCE_NAMESPACE} get pod -l release=${INSTANCE_NAME} -o wide
   ```

3. After step 1.3, check that the export files exist in the backup location set in the task:

   ```bash
   kubectl -n ${INSTANCE_NAMESPACE} exec ${POD_NAME} -- ls -la <backup-location>
   ```

   An empty directory means the export task did not run or did not complete.
