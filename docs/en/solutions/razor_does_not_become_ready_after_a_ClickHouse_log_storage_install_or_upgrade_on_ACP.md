---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# razor does not become ready after a ClickHouse log storage install or upgrade on ACP

## Issue

Alauda Container Platform Log Storage for ClickHouse is installed, reinstalled or upgraded. ClickHouse itself runs, but `razor` never becomes ready. `razor` is the gateway in front of the logging ClickHouse, StatefulSet `razor` in `cpaas-system`. `vector` is a container inside the `razor` pod. Typical reports:

- "`razor` will not start after the install."
- "The `vector` container fails with a read-only file system."
- "`razor` stays in `Error` after the platform upgrade."
- "`razor-0` is `1/2 Running` and restarting on a new deploy."

The `razor` log may end with:

```text
Try to do recover from dirty
Failed to prepare {"error": "migration aborted after recoverd"}
```

The default data paths are `/cpaas/data/clickhouse` for ClickHouse and `/cpaas/data/vector` for the `vector` buffer. On an immutable OS the writable root for platform data is `/var/cpaas` instead of `/cpaas`.

When ClickHouse itself never starts, see [ClickHouse log storage plugin install fails or ClickHouse does not start on ACP](./ClickHouse_log_storage_plugin_install_fails_or_ClickHouse_does_not_start_on_ACP.md).

## Root Cause

### Cause 1: On an immutable OS, razor fails with a read-only file system or never starts because the vector path lacks /var

Two variants share this cause:

- The install from the console wrote the ClickHouse path as `/var/cpaas/data/clickhouse`, but passed `/cpaas/data/vector` to `vector`, without the `/var` prefix. `razor` cannot start. Editing the ClickHouse ModuleInfo in place to `/var/cpaas/data/vector` does not refresh the path of the existing `razor` PVC and PV. Recreating the ModuleInfo with the corrected path does.
- After a disk replacement moved the writable path from `/cpaas` to `/var/cpaas`, the `vector` container fails with `Configuration error` on every sink (`audit`, `event`, `log kubernetes`, `log platform`, `log system`, `log workload`):

  ```text
  error occurred when building buffer: failed to build individual stage 0: failed to load/create ledger: ledger I/O error: Read-only file system (os error 30)
  run "/usr/local/bin/vector" error: exit status 78
  ```

  `mount | grep cpaas` on the host shows the disks mounted `rw` on `/var/cpaas`, so the path `vector` was given is not the writable one. The `Transform "dispatcher.unmatched" has no consumers` warning in the same log is not the failure.

### Cause 2: razor stays in Error after an upgrade because migration_versions_new has a dirty record

After a platform upgrade, the ClickHouse component is installed and `razor` never starts. Its log shows the migration check, an automatic recovery attempt, and the abort:

```text
clickhouse/store_setup.go:94 | server | Try to do recover from dirty
server/options.go:169 | server | Failed to prepare {"error": "migration aborted after recoverd"}
```

The latest record in the ClickHouse table `migration_versions_new` is marked dirty. `razor` cannot recover from it. Emptying the ClickHouse data directory with `razor` and every ClickHouse replica stopped, then starting them again, lets `razor` start. That discards all stored ClickHouse data.

### Cause 3: razor fails with migration aborted after recoverd on a new deploy because one replica is missing tables

While the ClickHouse log storage is being deployed, `razor-0` is `1/2 Running` and restarting. Its log shows `curVersion:10 dirty:false` and `run migration error:no change` against one replica (`chi-cpaas-clickhouse-replicated-0-0:8123`). Against another replica (`chi-cpaas-clickhouse-replicated-0-1:8123`) it shows:

```text
Try to do recover from dirty
Failed to prepare {"error": "migration aborted after recoverd"}
Failed to apply to server {"error": "migration aborted after recoverd"}
```

A later log shows the migration statement and the real error:

```text
CREATE TABLE IF NOT EXISTS audit_all ON CLUSTER replicated AS audit ENGINE = Distributed(replicated, observability, audit, rand());
Code: 60. DB::Exception: Table observability.audit does not exist. (UNKNOWN_TABLE)
```

