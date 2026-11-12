---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Log query shows no logs, HTTP 500, slow long ranges, or an empty real-time log on ACP

## Issue

The log store holds the data, but the console does not show it. Typical reports:

- "No logs in Operations Center, although `razor`, ClickHouse and `nevermore` are normal and their logs show no errors."
- "ClickHouse runs normally, and the ClickHouse database contains the data."
- "The real-time log is empty, and the raw logs are garbled."
- "A keyword is found over the last 6 hours but shows no data over the last day."
- "A filter that matches 59 lines still takes two minutes."
- "Cluster logs are empty after we moved to ClickHouse, and the browser shows HTTP 500."

The failure is on the query or display path between the console and the storage, not in collection. Open the browser developer tools on the failing page first. The status and body of the log query request decide which cause applies.

Keyword, time-window and page-scope mistakes are covered in [Log search misses entries: IK analyzer tokens, uppercase keywords, clock skew, or page scope on ACP](./Log_search_misses_entries_IK_analyzer_tokens_uppercase_keywords_clock_skew_or_page_scope_on_ACP.md).

## Root Cause

### Cause 1: Operations Center shows no logs while the whole pipeline is healthy, because the clock of the computer running the browser is wrong

After log center, ClickHouse and the log collector were installed (ACP 4.3.3), Operations Center shows no logs, even with product logs and Kubernetes logs both selected in the collector. `nevermore` uploads normally, and the `vector`, ClickHouse, `courier-api` and `alb` logs show no errors. A manual query in ClickHouse finds current rows. Synchronizing the node clocks and reinstalling the components with their data cleared does not help.

The system time of the computer that opens the console is wrong, and that alone is enough to leave Operations Center empty. The log pipeline itself works.

### Cause 2: The real-time log view stays empty because a reverse proxy in front of the platform does not forward WebSocket

The pod's real-time log in the console is empty or never loads, and raw logs may look garbled. The backend pod returns the data without error. Two breaks can be on this path:

- A node clock is out of sync, which makes log API authentication fail, and the platform gateway blocks the WebSocket requests. Calibrating the time fixes this part.
- An Nginx reverse proxy was added in front of the platform VIP without WebSocket forwarding settings, so the `wss` handshake never passes. Going to the platform VIP directly restores the live log.

### Cause 3: A query over a long time range returns no data or takes minutes, because Elasticsearch or the storage is overloaded

A keyword finds matches over the last 6 hours but shows no data over the last day. The global log storage had 3 log nodes with a 1 core / 2Gi limit, and one project kept logs for 30 days. A 3-day keyword query on one namespace matched about 14 million entries. The page also states that only the first 10,000 matched entries can be viewed and asks for a narrower filter. When the range holds a large log volume, filtering for one entry overwhelms Elasticsearch and the query fails.

On ClickHouse log storage, a filtered query that matched only about 59 lines took almost 2 minutes, and the query memory chart spiked to 6 to 7 GiB again and again. The storage was NAS. The log component capacity planning documentation gives the benchmark disk as 6000 IOPS and 250 MB/s read/write on a dedicated SSD mount. Storage below that needs a larger-scale configuration with more CPU and memory. An `fio` test against those numbers showed that the disk was too slow.

When every Elasticsearch query is slow and the Elasticsearch logs report errors, the component lacks the capacity for the query load. Raising the Elasticsearch memory limit triggers a rolling update, after which index queries return to normal and the errors stop.

### Cause 4: Queries return HTTP 500 and global apollo logs cache error after the store was switched to ClickHouse

Elasticsearch was replaced by ClickHouse on a workload cluster. ClickHouse holds the log rows, but the console shows `共 0 条日志` ("0 logs in total"). In the browser developer tools, requests to `logs?action=aggregation&type=workload...` fail with:

```text
code: 500, message: "unknown action: aggregation", reason: "Unknown", status: "Failure"
```

`apollo` on the global cluster logs `cache error`. Global `apollo` reaches the workload cluster's ClickHouse through that cluster's load balancer `/clickhouse` endpoint. A known issue keeps `apollo` on a stale cache of the cluster's data-access information after the switch. Restarting `apollo` on the global cluster makes the logs queryable.

The ClickHouse replicas may also log `RaftInstance: session ... failed to read rpc header from socket ... End of file` repeatedly, and Vector may log ClickHouse health-check failures. Neither causes the 500.

### Cause 5: The global cluster cannot reach the business cluster apiserver on 6443

The business cluster's `nevermore` is Ready, `razor` logs authentication failures, and the global `cluster-transformer` cannot reach the business cluster's API VIP on port 6443. Queries for that cluster return nothing. Opening that path from all global nodes, not only the first control-plane node, restores queries.

Port 11781 is another port that centralized logging uses between the global and business clusters. A closed 11781 can appear beside the 6443 break without being its cause. Do not disable 11781 on a centralized-logging design that still needs it. Port 11780 on the log cluster's load balancer is the log sink port from platform 4.0 onward, so log shipping connections land on it. A connection count on 11780 that rises from almost 0 to several thousand after an upgrade to 4.0 is expected.

## Resolution

### Cause 1: Operations Center shows no logs while the whole pipeline is healthy, because the clock of the computer running the browser is wrong

1. Compare the clock of the computer that runs the browser with a cluster node. On a node:

   ```bash
   date -u
   ```

   On a Windows client, `w32tm /stripchart /computer:<ntp-server> /samples:3` shows the offset from a time server. A client clock that is off while the nodes agree matches this cause.

2. Correct the client's date, time and time zone, or enable automatic time synchronization on it (on Windows, `w32tm /resync` after a time source is configured).

