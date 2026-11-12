---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.2.x
  - 4.3.x
---

# ClickHouse log queries fail after the log storage had been working: missing tables or broken parts on ACP

## Issue

The ClickHouse log storage was working, and now log queries fail or return nothing. Typical reports:

- "The last 12 hours of logs cannot be queried, but older logs still can."
- "After the ClickHouse cluster came back from exit code 137, nothing can be found."
- "`razor-0` is abnormal on the global cluster."
- "Audit and Operations Center logs are not displayed."

The log store runs in `cpaas-system` as pods `chi-cpaas-clickhouse-replicated-<shard>-<replica>-0`, created from the ClickHouseInstallation `cpaas-clickhouse`, with database `observability`. `razor` is the gateway in front of it.

The 3-replica layout uses `ReplicatedMergeTree` tables, coordinated by ClickHouse Keeper inside the ClickHouse container. There is no separate ZooKeeper Deployment, although the configuration refers to ZooKeeper. Replication is asynchronous and multi-master, so every replica accepts writes and syncs to the others. PVC usage that differs between replicas by tens of gigabytes is normal, because merges, replication lag, temporary parts and TTL cleanup differ per replica. If the same query returns the same rows on each replica, the data is consistent. A size difference is a fault only together with other symptoms.

The shared tables include `audit`, `event`, `log_kubernetes`, `log_platform`, `log_system` and `log_workload`. Inserts go through Distributed tables such as `audit_all` and `event_all`. `SHOW TABLES FROM observability` on a healthy replica lists them all.

Installs that never worked are covered in [ClickHouse log storage plugin install fails or ClickHouse does not start on ACP](./ClickHouse_log_storage_plugin_install_fails_or_ClickHouse_does_not_start_on_ACP.md). Out-of-memory kills and capacity problems are covered in [Logging ClickHouse runs out of disk, CPU or memory, or is OOMKilled on ACP](./Logging_ClickHouse_runs_out_of_disk_CPU_or_memory_or_is_OOMKilled_on_ACP.md).

## Root Cause

### Cause 1: Part of the queries fail with UNKNOWN_TABLE because a replica lost its schema but is still registered

Logs from the last hours fail to load while older ones work, and the error is `UNKNOWN_TABLE`. One replica (for example `-1-0-0`) restarted and lost its local `observability` schema. Its registration in Keeper was never removed. The replica remains an empty shell that still receives traffic, so every query routed to it fails (about one query in six in a 3-replica layout).

### Cause 2: After recovery from exit code 137, logs cannot be found and table log_kubernetes is missing on some replicas

The ClickHouse cluster failed with exit code 137. After its resources were raised (to 16 CPU / 16Gi) it came back, but audit, product logs and Kubernetes logs return nothing. The ClickHouse log says table `log_kubernetes` cannot be found. Tables are missing on some replicas (for example `0-0-0` and `0-2-0`) and complete on another (`0-1-0`).

On an affected replica, `SHOW TABLES FROM observability` lists the Distributed table `log_kubernetes_all` but not the local table `log_kubernetes`. The client may also print `Effective user of the process (clickhouse) does not match the owner of the data (root).` Why the tables went missing has not been determined. Reinstalling ClickHouse with an emptied data directory restores the tables and the queries. The data directory must be cleared before the reinstall.

### Cause 3: razor fails to initialize because ClickHouse refuses to load observability.log_workload with too many suspicious broken parts

`razor-0` is abnormal in the console. Its events show initialization failing because ClickHouse does not load table `observability.log_workload`. The ClickHouse log reports suspicious broken parts (for example about 20 parts, 8.11 GiB in total). That is more than ClickHouse handles automatically: `merge_tree/max_suspicious_broken_parts_bytes` defaults to 1 GiB. Disk space is sufficient.

Parts are typically broken by an abnormal node or ClickHouse restart, an interrupted merge, or a transient storage I/O error. Raising the threshold lets the table load and set the broken parts aside. Afterwards the setting can go back to the default without data loss in the loaded table. Rows in the parts that were set aside can be lost.

### Cause 4: The ClickHouse disk filled, vector inserts failed, and after space returned ClickHouse is missing metadata files

The log nodes ran out of disk. The `vector` container in `razor` reported, for the `event`, `audit` and `log_system` sinks:

