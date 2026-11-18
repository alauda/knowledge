---
kind:
  - Troubleshooting
products:
  - Alauda Application Services
ProductsVersion:
  - 4.2.x
---

# Upgrading a Data Services PostgreSQL 14 instance to PostgreSQL 16 on ACP 4.2

## Issue

On ACP 4.2 (for example 4.2.3), Data Services offers PostgreSQL 14 and PostgreSQL 16 for new instances. An existing instance runs PostgreSQL 14 and has to move to PostgreSQL 16. The upgrade documentation only says that the PostgreSQL server version has to be upgraded manually, and the backup and restore documentation describes restoring into a new instance; neither gives the steps for moving an existing instance from 14 to 16. The question is whether updating the instance and selecting the new version is enough.

## Root Cause

### Cause 1: the major version is changed on the instance update page

No separate migration procedure is needed for this path. On ACP 4.2, the update page of a PostgreSQL instance has a database version field that offers `PostgreSQL 14` and `PostgreSQL 16`. Updating the instance and switching that field from `PostgreSQL 14` to `PostgreSQL 16` upgrades the existing instance to 16.

A PostgreSQL major version change rewrites the instance's system catalogs for the new version and requires the database server to restart, so it is a planned maintenance operation even though it is started from one form field.

## Resolution

### Cause 1

1. Check that the instance is healthy before the upgrade (Diagnostic Steps, step 1). Do not start a major version upgrade on an instance that is not `Running`.

2. Take a backup of the instance and confirm that it completed.

   > **Warning:** A major version upgrade cannot be undone by selecting `PostgreSQL 14` again: a data directory upgraded to 16 cannot be opened by PostgreSQL 14. The instance is unavailable to clients while the server restarts on the new version. Precondition: a completed backup of the instance, a maintenance window, and applications that are tested against PostgreSQL 16. Rollback: restore the backup into a PostgreSQL 14 instance and point the applications at it.

3. In the console, open the PostgreSQL instance, choose **Update**, and change the database version from `PostgreSQL 14` to `PostgreSQL 16`. Leave the other fields (replicas, CPU, memory, storage class) as they are, then confirm.

4. Wait until the instance returns to `Running`, then verify the server version (Diagnostic Steps, step 2) and test the applications that use it.

## Diagnostic Steps

1. Check the current major version and status of the instances:

   ```bash
   kubectl get postgresql -A \
     -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,VER:.spec.postgresql.version,STATUS:.status.PostgresClusterStatus
   ```

   Before the upgrade the instance shows `VER` `14` and `STATUS` `Running`. After the update is submitted, `VER` shows `16`; wait until `STATUS` is `Running` again. A status such as `SyncFailed` or `UpdateFailed` means the change was not applied; inspect `kubectl describe postgresql <name> -n <namespace>` before retrying.

2. Confirm the version that the server actually runs:

   ```bash
   kubectl exec -n <namespace> <name>-0 -- psql -U postgres -c 'SHOW server_version;'
   ```

   The output starts with `16`. A value starting with `14` means the server has not restarted on the new version yet.
