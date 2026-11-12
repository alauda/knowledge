---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x
---

# nevermore and ClickHouse log components alert on CPU or memory, restart, or ignore new resource values on ACP

## Issue

One of the following is reported for the log components:

- One `nevermore` pod restarted abnormally. Only the log container on that node has high memory, and `nevermore` on every other node is fine.
- On a cluster with dozens of nodes, `nevermore` CPU on one node keeps alerting while the other nodes are normal. The node's CPU is high only at intervals.
- ClickHouse log storage keeps raising high CPU and memory alarms, and adding resources does not stop them.
- The ClickHouse log shows `Memory limit (total) exceeded` with `MEMORY_LIMIT_EXCEEDED`. Log queries may fail at the same time.
- On the global cluster, the ClickHouse StatefulSet runs with values different from the plugin configuration, and restarting `clickhouse-operator` changes nothing.
- The ClickHouse CPU alarm fires on a regular schedule (for example about once an hour, for about 10 minutes), or node load on the management cluster rises at the same time.
- After an upgrade, a new ClickHouse limit set in the console does not take effect.
- "What are the `nevermore` and `zeus` services for? They take 10 cores on a 64-core server. Can that be reduced?"

`nevermore` is the node log collector and runs one pod per node. Its local buffer on the node is `/cpaas/log/data/diskqueue`. ClickHouse is the log store of Alauda Container Platform Log Storage for ClickHouse, managed by `clickhouse-operator` through a ClickHouseInstallation (`chi`). The ClickHouse log often also contains `RaftInstance ... failed to read rpc header from socket ... End of file` every few seconds. That line is benign and unrelated to CPU or memory.

## Root Cause

### Cause 1: The nevermore log container is OOMKilled on one node after a short memory surge

Pod OOM events rise on one node (for example 6 in 30 minutes) and stay at 0 on the others. The `nevermore` log container on that node has a 4G limit. Its usual memory use is a few percent to just over 10%, but a short surge passes 4G and the container is killed. After the log container memory was raised to 5G, it recovered and usage returned below 10%.

### Cause 2: A nevermore CPU alert on one node comes from bursts of business logs

Business logs on that node are written in concentrated bursts. Log file rotation, compression and batch sending then push `nevermore` CPU up for a while, and the alert fires. If the node's local log directory or disk is slow, `nevermore` builds a backlog and processes it all at once, which makes the spike sharper. `/cpaas/log/data/diskqueue` grows during the alert. With a 2-core CPU limit on the log container, the recommendation is 4 cores. The queued data is compressed, so the business log that caused the burst cannot always be identified. Such an alert can clear without further change.

### Cause 3: ClickHouse CPU and memory alarms persist after expansion (known issue)

ClickHouse log storage keeps raising CPU and memory alarms, and more resources do not help. This is a known issue in the log component. It is fixed in `log-4.3.2` (ACP 4.3.2) and not in 4.3.1.

### Cause 4: MEMORY_LIMIT_EXCEEDED in MergeTreeBackgroundExecutor or in log queries

The ClickHouse log shows:

```text
Memory limit (total) exceeded: would use 3.64 GiB (attempt to allocate chunk of 4361312 bytes), maximum: 3.60 GiB
```

with `MEMORY_LIMIT_EXCEEDED` on `MergeTreeBackgroundExecutor`. The `maximum` is close to the 4Gi container limit: background merges, and queries, need more memory than the ClickHouse limit allows. The console can then fail to show logs, and the `vector` sinks retry their inserts. Raising ClickHouse from 2 CPU / 4Gi to 4 CPU / 8Gi removes the error. An `Address already in use` line for `0.0.0.0:9004` in the same log was not related.

### Cause 5: The ClickHouse StatefulSet does not follow the configured resources

The plugin and the `chi` both say 2 CPU / 4G, and no resource patch (`rpch`) exists. However, the StatefulSet runs two replicas at 3 CPU / 6G and one at 4 CPU / 6G. Restarting `clickhouse-operator` does not update the StatefulSet or its pods. Saving the resources on the plugin again triggers the update, and the StatefulSet returns to the configured values.