```text
Code: 243. DB::Exception: Cannot reserve 1.00 MiB, not enough space. (NOT_ENOUGH_SPACE)
```

`nevermore` then repeated `write error: failed to write to file: write /cpaas/log/logs/filebeat-<date>-1.ndjson: no space left on device`, and logs stopped arriving. Disk usage later dropped, but the components did not recover by themselves, and a `razor` restart failed:

- The `razor` container logged `http: proxy error: dial tcp [::1]:8081: connect: connection refused` and `Remove table ttl error ... Code: 159. DB::Exception: Timeout exceeded ... (TIMEOUT_EXCEEDED)`.
- The previous `vector` log showed `vector_buffers::variants::disk_v2::writer: Last written record was unable to be deserialized. Corruption likely.` and repeated `Events dropped intentionally ... reason="Source send cancelled."`. It ended with `run "/usr/local/bin/vector" error: signal: killed`.
- ClickHouse was unhealthy, with metadata files missing that could not be recovered.

At that point both the ClickHouse data and the `vector` disk buffer are corrupted. The recovery is a reinstall with both data directories cleared on every log node.

### Cause 5: The clickhouse container fails its liveness probe on 8123 for days, and clickhouse-operator is in CrashLoopBackOff

Audit logs and Operations Center logs are empty, and the monitoring dashboard shows a log collection rate of 0. `chi-cpaas-clickhouse-replicated-0-0-0` is `Running` with thousands of restarts. Its events repeat:

```text
Container clickhouse failed liveness probe, will be restarted
Liveness probe failed: Get "http://<pod-ip>:8123/ping": dial tcp <pod-ip>:8123: connect: connection refused
```

On the global cluster, `clickhouse-operator` in `ck-system` is in `CrashLoopBackOff`, and the data disk has free space. The ClickHouse database has been broken for a long time.

A liveness-probe kill can also show as exit code `137` with `Reason: Error`. That signature is this cause when the events show the `8123` probe failing and the operator is crash-looping. When the reason is `OOMKilled`, or there are no probe failures, see the capacity article instead. The recommended fix is to uninstall the ClickHouse log plugin, empty the logging ClickHouse data directory on the ClickHouse nodes, and redeploy.

## Resolution

Open a client on a ClickHouse pod for the SQL below:

```bash
kubectl -n cpaas-system get pods | grep chi-cpaas-clickhouse
kubectl -n cpaas-system exec -it <ck-pod> -c clickhouse -- clickhouse-client
```

### Cause 1: Part of the queries fail with UNKNOWN_TABLE because a replica lost its schema but is still registered

1. Compare the schema on each replica:

   ```sql
   SELECT name FROM system.tables WHERE database = 'observability' ORDER BY name;
   SELECT database, table, replica_name, is_readonly, active_replicas, total_replicas
   FROM system.replicas WHERE database = 'observability';
   ```

   The ghost is the replica that lists no `observability` tables while the other replicas still count it in `total_replicas`.

2. Remove the ghost entry from Keeper.

   > **Warning:** `SYSTEM DROP REPLICA` removes that replica's metadata from Keeper for the named table. If you name a replica that is actually healthy, it stops replicating and must be re-created. Precondition: only when `UNKNOWN_TABLE` appears on a share of the queries and exactly one replica has no `observability` tables. Run the statement on a healthy replica, naming the empty one. Rollback: none for the Keeper entry; the replica registers again when its tables are created.

   ```sql
   SYSTEM DROP REPLICA '<ghost-replica-name>' FROM TABLE observability.log_workload;
   ```

   Repeat it for each replicated table listed in `system.replicas`.

3. Rebuild the tables on the empty replica. On a healthy replica, list the tables and print each definition:

   ```sql
   SHOW TABLES FROM observability;
   SHOW CREATE TABLE observability.<table>;
   ```

   Run each `CREATE TABLE` statement on the empty replica. If the database is gone, run `CREATE DATABASE IF NOT EXISTS observability` first. Create the replicated tables first and the Distributed tables after. The replicated tables then fetch their parts from the other replicas.

4. Query the same time range several times. The `UNKNOWN_TABLE` errors should stop completely.