ClickHouse had been uninstalled and reinstalled with new PVCs and PVs. The database and table initialization had not completed on one replica, so tables of the `observability` database (such as `audit`) were missing there. The migration against that replica failed and then aborted. This is a known ClickHouse log storage issue. The fix is to create the missing tables on that replica from the definitions on a healthy replica. Unlike Cause 2, the migration record here is not dirty.

## Resolution

### Cause 1: On an immutable OS, razor fails with a read-only file system or never starts because the vector path lacks /var

1. Confirm the signature. On the global cluster:

   ```bash
   kubectl get moduleinfo -A | grep -i clickhouse
   kubectl get moduleinfo <clickhouse-moduleinfo> -o yaml | grep -n -E '/cpaas/data|/var/cpaas'
   ```

   On the affected cluster:

   ```bash
   kubectl -n cpaas-system get pv | grep razor
   kubectl -n cpaas-system logs razor-1 -c vector --tail=50 | grep -E 'os error 30|exit status'
   ```

   On the node, run `mount | grep cpaas`. This cause matches when the ClickHouse path is under `/var/cpaas` and the `vector` path under `/cpaas` in the same ModuleInfo. It also matches when `vector` reports `Read-only file system (os error 30)` while the host mount is `rw`.

2. Save the ModuleInfo and prepare a corrected copy:

   ```bash
   kubectl get moduleinfo <clickhouse-moduleinfo> -o yaml > /tmp/clickhouse-minfo.backup.yaml
   cp /tmp/clickhouse-minfo.backup.yaml /tmp/clickhouse-minfo.new.yaml
   ```

   In `/tmp/clickhouse-minfo.new.yaml`, change the `vector` path to `/var/cpaas/data/vector`. Remove `metadata.uid`, `metadata.resourceVersion`, `metadata.creationTimestamp`, `metadata.managedFields` and `status`.

3. Recreate the plugin from the corrected copy.

   > **Warning:** Uninstalling ClickHouse from the console removes the log storage and its PVCs, and log search is empty until the recreated plugin ingests again. Precondition: only when this cause is confirmed and the ModuleInfo backup from step 2 is saved on the global cluster. Rollback: apply the saved backup unchanged to return to the previous state.

   Uninstall ClickHouse from the console and wait until the ModuleInfo is gone. Then:

   ```bash
   kubectl apply -f /tmp/clickhouse-minfo.new.yaml
   kubectl -n cpaas-system get pv | grep razor
   ```

4. Check that the new `razor` PV points under `/var/cpaas`. An in-place edit of the old ModuleInfo is not enough, because it leaves the `razor` PVC and PV on the old path.

### Cause 2: razor stays in Error after an upgrade because migration_versions_new has a dirty record

1. Confirm the signature:

   ```bash
   kubectl -n cpaas-system logs <razor-pod> -c razor --tail=40 | grep -E 'recover from dirty|migration aborted'
   kubectl -n cpaas-system exec <ck-pod> -c clickhouse -- clickhouse-client --query \
     "SELECT version, dirty, sequence FROM migration_versions_new ORDER BY sequence DESC LIMIT 1"
   ```

   `dirty` = 1 on the latest row matches this cause.

2. Stop `razor` and every ClickHouse replica. Record the current `razor` replica count first.

   > **Warning:** Emptying the ClickHouse data directory permanently removes every log, audit and event row stored in this ClickHouse. Precondition: only when this cause is confirmed (`Try to do recover from dirty` followed by `migration aborted after recoverd`, and the latest `migration_versions_new` row is dirty), `razor` and all ClickHouse StatefulSets are at 0 replicas, and the data loss is accepted. Rollback: none.

   ```bash
   kubectl -n cpaas-system get sts razor
   kubectl -n cpaas-system scale sts razor --replicas=0
   kubectl -n cpaas-system scale sts chi-cpaas-clickhouse-replicated-0-0 --replicas=0
   kubectl -n cpaas-system scale sts chi-cpaas-clickhouse-replicated-0-1 --replicas=0
   kubectl -n cpaas-system scale sts chi-cpaas-clickhouse-replicated-0-2 --replicas=0
   ```

3. On every node that runs a logging ClickHouse pod, empty the logging data directory. This is not the MySQL slow-query store, which some clusters keep at `/cpaas/ck`.

   ```bash
   cd /cpaas/data/clickhouse && rm -rf ./*
   ```