When the global cluster nodes are too small for ClickHouse (8 CPU per node, with ClickHouse alone driving node CPU high), the lasting change is to move ClickHouse off the global cluster. Store the global cluster's audit data in a business cluster's log storage instead.

### Cause 6: Periodic CPU spikes from MergeTree background merges

The CPU alarm repeats at regular intervals, or CPU spikes about every hour and raises node load on the management cluster. ClickHouse does not restart, and its log during a spike looks the same as at other times. The pod graph shows CPU at 90% to 100% at regular intervals, often as two adjacent peaks at the limit, with 10% to 20% in between. On the node, `top` puts `clickhouse-serv` far above every other process during a spike.

The MergeTree background merge periodically combines small data parts of a partition into larger ones and applies TTL deletes. With high merge-thread concurrency, it takes a lot of CPU for a short time. Raising the limit does not remove the spike: after a 4-core limit was raised to 6 cores, the merges used all 6. This is a known issue, and an optimization has been requested. It does not affect normal ClickHouse operation. A slow `/cpaas` disk makes merges last longer.

### Cause 7: A resource change in the console does not apply because a resource patch already exists

An earlier backend change to the ClickHouse resources created a resource patch (`rpch`). While that `rpch` exists, resource changes made in the console do not reach the ClickHouse StatefulSet. The patch targets the ClickHouseInstallation, not the StatefulSet, and appears like this:

```text
rp-<suffix>  Active  cpaas-system/logclickhouse  clickhouse.altinity.com/v1  ClickHouseInstallation  cpaas-system  cpaas-clickhouse
```

This is the opposite situation to Cause 5, where no `rpch` exists.

### Cause 8: nevermore and zeus appear to take 10 CPU cores

`nevermore` is the log collection component. `zeus` reads the certificate information of the Kubernetes components on each node, generates Secrets from it, and creates the matching Certificate resources so that those certificates can be monitored.

The "10 cores" is the sum of the containers' CPU **limits**, not their requests and not their actual usage. Pod scheduling counts only requests against the node's allocatable CPU, and the sum of limits on a node may exceed the node's physical CPU. The figure therefore takes nothing away from scheduling capacity.

## Resolution

### Cause 1: The nevermore log container is OOMKilled on one node after a short memory surge

1. Read the containers and their limits:

   ```bash
   kubectl -n cpaas-system get ds nevermore -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" "}{.resources.limits}{"\n"}{end}'
   ```

2. Raise the log container memory limit.

   > **Warning:** Changing the DaemonSet restarts `nevermore` on every node, one at a time, and log collection on a node pauses while its pod restarts. Precondition: the OOM events are on the `nevermore` log container, and each node has the extra memory free. Rollback: set the previous limit with the same command.

   ```bash
   kubectl -n cpaas-system set resources ds/nevermore -c <log-container> --limits=memory=5Gi
   ```

3. If the log collection plugin renders `nevermore` with its own resource values, set the same limit there. After the next plugin update, check that the DaemonSet still has the new limit.

### Cause 2: A nevermore CPU alert on one node comes from bursts of business logs

1. Confirm that the CPU on that node's `nevermore` is intermittent and lines up with business log bursts or `diskqueue` growth (Diagnostic Steps 1 and 2).

2. Raise the log container CPU limit so the peaks are absorbed. A CPU limit does not reserve resources up front.

   > **Warning:** This restarts `nevermore` on every node, as in Cause 1. Precondition: the nodes have CPU headroom at peak. Rollback: set the CPU limit back to 2.

   ```bash
   kubectl -n cpaas-system set resources ds/nevermore -c <log-container> --limits=cpu=4
   ```

3. Compare the node's business log volume with other nodes, and check the write speed of the local log disk. A slow disk keeps the backlog pattern even with a higher limit.

### Cause 3: ClickHouse CPU and memory alarms persist after expansion (known issue)

Upgrade the log components to `log-4.3.2` (ACP 4.3.2), using the package provided by Alauda support. More CPU and memory do not fix this cause. A ClickHouse that is still at 2 CPU / 4Gi and logs `MEMORY_LIMIT_EXCEEDED` needs Cause 4 first.

