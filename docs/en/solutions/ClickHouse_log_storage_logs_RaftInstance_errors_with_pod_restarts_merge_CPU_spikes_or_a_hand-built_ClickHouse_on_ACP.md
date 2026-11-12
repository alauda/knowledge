---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# ClickHouse log storage logs RaftInstance errors with pod restarts, merge CPU spikes, or a hand-built ClickHouse on ACP

## Issue

The ClickHouse log storage (Alauda Container Platform Log Storage for ClickHouse) runs in `cpaas-system` as pods `chi-cpaas-clickhouse-replicated-<shard>-<replica>-0` with container `clickhouse`. ClickHouse Keeper runs inside the same container, and its Raft traffic between replicas uses port `9444`. The `clickhouse` container log contains `RaftInstance` errors such as:

```text
<Error> RaftInstance: session 13 failed to read rpc header from socket ... due to error 2, End of file
```

Typical questions are:

- "ClickHouse keeps printing error logs but nothing seems broken. Is this normal?"
- "ClickHouse keeps restarting after the platform upgrade."
- "A `chi-cpaas-clickhouse-replicated` pod has high CPU and its log says `failed to read rpc header from socket`."
- "We deployed our own ClickHouse, switched the log collector to it, and log query is unavailable."

Sometimes this line is the only symptom: no restarts, and log query and ingestion work. In that case it is benign reconnect noise (Cause 4). The line does not identify a fault by itself, because it also appears next to unrelated faults. Use the other signatures below to find the real cause.

## Root Cause

### Cause 1: After an upgrade, the pods restart repeatedly with Election timeout and pre-vote failures while CPU sits at its limit

After the platform was upgraded (for example from 4.1.3 to 4.2.1), the logging ClickHouse on the `global` cluster kept restarting on all three replicas, with limits of 2 cores / 4Gi per pod. The previous `clickhouse` container log repeats:

```text
<Warning> RaftInstance: Election timeout, initiate leader election
RaftInstance: total 1 nodes (including this node) responded for pre-vote (term 16750, live 0, dead 1), at least 2 nodes should respond
failed to send prevote request: peer 3 (chi-cpaas-clickhouse-replicated-0-2.cpaas-system.svc.cluster.local:9444) is busy
peer (1) response error: failed to connect to peer 1, chi-cpaas-clickhouse-replicated-0-0.cpaas-system.svc.cluster.local:9444
```

The `log/Cpaas Log Center for Clickhouse` dashboard shows CPU at 100% of the 2-core limit again and again, and memory at about 20% or less. ClickHouse needs more CPU during startup after the upgrade than the limit allows. As a result, Raft leader election between the replicas fails and the pods restart. The exact internal mechanism has not been determined. Temporarily raising the limits on the cluster plugin (to 16 cores / 16Gi) lets the pods start, and CPU then settles at about 2 cores. Once started, the pods keep running when the limits are set back to 2 cores / 4Gi.

### Cause 2: CPU of a ClickHouse pod spikes while ClickHouse merges data parts

A `chi-cpaas-clickhouse-replicated` pod shows high CPU, and its log shows `failed to read rpc header from socket`. The ClickHouse log shows automatic merges of data parts. The scheduled merge tasks run with high concurrency, so CPU spikes for a short time. This is known behavior. It does not affect the logging component, and no remediation is needed. A later release is expected to optimize merge CPU usage.

### Cause 3: Log query is unavailable because ClickHouse was deployed by hand instead of through the cluster plugin

A ClickHouse instance was deployed on a cluster by hand, and the log collector was switched to it. Afterwards log query is unavailable. The ClickHouse operator pod and `chi-cpaas-clickhouse-replicated-0-0-0` in `cpaas-system` are `Running`, and the ClickHouse log repeats `RaftInstance: session NNNN failed to read rpc header from socket ... due to error 2, End of file, ref count 1`. The platform log query works only with ClickHouse installed as the standard cluster plugin (Alauda Container Platform Log Storage for ClickHouse). After the plugin was redeployed, log query verification succeeded.

