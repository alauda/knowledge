---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.10.x
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Logging ClickHouse runs out of disk, CPU or memory, or is OOMKilled on ACP

## Issue

The log store is ClickHouse, not Elasticsearch, and one of these happens:

- A log query returns a memory error, or the console shows no logs.
- A node hits 100% disk, and Kube-OVN, backup and the log pods fail together.
- ClickHouse pods restart with exit code `137`, or with `OOMKilled` in their events.

Two different ClickHouse installations appear in these problems, and cleaning one does not fix the other:

- The **logging ClickHouse** holds application, audit and platform logs (pods `chi-cpaas-clickhouse-replicated-<shard>-<replica>-0` in `cpaas-system`).
- The **MySQL slow-query ClickHouse** is `chi-pxc-ck-slowsql-cluster` (StatefulSet `chi-pxc-ck-slowsql-cluster-0-0`, pod `chi-pxc-ck-slowsql-cluster-0-0-0`). Its data is often on `/cpaas/ck`.

A third kind is a ClickHouse that a team runs with its own ClickHouseInstallation in its own namespace (container `clickhouse-pod`). Cause 6 covers it.

## Root Cause

### Cause 1: ClickHouse slow-query logs filled the node disk

`du` on the affected node stops in the slow-query volume, not in Elasticsearch. These files grow even when no MySQL pod is present, because the slow-query ClickHouse keeps its own log tables, including `system.query_log`. Other platform pods then fail because the node cannot write.

A `pxc` `chi-ck` pod in `cpaas-system` that is abnormal and does not start is this default slow-query deployment as well. When nobody uses it, stop it by setting its replicas to 0. To remove the feature completely, uninstall its operator (its CSV and Subscription go away with it), set the ClickHouse replica count to 0, and delete the PVC. The operator does not recreate the instance after that.

### Cause 2: The logging ClickHouse is out of CPU or memory

Both CPU and memory of the logging ClickHouse are at 100%, and the console cannot query. Scaling out the cluster restores queries. A smaller example is one ClickHouse node at 2 CPU / 4Gi receiving logs from two clusters: query memory runs out, and raising that node's resources stops the overflow. Neither situation involves a corrupt table, so add capacity before you consider a reinstall.

Raising memory does not always help. In one cluster, a log query kept exceeding the memory limit after the plugin memory was raised from 4G to 10G. The error stopped only after the environment was scaled out. A `MEMORY_LIMIT_EXCEEDED` with a `maximum` of about 3.6 GiB at a 4Gi limit is covered in [nevermore and ClickHouse log components alert on CPU or memory, restart, or ignore new resource values on ACP](./nevermore_and_ClickHouse_log_components_alert_on_CPU_or_memory_restart_or_ignore_new_resource_values_on_ACP.md).

### Cause 3: One logging node filled, and after expansion the audit tables are read-only

The pod restart loop says the disk is full. After expansion the pod is `Running`, and the console works for a while if you widen the time range. Then queries fail again. The database log on that node shows errors, some audit tables are read-only (`is_readonly = 1`), and the three nodes do not hold the same amount of data.

A likely way to get there is an earlier uninstall and reinstall in which only some of the nodes had their data cleaned. Expansion alone does not make the replicas match. The repair is to remove the bad node from the ClickHouse cluster, join it again, and reinstall ClickHouse.

A size difference between replicas is not this cause by itself. Replicas of the 3-replica logging ClickHouse normally differ by tens of gigabytes.

### Cause 4: System component logs dominate the ClickHouse volume

Most of the stored volume comes from `cpaas-system` workloads. Their log level can be lowered directly on the component. The collector has no switch that drops one namespace's debug lines, so the volume has to be cut at the source or kept for fewer days. Do not change the log level of the MetalLB components without first confirming the change with product support.

### Cause 5: Logging ClickHouse pods exit with code 137 and the plugin memory limit is too low