### Cause 4: MEMORY_LIMIT_EXCEEDED in MergeTreeBackgroundExecutor or in log queries

1. Read the live requests and limits of every replica:

   ```bash
   kubectl -n cpaas-system get pods | grep chi-cpaas-clickhouse
   kubectl -n cpaas-system get pod <ck-pod> -o jsonpath='{range .spec.containers[*]}{.name}{" req="}{.resources.requests.cpu}{"/"}{.resources.requests.memory}{" lim="}{.resources.limits.cpu}{"/"}{.resources.limits.memory}{"\n"}{end}'
   ```

   Continue only when the `maximum` in the error is close to the current memory limit (for example 3.60 GiB at 4Gi).

2. Raise the resources.

   > **Warning:** Saving new resources on the plugin rolls the ClickHouse pods, and log writes and queries are degraded until every replica is Ready again. Precondition: the nodes that run ClickHouse have 4 CPU and 8Gi free for each replica. Rollback: set the plugin back to the previous values and save.

   In the console, open the Alauda Container Platform Log Storage for ClickHouse plugin on the affected cluster. Set CPU to 4 and memory to 8Gi, and save.

3. When the pods are Ready, read the limits again. If they still show the old values, check for a resource patch or a StatefulSet that does not follow the plugin (Causes 5 and 7).

### Cause 5: The ClickHouse StatefulSet does not follow the configured resources

1. Confirm the drift (Diagnostic Step 4): the StatefulSet differs from both the plugin and the `chi`, and no `rpch` exists for it.

2. Re-apply the resources from the plugin.

   > **Warning:** Re-applying the resources rolls the ClickHouse pods, and log writes and queries are degraded until all replicas are Ready. Precondition: the drift is confirmed. Rollback: none needed; this applies the values the plugin already holds.

   Open Alauda Container Platform Log Storage for ClickHouse in the console, change the CPU and memory values and save, so that an update is triggered. Check that the StatefulSet now matches. Restarting `clickhouse-operator` alone does not do this.

3. If the global nodes are too small to host ClickHouse, move it off the global cluster.

   > **Warning:** Uninstalling ClickHouse log storage from the global cluster deletes the logs stored there, which is irreversible. Precondition: a business cluster's log storage is set up to receive the global cluster's audit data, and the owner accepts losing the stored global logs. Rollback: reinstall the plugin on the global cluster; the old data does not return.

   Uninstall the plugin from the global cluster in the console. Then confirm that new global audit records arrive in the business cluster's log storage.

### Cause 6: Periodic CPU spikes from MergeTree background merges

1. Confirm that the spikes line up with merges (Diagnostic Step 5).

2. Make sure the CPU limit leaves the node headroom during a spike. Raising the limit does not remove the spike.

3. To stop frequent alerts in the meantime, lengthen the trigger duration of the ClickHouse CPU alert rule beyond the length of one merge spike. Edit the rule in the alert policy that holds it, and note the old duration so that you can set it back.

4. If the log components are older than `log-4.3.2` and the alarms persist after expansion, also apply Cause 3.

### Cause 7: A resource change in the console does not apply because a resource patch already exists

1. Confirm that a patch exists for ClickHouse:

   ```bash
   kubectl get rpch -A | grep -i clickhouse
   ```

2. Set the resources on the StatefulSet.

   > **Warning:** Editing the StatefulSet rolls the ClickHouse pods, and log writes and queries are degraded until all replicas are Ready. Precondition: the `rpch` exists, you saved the StatefulSet YAML, and the nodes have the capacity. Rollback: `kubectl apply -f /tmp/clickhouse-sts.before.yaml`.

   ```bash
   kubectl -n cpaas-system get sts <clickhouse-sts> -o yaml > /tmp/clickhouse-sts.before.yaml
   kubectl -n cpaas-system edit sts <clickhouse-sts>
   ```

   Set the container resources there. Console changes stay blocked while the `rpch` exists.