### Cause 2: After recovery from exit code 137, logs cannot be found and table log_kubernetes is missing on some replicas

1. Compare the table count per replica:

   ```sql
   SELECT hostName(), count() FROM clusterAllReplicas('replicated', system.tables)
   WHERE database = 'observability' GROUP BY 1;
   ```

   Fewer tables on some replicas, together with `log_kubernetes` not found in the log, matches this cause.

2. Reinstall with an empty data directory.

   > **Warning:** Emptying the ClickHouse data directory and reinstalling deletes all stored logs, audit records and events. Precondition: only when this cause is confirmed and losing the stored history is accepted. The ClickHouse pods must be stopped (the plugin uninstalled) before the delete. Rollback: none.

   Uninstall the ClickHouse log storage plugin. Then, on every ClickHouse node, empty the data directory (`/cpaas/data/clickhouse` by default):

   ```bash
   cd /cpaas/data/clickhouse && rm -rf ./*
   ```

3. Reinstall the plugin with resources large enough to avoid another exit code 137. Size them from the observed usage and the free memory on the nodes.

### Cause 3: razor fails to initialize because ClickHouse refuses to load observability.log_workload with too many suspicious broken parts

1. Confirm the signature:

   ```bash
   kubectl -n cpaas-system describe pod razor-0 | sed -n '/Events:/,$p'
   kubectl -n cpaas-system logs <ck-pod> -c clickhouse --tail=200 | grep -i 'suspicious'
   ```

2. Raise the threshold.

   > **Warning:** A higher `max_suspicious_broken_parts_bytes` lets ClickHouse load the table and set the broken parts aside, so rows in those parts can be lost. The edit restarts all ClickHouse pods. Precondition: only when the log shows `log_workload` refused because the suspicious broken parts exceed the limit, disk space is sufficient, and the owner accepts possible log loss (and a reinstall if this does not work). Rollback: remove the setting again (step 4).

   ```bash
   kubectl -n cpaas-system get clickhouseinstallations.clickhouse.altinity.com cpaas-clickhouse -o yaml > /tmp/chi.before.yaml
   kubectl -n cpaas-system edit clickhouseinstallations.clickhouse.altinity.com cpaas-clickhouse
   ```

   Under `spec.configuration.settings`, add a value above the broken size (10 GiB here):

   ```yaml
   merge_tree/max_suspicious_broken_parts_bytes: "10737418240"
   ```

3. After the pods restart, check the setting and the parts that were set aside:

   ```sql
   SELECT name, value, changed FROM system.merge_tree_settings WHERE name LIKE '%suspicious%';
   SELECT database, table, name, reason FROM system.detached_parts WHERE database = 'observability';
   ```

4. When `razor` is Ready and the tables answer, restore the default. The edit created a generated resource patch (`rpch`). Deleting that patch returns the setting to 1 GiB, and the pods rebuild once more:

   ```bash
   kubectl get rpch -A | grep -i clickhouse
   kubectl get rpch <clickhouse-rpch> -o yaml > /tmp/clickhouse-rpch.yaml
   kubectl delete rpch <clickhouse-rpch>
   ```

   Confirm that `log_workload` still loads.

### Cause 4: The ClickHouse disk filled, vector inserts failed, and after space returned ClickHouse is missing metadata files

1. Confirm the signature:

   ```bash
   df -hT /cpaas
   kubectl -n cpaas-system logs razor-0 -c vector --tail=100 | grep -iE 'NOT_ENOUGH_SPACE|insert|disk|space'
   kubectl -n cpaas-system logs razor-0 -c vector -p --tail=100 | grep -E 'Corruption likely|signal: killed'
   kubectl -n cpaas-system logs <ck-pod> -c clickhouse --tail=100 | grep -iE 'metadata|No such file'
   ```

2. Free the disk permanently first. Otherwise the same sequence repeats. If `du` on the log node shows the Kafka directory (`/cpaas/data/kafka0`) as the large one, see [Logs, audit and events stop while the log Kafka is degraded on ACP](./Logs_audit_and_events_stop_while_the_log_Kafka_is_degraded_on_ACP.md).