### Cause 4: RaftInstance failed to read rpc header ... End of file repeats while ClickHouse works normally

```text
<Error> RaftInstance: session NNNN failed to read rpc header from socket <peer>:<port> due to error 2, End of file, and reset
<Error> RaftInstance: session NNNN failed to read header ... End of file
```

The ClickHouse log keeps printing these lines, often at a steady interval (for example every 10 seconds on one replica). The pods do not restart, and log query and ingestion work. The error count can look alarming in a log viewer or a log-keyword alert.

ClickHouse Keeper keeps long-lived TCP connections between the replicas for Raft (port `9444`). When the far side closes one of these connections, the reading end gets end-of-file. Short-lived connections, such as those opened by readiness probes, end the same way. So do idle connections that a firewall or NAT device between the nodes reclaims. Keeper logs this line each time, then reconnects automatically and rebuilds the Raft session. The message is benign communication noise. It is not a Keeper failure and not a sign that the log store is short of resources, and it needs no action.

## Resolution

### Cause 1: After an upgrade, the pods restart repeatedly with Election timeout and pre-vote failures while CPU sits at its limit

1. Confirm the signature:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep chi-cpaas-clickhouse-replicated
   kubectl -n cpaas-system logs <ck-pod> -c clickhouse --previous | grep -E 'Election timeout|pre-vote|prevote|failed to connect to peer' | tail -10
   kubectl -n cpaas-system top pod | grep chi-cpaas-clickhouse-replicated
   ```

   Election timeouts and pre-vote failures, with CPU pinned at the limit on every replica, match this cause. Memory far below its limit rules out an out-of-memory kill.

2. Raise the limits temporarily.

   > **Warning:** Changing the ClickHouse resources on the cluster plugin rolls the ClickHouse pods. Log queries and inserts pause on each pod while it restarts, and `vector` buffers the data in the meantime. Precondition: only when this cause is confirmed, and the nodes have the CPU and memory for the temporary limit. Rollback: set the previous limits on the plugin again.

   Raise the ClickHouse CPU and memory limits on the Log Storage for ClickHouse cluster plugin (Marketplace, Cluster Plugins, select the cluster, update the plugin). Do not change them on the StatefulSets, because the plugin writes the old values back.

3. Wait until all replicas are `Running` and CPU has settled. If the nodes cannot keep the larger reservation, set the limits back to the previous values. After startup completes, the pods can keep running at 2 cores / 4Gi.

### Cause 2: CPU of a ClickHouse pod spikes while ClickHouse merges data parts

Confirm that the spike is merge work and that logging still works:

```bash
kubectl -n cpaas-system exec <ck-pod> -c clickhouse -- \
  clickhouse-client --query "SELECT database, table, elapsed, progress, num_parts FROM system.merges"