All three logging ClickHouse pods restart repeatedly, with container exit code `137`. Raising the ClickHouse plugin memory limit stops the restarts. CPU and memory utilization can stay high afterwards.

Exit code `137` means only that the container received SIGKILL. A kernel out-of-memory kill is normally reported as `Reason: OOMKilled`. With `Reason: Error`, the kubelet may have killed the container after failed liveness probes. If the events repeat `Liveness probe failed` on `:8123/ping` with `connection refused` for days, and `clickhouse-operator` in `ck-system` is in `CrashLoopBackOff`, the database is broken rather than short of memory. See [ClickHouse log queries fail after the log storage had been working: missing tables or broken parts on ACP](./ClickHouse_log_queries_fail_after_the_log_storage_had_been_working_missing_tables_or_broken_parts_on_ACP.md) (Cause 5). The same article covers tables that are still missing after the restarts stop (Cause 2).

### Cause 6: A ClickHouse managed by its own ClickHouseInstallation restarts with OOMKilled

The container of a ClickHouse that is not the logging plugin keeps restarting, and its events show OOM. The instance is a `ClickHouseInstallation` in its own namespace, for example with pod template `clickhouse:21.8` and container `clickhouse-pod`. The fix is made on the ClickHouseInstallation, because the operator rebuilds the StatefulSet from it. Raise the memory requests and limits of `clickhouse-pod` (to 8Gi in a confirmed fix). Set `max_server_memory_usage` below the limit (6Gi, `6442450944`), so that ClickHouse refuses work before the kernel kills it.

## Resolution

### Cause 1: ClickHouse slow-query logs filled the node disk

1. Confirm which volume is full before you delete anything:

   ```bash
   df -hT / /cpaas /cpaas/ck
   kubectl -n cpaas-system get sts,pod,pvc | grep -i slowsql
   ```

2. If the slow-query instance is in use, find the largest tables and truncate only the log table at the top of that list (usually `system.query_log`):

   ```bash
   kubectl -n cpaas-system exec chi-pxc-ck-slowsql-cluster-0-0-0 -c clickhouse-pod -- clickhouse-client --query \
     "SELECT database, table, formatReadableSize(sum(bytes_on_disk)) AS size FROM system.parts WHERE active GROUP BY database, table ORDER BY sum(bytes_on_disk) DESC LIMIT 10"
   ```

   > **Warning:** `TRUNCATE` permanently removes all rows of that table. Precondition: only for a ClickHouse system log table (such as `system.query_log`) that the list above shows as the largest. Never truncate tables of the `observability` database. Rollback: none.

   ```bash
   kubectl -n cpaas-system exec chi-pxc-ck-slowsql-cluster-0-0-0 -c clickhouse-pod -- clickhouse-client --query "TRUNCATE TABLE system.query_log"
   ```

   Do not delete files under `/cpaas/ck` by hand while the slow-query pod runs.

3. If the slow-query instance is not used, stop it instead.

   > **Warning:** Setting the replica count to 0 and deleting the PVC removes the slow-query history and stops slow-query collection. MySQL pods are not affected. Uninstalling the operator also removes its CSV and Subscription, so reinstall the operator if another ClickHouse still needs it. Precondition: the pod you stop is `chi-pxc-ck-slowsql-cluster-0-0-0`, not the logging cluster, and nobody uses the slow-query console. Rollback: scale the replicas back to the previous count. Data on the deleted PVC does not return.

   ```bash
   kubectl -n cpaas-system scale sts/chi-pxc-ck-slowsql-cluster-0-0 --replicas=0
   kubectl -n cpaas-system delete pvc <slowsql-pvc>
   ```

   If an operator scales the StatefulSet back up, set the replicas to 0 on the ClickHouseInstallation that owns it, uninstall that operator, and delete the PVC again.

### Cause 2: The logging ClickHouse is out of CPU or memory

1. Check usage on the logging pods. Ignore pods that match `slowsql`.

   ```bash
   kubectl -n cpaas-system top pod | grep -i clickhouse
   kubectl -n cpaas-system get pods -o wide | grep -i clickhouse
   ```