3. Reinstall with both data directories emptied.

   > **Warning:** Reinstalling ClickHouse and emptying its data directories removes all stored logs. Precondition: only when the disk is no longer full, `razor` still cannot start, and ClickHouse reports missing metadata files (or the `vector` disk buffer reports `Corruption likely`). Confirm the paths against the pod volume mounts on each log node. Rollback: none.

   Uninstall the ClickHouse plugin. Then, on every log node:

   ```bash
   cd /cpaas/data/clickhouse && rm -rf ./*
   cd /cpaas/data/vector && rm -rf ./*
   ```

4. Reinstall the plugin, and give the `vector` container in `razor` enough memory. `razor` and log query should come back.

This every-node cleanup applies only when ClickHouse is missing metadata files and `razor` cannot start. A single filled node, with read-only audit tables while the other replicas are healthy, is handled differently: see the capacity article.

### Cause 5: The clickhouse container fails its liveness probe on 8123 for days, and clickhouse-operator is in CrashLoopBackOff

1. Confirm the signature:

   ```bash
   kubectl get pod -A | grep -E 'nevermore|razor|clickhouse'
   kubectl -n cpaas-system describe pod chi-cpaas-clickhouse-replicated-0-0-0 | sed -n '/Events:/,$p'
   kubectl -n ck-system get pods
   ```

2. Find the host path that backs the logging ClickHouse data volume. The default is `/cpaas/data/clickhouse`. Some installations use `/cpaas/ck`, which on other clusters belongs to the MySQL slow-query ClickHouse (`chi-pxc-ck-slowsql-cluster`). Check which pod owns the path before you empty it:

   ```bash
   kubectl -n cpaas-system get pod chi-cpaas-clickhouse-replicated-0-0-0 -o jsonpath='{range .spec.volumes[*]}{.name}{" "}{.hostPath.path}{.persistentVolumeClaim.claimName}{"\n"}{end}'
   findmnt -T <data-path>
   ```

3. Uninstall, empty the data directory, and redeploy.

   > **Warning:** Uninstalling the ClickHouse log plugin and emptying its data directory deletes the stored logs on those nodes. Precondition: only when the liveness probe on 8123 has failed for a long time, the restarts number in the thousands, free space is not the problem, and step 2 shows that the path belongs to the logging ClickHouse pods and not to `chi-pxc-ck-slowsql-cluster`. Rollback: none.

   Uninstall the ClickHouse log plugin, empty the data directory found in step 2 on each ClickHouse node, and redeploy the plugin.

4. Check that `clickhouse-operator` is `Running` and that the log collection rate on the dashboard is above 0.

## Diagnostic Steps

1. Read the error the console or `razor` reports:

   ```bash
   kubectl -n cpaas-system get pods | grep -Ei 'chi-|razor'
   kubectl -n cpaas-system logs razor-0 -c razor --tail=50
   kubectl -n cpaas-system describe pod razor-0 | sed -n '/Events:/,$p'
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | `UNKNOWN_TABLE` on some of the requests | Cause 1 |
   | A table not found on some replicas after a recovery from exit code 137 | Cause 2 |
   | `log_workload` refused because of suspicious broken parts | Cause 3 |
   | `NOT_ENOUGH_SPACE` from `vector`, then missing metadata files or a corrupted `vector` buffer after the disk was freed | Cause 4 |
   | Thousands of liveness-probe restarts on 8123, with `clickhouse-operator` crash-looping | Cause 5 |

3. Exit code 137 without liveness-probe failures on `8123`, or `OOMKilled`, is a memory problem. See [Logging ClickHouse runs out of disk, CPU or memory, or is OOMKilled on ACP](./Logging_ClickHouse_runs_out_of_disk_CPU_or_memory_or_is_OOMKilled_on_ACP.md).

## Related Information

- [ClickHouse log storage plugin install fails or ClickHouse does not start on ACP](./ClickHouse_log_storage_plugin_install_fails_or_ClickHouse_does_not_start_on_ACP.md)
- [razor does not become ready after a ClickHouse log storage install or upgrade on ACP](./razor_does_not_become_ready_after_a_ClickHouse_log_storage_install_or_upgrade_on_ACP.md)
- [Logging ClickHouse runs out of disk, CPU or memory, or is OOMKilled on ACP](./Logging_ClickHouse_runs_out_of_disk_CPU_or_memory_or_is_OOMKilled_on_ACP.md)