4. Start ClickHouse again, then `razor` with its previous replica count:

   ```bash
   kubectl -n cpaas-system scale sts chi-cpaas-clickhouse-replicated-0-0 --replicas=1
   kubectl -n cpaas-system scale sts chi-cpaas-clickhouse-replicated-0-1 --replicas=1
   kubectl -n cpaas-system scale sts chi-cpaas-clickhouse-replicated-0-2 --replicas=1
   kubectl -n cpaas-system scale sts razor --replicas=<previous>
   ```

### Cause 3: razor fails with migration aborted after recoverd on a new deploy because one replica is missing tables

1. Compare the `observability` tables on each replica:

   ```bash
   for p in chi-cpaas-clickhouse-replicated-0-0-0 chi-cpaas-clickhouse-replicated-0-1-0 chi-cpaas-clickhouse-replicated-0-2-0; do
     echo "== $p"
     kubectl -n cpaas-system exec "$p" -c clickhouse -- clickhouse-client --query \
       "SELECT name FROM system.tables WHERE database = 'observability' ORDER BY name"
   done
   kubectl -n cpaas-system logs razor-0 -c razor --tail=200 | grep -E 'UNKNOWN_TABLE|does not exist'
   ```

   A replica that lacks tables the others have (for example `audit`), with `UNKNOWN_TABLE` in the `razor` log for that replica, matches this cause.

2. Export the table definitions from a healthy replica:

   ```bash
   kubectl -n cpaas-system exec chi-cpaas-clickhouse-replicated-0-0-0 -c clickhouse -- clickhouse-client --format TSVRaw --query \
     "SELECT name AS table_name, create_table_query FROM system.tables WHERE database = 'observability'" > /tmp/observability-ddl.tsv
   ```

3. Create the missing tables on the affected replica.

   > **Warning:** Creating tables by hand on a replica changes its schema outside the `razor` migration. A statement for a table that already exists on that replica fails, and a wrong statement can register a table that does not match its peers. Precondition: only when this cause is confirmed, the statements come from a healthy replica of the same installation, and you run only the statements for tables missing on the target replica. Rollback: `DROP TABLE observability.<table>` on that replica removes a table created by mistake.

   Open a client on the replica that is missing tables:

   ```bash
   kubectl -n cpaas-system exec -it <replica-pod> -c clickhouse -- clickhouse-client
   ```

   Run the `create_table_query` of each missing table. Run the base tables first and the `*_all` Distributed tables that reference them afterwards.

4. Repeat the comparison from step 1. Then restart `razor-0` so that it runs the migration again, and check that it becomes Ready:

   ```bash
   kubectl -n cpaas-system delete pod razor-0
   kubectl -n cpaas-system get pods | grep razor
   ```

## Diagnostic Steps

1. Read the plugin and pod state:

   ```bash
   kubectl get ars -A | grep -Ei 'click|log'
   kubectl -n cpaas-system get pods | grep -Ei 'click|razor'
   kubectl -n cpaas-system logs razor-0 -c razor --tail=100
   kubectl -n cpaas-system logs razor-0 -c vector --tail=100
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | A mix of `/var/cpaas` and `/cpaas` paths in the ModuleInfo on an immutable OS, or `Read-only file system (os error 30)` in the `vector` container | Cause 1 |
   | `razor` in `Error` after an upgrade, `Try to do recover from dirty`, and the latest `migration_versions_new` row has `dirty` = 1 | Cause 2 |
   | `migration aborted after recoverd` on a new deploy, `UNKNOWN_TABLE` for an `observability` table, and one replica missing tables the others have | Cause 3 |

3. The `RaftInstance ... End of file` lines that ClickHouse prints repeatedly also appear on correctly deployed clusters. They do not identify any of these causes.

## Related Information

- Related articles: [ClickHouse log storage plugin install fails or ClickHouse does not start on ACP](./ClickHouse_log_storage_plugin_install_fails_or_ClickHouse_does_not_start_on_ACP.md) covers the first-install failures where ClickHouse itself does not come up.
- [ClickHouse log queries fail after the log storage had been working: missing tables or broken parts on ACP](./ClickHouse_log_queries_fail_after_the_log_storage_had_been_working_missing_tables_or_broken_parts_on_ACP.md)