2. Add capacity.

   > **Warning:** Raising the resources of the logging ClickHouse, or scaling it, restarts replicas, and queries fail over while they roll. Precondition: `top` shows CPU or memory near 100% on the logging pods (not on `chi-pxc-ck-slowsql-cluster`), and the nodes have the extra CPU and memory. Rollback: set the previous values on the plugin again.

   Set the new CPU and memory on the Log Storage for ClickHouse cluster plugin, so the plugin does not write the old values back. No single size is prescribed. Size from `top` and the free memory on the nodes. A node that ingests logs from two clusters needs a larger size even when average CPU looks moderate. When more memory does not stop query memory errors, scale the environment out instead.

### Cause 3: One logging node filled, and after expansion the audit tables are read-only

1. Expand the disk or the PVC so the pod stays `Running`. A wider time range in the console only proves that some parts are readable.

2. On each replica, compare the read-only flags. Newer images use `clickhouse client`, older images `clickhouse-client`.

   ```bash
   kubectl -n cpaas-system exec <ck-pod> -c clickhouse -- clickhouse-client --query \
     "SELECT database, table, is_readonly, absolute_delay FROM system.replicas ORDER BY is_readonly DESC"
   ```

3. Rejoin the bad node.

   > **Warning:** Removing the bad logging node and reinstalling ClickHouse drops parts that existed only on that node, and log search is down during the reinstall. Precondition: the disk is already large enough for the pod to run, `system.replicas` shows read-only audit tables on that node, console queries still fail after expansion, and you have a maintenance window. A replica whose size differs from the other two is not enough by itself. Rollback: none for parts that were only on the removed node.

   Take the abnormal node out of the ClickHouse cluster, join it again, and reinstall the log storage plugin through the original install path. Do not empty the data on the healthy replicas to force them to match, and do not uninstall again without removing the bad node.

### Cause 4: System component logs dominate the ClickHouse volume

1. Rank namespaces and components by log volume in the console.

2. Lower the log level on the `cpaas-system` Deployments that dominate. Use the setting that each component already documents: a flag such as `--v`, an environment variable such as `LOG_LEVEL`, or a configuration file. Leave the MetalLB components at their shipped level.

3. If the volume cannot be cut at the source, shorten the log retention in the log storage settings.

### Cause 5: Logging ClickHouse pods exit with code 137 and the plugin memory limit is too low

1. Read the last termination and the probe events:

   ```bash
   kubectl -n cpaas-system get pod <ck-pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}{" exit="}{.lastState.terminated.exitCode}{" reason="}{.lastState.terminated.reason}{"\n"}{end}'
   kubectl -n cpaas-system describe pod <ck-pod> | grep -i 'liveness probe failed'
   kubectl -n ck-system get pods
   ```

   If the liveness probe on `8123` has failed for days and `clickhouse-operator` is in `CrashLoopBackOff`, stop here and use the article in Cause 5 of Root Cause.

2. Raise the memory limit.

   > **Warning:** Raising memory on the logging ClickHouse rolls its pods, and queries and inserts pause on each pod while it restarts. Precondition: the pods are the logging cluster, not `chi-pxc-ck-slowsql-cluster`, the last exit code is 137, and the nodes have free memory for the new limit. Rollback: set the previous memory limit again.

   Set the new memory limit on the ClickHouse log storage plugin, sized from the usage that led to exit code 137 and from the free memory on the node. If the plugin form is not available, the StatefulSet can be changed directly, but the plugin can write it back:

   ```bash
   kubectl -n cpaas-system set resources sts/<logging-ck-sts> \
     -c <clickhouse-container> --limits=memory=<new-limit>
   ```

   Read the container name with `kubectl -n cpaas-system get pod <ck-pod> -o jsonpath='{.spec.containers[*].name}'`.

3. Watch that the restarts stop.

### Cause 6: A ClickHouse managed by its own ClickHouseInstallation restarts with OOMKilled