3. Reload the console and query again. Opening the console from another computer with a correct clock is a quick confirmation. Check this before you reinstall any log component.

### Cause 2: The real-time log view stays empty because a reverse proxy in front of the platform does not forward WebSocket

1. Check the node clocks first with `date -u` on each node, and fix any skew.

2. Open the browser developer tools on the pod log page and look at the `wss` request. A handshake that fails only through the proxy, and works against the platform VIP directly, matches this cause.

3. Add WebSocket forwarding to the Nginx `location` that proxies the platform, for example:

   ```nginx
   proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   proxy_read_timeout 3600s;
   ```

   Reload Nginx and retry. Until the proxy is fixed, use the platform VIP directly.

### Cause 3: A query over a long time range returns no data or takes minutes, because Elasticsearch or the storage is overloaded

1. Narrow the time range, and add exact conditions (cluster, namespace, pod) before the keyword.

2. If even small result sets take minutes, measure the log storage disk on the log storage node, against the filesystem of the data directory:

   ```bash
   fio --name=randwrite --directory=<log-data-dir> --rw=randwrite --bs=4k --size=1G \
     --ioengine=libaio --direct=1 --iodepth=32 --runtime=60 --time_based --group_reporting
   ```

   Remove the test file afterwards. Compare the result with the documented benchmark of 6000 IOPS and 250 MB/s on a dedicated SSD. A disk below the requirement has to be replaced, or the log storage sized up with more CPU and memory. Storing each cluster's logs in that cluster also spreads the query load.

3. When every Elasticsearch query is slow and the Elasticsearch log shows errors, compare its memory with the limit:

   ```bash
   kubectl -n cpaas-system top pod | grep cpaas-elasticsearch
   kubectl -n cpaas-system logs cpaas-elasticsearch-0 -c cpaas-elasticsearch --tail=100 | grep -E 'WARN|ERROR'
   ```

   > **Warning:** Raising the Elasticsearch memory limit rolls every Elasticsearch pod, and search and ingestion pause on each pod while it restarts. Precondition: only when queries are slow across the board, Elasticsearch memory is near its limit, and the nodes can give the new limit. Rollback: set the previous limit back on the log storage plugin.

   Change the memory limit on the log storage plugin, and let the rolling update finish before you test again.

### Cause 4: Queries return HTTP 500 and global apollo logs cache error after the store was switched to ClickHouse

1. On the global cluster, check `apollo`:

   ```bash
   kubectl -n cpaas-system get pods | grep apollo
   kubectl -n cpaas-system logs deploy/apollo --tail=100 | grep -i 'cache error'
   ```

2. Restart `apollo`. If `get pods` shows a different owner kind, use that kind in the restart.

   > **Warning:** Restarting `apollo` on the global cluster briefly interrupts the console API calls it serves. Precondition: only when ClickHouse on the workload cluster holds current rows, the browser shows HTTP 500 with `unknown action: aggregation` on log queries, and global `apollo` logs `cache error`. Rollback: none needed; the rollout does not change the spec.

   ```bash
   kubectl -n cpaas-system rollout restart deploy/apollo
   kubectl -n cpaas-system rollout status deploy/apollo
   ```

### Cause 5: The global cluster cannot reach the business cluster apiserver on 6443

1. From each global node, test the business cluster API VIP (the address in that cluster's kubeconfig):

   ```bash
   nc -vz <business-api-vip> 6443
   nc -vz <business-log-vip> 11781
   ```

2. Restore the 6443 path (security group, route or VIP listener). Queries should return without a pod restart.

3. Leave 11781 enabled when centralized logging is in use. Disable the 11781 load-balancer health check only after you have confirmed that nothing listens on it and the design does not need the port.

## Diagnostic Steps

1. Open the browser developer tools on the failing page and read the log query request:

   | What you see | Cause |
   |---|---|
   | No HTTP error, current rows in ClickHouse or Elasticsearch, every component healthy, and still no logs | Cause 1, compare the browser computer's clock with a node |
   | A `wss` request that fails while `kubectl logs` works | Cause 2 |
   | A narrow range works and a wide one fails, or small results take minutes | Cause 3 |
   | HTTP 500 with `unknown action: aggregation` | Cause 4, read global `apollo` for `cache error` |
   | Queries empty for one business cluster only, with `razor` authentication failures there | Cause 5, test 6443 from the global nodes |

2. To confirm that the store holds the rows, query ClickHouse directly from a replica pod:

   ```bash
   kubectl -n cpaas-system exec -it chi-cpaas-clickhouse-replicated-0-0-0 -c clickhouse -- clickhouse-client
   ```

   ```sql
   SELECT timestamp, log_data FROM observability.log_workload_all
   WHERE match(namespace, '<namespace>') AND match(workload, '<workload>')
     AND timestamp > now() - INTERVAL 1 HOUR
   ORDER BY timestamp DESC LIMIT 20;
   ```

   Rows here with nothing on the page point to the display path (Causes 1, 2 and 4).

3. A 401 or 403 on the query request is an authentication problem and not covered here.

## Related Information

- [Log search misses entries: IK analyzer tokens, uppercase keywords, clock skew, or page scope on ACP](./Log_search_misses_entries_IK_analyzer_tokens_uppercase_keywords_clock_skew_or_page_scope_on_ACP.md)
- [Logging ClickHouse runs out of disk, CPU or memory, or is OOMKilled on ACP](./Logging_ClickHouse_runs_out_of_disk_CPU_or_memory_or_is_OOMKilled_on_ACP.md)