### Cause 8: nevermore and zeus appear to take 10 CPU cores

No reduction is needed. The 10 cores are the combined CPU limits of `nevermore` and `zeus`. Limits do not reserve CPU and do not reduce what the scheduler can place on the node. The only condition is that the actual CPU usage of all containers on the node stays below the node's total CPU. Show the three numbers side by side: requests, limits and live usage (Diagnostic Step 6).

## Diagnostic Steps

1. For `nevermore`, find the node, the container and the reason:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep nevermore
   kubectl -n cpaas-system get pod <nevermore-pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}{" restarts="}{.restartCount}{" last="}{.lastState.terminated.reason}{"\n"}{end}'
   kubectl -n cpaas-system top pod --containers | grep nevermore
   ```

   `OOMKilled` on the log container of one node is Cause 1. CPU near the 2-core limit on one node, without restarts, is Cause 2.

2. On the alerting node, watch the disk queue during an alert:

   ```bash
   du -sh /cpaas/log/data/diskqueue
   top -b -n 1 | head -20
   ```

   Growth during the alert and a quiet queue outside it support Cause 2.

3. Check the ClickHouse version and log lines:

   ```bash
   kubectl -n cpaas-system logs <ck-pod> -c clickhouse --tail=500 | grep -E 'MEMORY_LIMIT_EXCEEDED|Memory limit'
   ```

   Alarms that stay after expansion on log components older than 4.3.2 are Cause 3. `MEMORY_LIMIT_EXCEEDED` with a `maximum` near the limit is Cause 4.

4. Compare the plugin, the `chi` and the StatefulSet:

   ```bash
   kubectl -n cpaas-system get chi cpaas-clickhouse -o yaml | grep -n -A6 resources
   kubectl -n cpaas-system get sts | grep -i clickhouse
   kubectl -n cpaas-system get sts <clickhouse-sts> -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" "}{.resources}{"\n"}{end}'
   kubectl get rpch -A 2>/dev/null | grep -i clickhouse || true
   ```

   `chi` values that differ from the StatefulSet with no `rpch` are Cause 5. A console change that does not apply while an `rpch` for ClickHouse exists is Cause 7.

5. During a periodic CPU spike, list the running merges:

   ```bash
   kubectl -n cpaas-system exec <ck-pod> -c clickhouse -- clickhouse-client \
     --query "SELECT database, table, elapsed, progress, num_parts FROM system.merges"
   ```

   Active merges during each spike, with an unchanged log and no restart, are Cause 6.

6. For CPU attributed to `nevermore` and `zeus`, compare requests, limits and usage on one node:

   ```bash
   kubectl get pods -A -o wide --field-selector spec.nodeName=<node> | grep -E 'nevermore|zeus'
   kubectl -n <namespace> get pod <pod> -o jsonpath='{range .spec.containers[*]}{.name}{" req="}{.resources.requests.cpu}{" lim="}{.resources.limits.cpu}{"\n"}{end}'
   kubectl -n <namespace> top pod <pod> --containers
   kubectl describe node <node> | sed -n '/Allocated resources/,/Events/p'
   ```

   A large total under `lim=` with small requests and low `top` values is Cause 8. In `Allocated resources`, the `Limits` column may be above 100%. The `Requests` column is what scheduling uses.

## Related Information

- [ClickHouse log storage logs RaftInstance errors with pod restarts, merge CPU spikes, or a hand-built ClickHouse on ACP](./ClickHouse_log_storage_logs_RaftInstance_errors_with_pod_restarts_merge_CPU_spikes_or_a_hand-built_ClickHouse_on_ACP.md), for the benign `RaftInstance ... End of file` line.
- [Logging ClickHouse runs out of disk, CPU or memory, or is OOMKilled on ACP](./Logging_ClickHouse_runs_out_of_disk_CPU_or_memory_or_is_OOMKilled_on_ACP.md)
- [nevermore OOMKilled, cache written to /var/cpaas, or callback-secret mount failure on ACP](./nevermore_OOMKilled_cache_written_to_var_cpaas_or_callback-secret_mount_failure_on_ACP.md)