kubectl -n cpaas-system top pod | grep chi-cpaas-clickhouse-replicated
```

Rows in `system.merges` during the spike, with log query and ingestion working, match this cause. No change is needed. If the pod restarts or queries fail at the same time, use Cause 1, or see [Logging ClickHouse runs out of disk, CPU or memory, or is OOMKilled on ACP](./Logging_ClickHouse_runs_out_of_disk_CPU_or_memory_or_is_OOMKilled_on_ACP.md).

### Cause 3: Log query is unavailable because ClickHouse was deployed by hand instead of through the cluster plugin

1. Check whether the ClickHouse log storage is installed as the cluster plugin. On the global cluster:

   ```bash
   kubectl get minfo | grep -i clickhouse | grep <cluster-name>
   ```

   In the console, also open Marketplace, Cluster Plugins, select the cluster, and look for Alauda Container Platform Log Storage for ClickHouse. A ClickHouse that runs in the cluster with no matching plugin entry matches this cause.

2. Replace it with the plugin.

   > **Warning:** Removing the hand-built ClickHouse deletes everything it stored. Logs written to it are lost unless they are exported first, and log query stays unavailable until the plugin is installed. Precondition: only when this cause is confirmed and the owner accepts the loss of the hand-built instance's data. Rollback: none for the removed data.

   Remove the hand-built ClickHouse with the same method that created it. Then install Alauda Container Platform Log Storage for ClickHouse on the cluster from Marketplace, Cluster Plugins. Choose the plugin version that supports the current platform version.

3. Point the log collector at the plugin storage, and query the logs of a pod that is logging now.

### Cause 4: RaftInstance failed to read rpc header ... End of file repeats while ClickHouse works normally

1. Confirm that nothing else is wrong:

   ```bash
   kubectl -n cpaas-system get pods | grep chi-cpaas-clickhouse-replicated
   kubectl -n cpaas-system get pod <ck-pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}{" restarts="}{.restartCount}{" last="}{.lastState.terminated.reason}{"\n"}{end}'
   kubectl -n cpaas-system logs <ck-pod> -c clickhouse --since=1h \
     | grep -v 'RaftInstance' | grep -E '<Error>|<Fatal>|MEMORY_LIMIT_EXCEEDED|Election timeout|pre-vote|Address already in use' | tail -20
   kubectl -n cpaas-system exec <ck-pod> -c clickhouse -- \
     clickhouse-client --query "SELECT name FROM system.zookeeper WHERE path = '/'"
   ```

2. This cause is confirmed when all of the following hold:
   - The restart counts do not grow.
   - The second listing is empty, meaning there is no other `<Error>` or `<Fatal>` line.
   - The Keeper query answers with a list of znodes.
   - A console log search returns current entries.

   Ignore the line. No configuration change, restart, or resource change is needed.

3. If the restart count grows or log query fails, the line is only a bystander. Use Causes 1 to 3, or the articles under Related Information. `MEMORY_LIMIT_EXCEEDED` or CPU and memory alerts are covered in [nevermore and ClickHouse log components alert on CPU or memory, restart, or ignore new resource values on ACP](./nevermore_and_ClickHouse_log_components_alert_on_CPU_or_memory_restart_or_ignore_new_resource_values_on_ACP.md).

## Diagnostic Steps

1. Read the pod state and restart counts:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep -E 'clickhouse|razor'
   kubectl -n cpaas-system get pod <ck-pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}{" restarts="}{.restartCount}{" exit="}{.lastState.terminated.exitCode}{"\n"}{end}'
   ```

2. Read the previous `clickhouse` log and match it to a cause:

   | What you see | Cause |
   |---|---|
   | `Election timeout` and `at least 2 nodes should respond`, with CPU at the limit after an upgrade | Cause 1 |
   | `failed to read rpc header from socket` with a short CPU spike and active rows in `system.merges` | Cause 2 |
   | A ClickHouse that is not installed as the Log Storage for ClickHouse cluster plugin | Cause 3 |
   | Only `failed to read rpc header ... End of file`, no restarts, and working log query | Cause 4, no action needed |

3. Exit code `137` points to a memory limit or a failed liveness probe, not to Raft. See [Logging ClickHouse runs out of disk, CPU or memory, or is OOMKilled on ACP](./Logging_ClickHouse_runs_out_of_disk_CPU_or_memory_or_is_OOMKilled_on_ACP.md) and [ClickHouse log queries fail after the log storage had been working: missing tables or broken parts on ACP](./ClickHouse_log_queries_fail_after_the_log_storage_had_been_working_missing_tables_or_broken_parts_on_ACP.md).

## Related Information

- [ClickHouse log storage plugin install fails or ClickHouse does not start on ACP](./ClickHouse_log_storage_plugin_install_fails_or_ClickHouse_does_not_start_on_ACP.md), for first installs that never become ready, including Keeper port errors.
- [Logging ClickHouse runs out of disk, CPU or memory, or is OOMKilled on ACP](./Logging_ClickHouse_runs_out_of_disk_CPU_or_memory_or_is_OOMKilled_on_ACP.md)
- [ClickHouse log queries fail after the log storage had been working: missing tables or broken parts on ACP](./ClickHouse_log_queries_fail_after_the_log_storage_had_been_working_missing_tables_or_broken_parts_on_ACP.md)