1. Confirm the kill reason and the current memory, and save the ClickHouseInstallation:

   ```bash
   kubectl -n <namespace> get chi
   kubectl -n <namespace> get pod <chi-pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}{" exit="}{.lastState.terminated.exitCode}{" reason="}{.lastState.terminated.reason}{"\n"}{end}'
   kubectl -n <namespace> get pod <chi-pod> -o jsonpath='{range .spec.containers[*]}{.name}{" req="}{.resources.requests.memory}{" lim="}{.resources.limits.memory}{"\n"}{end}'
   kubectl -n <namespace> get chi <chi-name> -o yaml > /tmp/<chi-name>.before.yaml
   ```

   Only `reason=OOMKilled` on the ClickHouse container (or OOM in the pod events) matches this cause. `Error` with a failing probe on `8123` does not.

2. Edit the ClickHouseInstallation.

   > **Warning:** Editing the ClickHouseInstallation makes the operator roll the ClickHouse pods of that instance, which stops serving queries and inserts while each pod restarts. Precondition: only when `OOMKilled` is confirmed, the backup above is saved, and the node has the new memory free. Rollback: `kubectl apply -f /tmp/<chi-name>.before.yaml` returns the previous resources and settings, and the pods roll again.

   ```bash
   kubectl -n <namespace> edit chi <chi-name>
   ```

   Change only these three things: `max_server_memory_usage` under `spec.configuration.settings`, and the memory requests and limits of the ClickHouse container in the pod template. Use this instance's pod template name and container name:

   ```yaml
   spec:
     configuration:
       settings:
         max_server_memory_usage: 6442450944   # 6Gi, below the 8Gi limit
     templates:
       podTemplates:
         - name: clickhouse:21.8
           spec:
             containers:
               - name: clickhouse-pod
                 resources:
                   requests:
                     memory: 8Gi
                   limits:
                     memory: 8Gi
   ```

   8Gi and 6Gi are example values. Size both from the instance's usage, and keep `max_server_memory_usage` below the limit.

3. Watch that the restarts stop.

## Diagnostic Steps

1. Separate the ClickHouse installations:

   ```bash
   kubectl get chi -A
   kubectl -n cpaas-system get pods,sts,pvc | grep -Ei 'clickhouse|slowsql|chi-'
   du -sh /cpaas/ck 2>/dev/null
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | `/cpaas/ck` full with `slowsql` pods, or an abnormal `pxc` `chi-ck` pod that nobody uses | Cause 1 |
   | Logging pods at 100% CPU or memory | Cause 2 |
   | One logging node with read-only audit tables after expansion | Cause 3 |
   | `cpaas-system` components dominate the log volume in the console | Cause 4 |
   | Logging ClickHouse pods whose last exit code is 137, without days of failed liveness probes on `8123` | Cause 5 |
   | A ClickHouse outside the logging plugin with container `clickhouse-pod`, last state `OOMKilled` | Cause 6, change the ClickHouseInstallation and not the StatefulSet |

3. The monitoring graphs of the node can stay low while a container is killed. `dmesg` reports `Memory cgroup out of memory` when a container hits its own limit, regardless of node memory.

## Related Information

- [ClickHouse log queries fail after the log storage had been working: missing tables or broken parts on ACP](./ClickHouse_log_queries_fail_after_the_log_storage_had_been_working_missing_tables_or_broken_parts_on_ACP.md)
- [nevermore and ClickHouse log components alert on CPU or memory, restart, or ignore new resource values on ACP](./nevermore_and_ClickHouse_log_components_alert_on_CPU_or_memory_restart_or_ignore_new_resource_values_on_ACP.md)
- [ClickHouse log storage logs RaftInstance errors with pod restarts, merge CPU spikes, or a hand-built ClickHouse on ACP](./ClickHouse_log_storage_logs_RaftInstance_errors_with_pod_restarts_merge_CPU_spikes_or_a_hand-built_ClickHouse_on_ACP.md)
