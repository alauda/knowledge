---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# razor crash-loops or audit logs stop: TOO_MANY_PARTS, BufferTooSmall, vector OOMKilled, or stale ClickHouse token on ACP

## Issue

The log storage is ClickHouse, and one of these is seen on the cluster that runs it:

- Audit search is empty, or has nothing for the last day, while application logs or events still arrive. The `vector` container of `razor` in `cpaas-system` logs `Too many partitions for single INSERT block (more than 100)` or `Code: 252 ... (TOO_MANY_PARTS)`.
- `razor-0` is `1/2` or `CrashLoopBackOff`, and `vector` logs `failed to encode record: BufferTooSmall`.
- `razor` is `CrashLoopBackOff`, its probes fail with `dial tcp <pod-ip>:8081: connect: connection refused`, and the log query page fails with a ClickHouse `500` error while the ClickHouse pods log no errors.
- `razor` logs `Failed to create project table` and ClickHouse reports `SYNTAX_ERROR` at `'-'`.
- After an upgrade from 4.3.1 to 4.3.2, ClickHouse looks empty although no table was dropped.
- Logs, events, and audit all stop on the same day while every pod is `Running`, and `nevermore` logs timeouts to `razor`.
- ClickHouse log storage was just deployed, the log module shows nothing, and ClickHouse has no new rows.

`razor` runs two containers: `razor` and `vector`. Vector writes to ClickHouse and keeps a persistent disk buffer. Readiness, liveness, and startup probes use TCP port `8081`, which is served only while `vector` is running, so any `vector` crash makes the pod fail its probes. `razor` is a StatefulSet on most installs; check with `kubectl -n cpaas-system get deploy,sts | grep razor`.

## Root Cause

### Cause 1: inserts into observability.audit_all exceed max_partitions_per_insert_block

The ClickHouse tables are partitioned by day, and ClickHouse rejects an INSERT that touches more than `max_partitions_per_insert_block` partitions (default 100). A replay of historical audit data, or a very large Vector batch, puts more than 100 days into one INSERT. Vector treats the rejection as transient and retries the same batch, the disk buffer fills (about 2.5 GB in one case), and real-time audit stops. A restart alone does not clear it, because the buffer is on disk. `event_all` can stay current, which shows that ClickHouse, the network, and `razor` are reachable and only the audit sink is stuck.

The same limit can stop logs, events, and audit together: no data after a given date in ClickHouse, all pods `Running`, `vector` logging on the `clickhouse` sink with `component_id=audit`:

```text
Code: 252. DB::Exception: Too many partitions for single INSERT block (more than 100). The limit is controlled by 'max_partitions_per_insert_block' setting. ... (TOO_MANY_PARTS)
```

and the `http` source (`path=/v4/callback/logs`) reporting `component_events_dropped` with `reason="Source send cancelled."`. Reducing the Vector batch size (or raising the partition limit for the duration of the replay) lets inserts succeed again. `system.errors` counts the `TOO_MANY_PARTS` failures (tens of thousands in one case).

### Cause 2: vector exits on BufferTooSmall, and the razor container then sits at its CPU limit

The `razor` container is running and `vector` is not. Vector logs `Disk buffer writer has encountered an unrecoverable error` and `failed to encode record: BufferTooSmall`, then stops, and the probes on `8081` are refused. PVC `data-razor-0` is not full and the node filesystem has space. `razor` sent Vector a batch that was too large to encode. When the crash loop slows, the `razor` container CPU can sit at 100% of a 1-core limit; restarting does not change it, and raising the limit to 2 cores leaves it running at about 1.5 cores with no errors.

### Cause 3: a project name containing a hyphen makes ClickHouse reject the project table

`razor` creates a per-project table for a project-level retention policy. When the project name contains a hyphen, the statement (`<project-name-with-hyphen> ON CLUSTER replicated`) fails with `SYNTAX_ERROR` at `'-'`, and `razor` logs `Failed to create project table` repeatedly. The shared tables in database `observability` (`audit`, `event`, `log_kubernetes`, `log_platform`, `log_system`, `log_workload`, `meter_detail`, `meter_summary`, `schema_migrations`) are not affected.

### Cause 4: after the upgrade from 4.3.1 to 4.3.2, razor and nevermore keep a stale ClickHouse token

ClickHouse looks empty after the upgrade, but no rows were deleted. `razor` and `nevermore` keep ClickHouse authentication that the upgrade did not refresh. This is a known defect on that upgrade path. Forcing the token in Secret `log-database-bearer-auth` to expire and restarting `razor-api` and `nevermore` makes the data visible again.

Log queries belong on the primary global cluster; a standby global cluster whose log feature points at a domain name is not a log query endpoint.

### Cause 5: nevermore upload requests to razor time out although razor is reachable

`nevermore` logs:

```text
Failed to publish events ... Post "http://razor:8080/v4/callback/logs": context deadline exceeded (Client.Timeout exceeded while awaiting headers)
```

A manual request to the same URL from a `nevermore` pod returns `Unauthorized with error:authorization header is empty`, so the endpoint answers. Each upload batch is so large that the request times out. Lowering the upload `batch_size` from 1000 to 100 restores the connection. This can come together with Cause 1.

### Cause 6: nevermore requests to the Kubernetes API time out, and then vector is OOMKilled

On a newly deployed ClickHouse log storage, the log module shows nothing, a direct ClickHouse query finds no new rows, and the query page returns no error, so the break is before ClickHouse. `nevermore` requests to the Kubernetes API are timing out. Restarting `nevermore` clears that, and the next hop then fails: the `vector` container in `razor` is `OOMKilled`. Both fixes are needed: restart `nevermore`, then raise the `vector` memory limit.

### Cause 7: vector is OOMKilled at its memory limit, razor crash-loops, and log queries return a ClickHouse 500 error

The `vector` container reaches its memory limit (`memory: 1Gi`, with a request of `256Mi`, in one case) and is killed. `kubectl describe pod` shows `State: Waiting`, `Reason: CrashLoopBackOff`, `Last State: Terminated`, `Reason: OOMKilled`, and a growing restart count. Nothing listens on `8081`, so `razor` logs `dial tcp <pod-ip>:8081: connect: connection refused`, the pod never becomes ready, and the log query page fails with a ClickHouse `500` error. The ClickHouse pods themselves are healthy and log no errors. Raising the `vector` memory limit restores log queries.

## Resolution

### Cause 1: inserts into observability.audit_all exceed max_partitions_per_insert_block

1. Confirm the error and read the Vector configuration:

   ```bash
   kubectl -n cpaas-system logs razor-0 -c vector --tail=1500 | grep -iE 'audit|Code:|TOO_MANY|partition|dropped' -C3
   kubectl -n cpaas-system get secret cpaas-vector -o yaml > /tmp/cpaas-vector.before.yaml
   kubectl -n cpaas-system get secret cpaas-vector -o jsonpath='{.data.vector\.yaml}' | base64 -d > /tmp/vector.yaml
   grep -n max_events /tmp/vector.yaml
   ```

   Repeat the log command for `razor-1` if it exists.

2. Edit `/tmp/vector.yaml` so the audit sink has `sinks.audit.batch.max_events: 50`. If the file has only one `batch.max_events` (for example `10000000`), set it to `99` until the backlog is written, then restore the saved value.

   > **Warning:** Patching Secret `cpaas-vector` and restarting `razor` reloads Vector; ingestion through `razor` pauses until the pod is Ready. Precondition: only when `Too many partitions for single INSERT block (more than 100)` or `TOO_MANY_PARTS` is confirmed. Rollback: `kubectl apply -f /tmp/cpaas-vector.before.yaml` and restart `razor` again.

   ```bash
   kubectl -n cpaas-system patch secret cpaas-vector --type merge \
     -p "{\"data\":{\"vector.yaml\":\"$(base64 -w0 /tmp/vector.yaml)\"}}"
   kubectl -n cpaas-system rollout restart sts/razor
   kubectl -n cpaas-system rollout status sts/razor
   ```

3. If the stuck batch still fails, raise the ClickHouse `max_partitions_per_insert_block` setting above 100 while the backlog drains, and set it back once `audit_all` receives current timestamps. Read the current value first:

   ```bash
   kubectl -n cpaas-system exec <ck-pod> -c <clickhouse-container> -- \
     clickhouse-client --query "SELECT value FROM system.settings WHERE name = 'max_partitions_per_insert_block'"
   ```

4. Query audit for the current hour. A gap matching the time the sink was stuck can remain.

### Cause 2: vector exits on BufferTooSmall, and the razor container then sits at its CPU limit

1. Confirm which container stops and why:

   ```bash
   kubectl -n cpaas-system get pod razor-0 -o jsonpath='{range .status.containerStatuses[*]}{.name}{" restarts="}{.restartCount}{" last="}{.lastState.terminated.reason}{"\n"}{end}'
   kubectl -n cpaas-system logs razor-0 -c vector --previous --tail=80
   ```

2. If `razor` also logs `Failed to create project table`, fix Cause 3 first.
3. If the `razor` container stays at its CPU limit, raise it.

   > **Warning:** Changing the `razor` container resources rolls the workload; ingestion and queries pause during the roll. Precondition: only when `BufferTooSmall` is confirmed and the `razor` container is at its CPU limit, and the node has a free core. Rollback: set the previous limit again. If a plugin update puts the old value back, set it again the same way.

   ```bash
   kubectl -n cpaas-system set resources sts/razor -c razor --limits=cpu=2
   ```

### Cause 3: a project name containing a hyphen makes ClickHouse reject the project table

```bash
kubectl -n cpaas-system logs <razor-pod> -c razor --tail=80 | grep -E 'Failed to create project table|SYNTAX_ERROR'
```

> **Warning:** Deleting the retention policy removes that project's retention rule; its logs follow the default retention afterwards. Precondition: only when the failing statement names a project that contains a hyphen. Rollback: none for the deleted policy.

Delete that project's log retention policy in the console. The `Failed to create project table` line stops. If CPU stays high afterwards, apply Cause 2.

### Cause 4: after the upgrade from 4.3.1 to 4.3.2, razor and nevermore keep a stale ClickHouse token

> **Warning:** Expiring the token and restarting `razor-api` and `nevermore` pauses log queries and collection during the restarts. Precondition: only when ClickHouse looks empty after the upgrade from 4.3.1 to 4.3.2. Rollback: restore the saved Secret and restart the same two workloads.

```bash
kubectl -n cpaas-system get secret log-database-bearer-auth -o yaml > /tmp/log-database-bearer-auth.before.yaml
kubectl -n cpaas-system annotate secret log-database-bearer-auth \
  razor-api/token-expires-at="2000-01-01T00:00:00Z" --overwrite
kubectl -n cpaas-system rollout restart deploy/razor-api
kubectl -n cpaas-system rollout restart ds/nevermore
kubectl -n cpaas-system rollout status deploy/razor-api
kubectl -n cpaas-system rollout status ds/nevermore
```

Refresh the log page after both are Ready.

### Cause 5: nevermore upload requests to razor time out although razor is reachable

```bash
kubectl -n cpaas-system logs <nevermore-pod> --all-containers --tail=200 | grep -iE 'razor|timeout|Failed to publish'
kubectl -n cpaas-system exec <nevermore-pod> -c log -- curl -sS http://razor:8080/v4/callback/logs
kubectl -n cpaas-system get cm nevermore-config -o yaml > /tmp/nevermore-config.before.yaml
grep -n batch_size /tmp/nevermore-config.before.yaml
```

An `Unauthorized` answer means `razor` is reachable. If the container has no `curl`, run the request from another pod in `cpaas-system`.

> **Warning:** Editing `nevermore-config` and restarting `nevermore` pauses collection on each node while its pod restarts; a batch that is too small slows shipping on busy nodes. Precondition: only when `nevermore` logs upload timeouts and a manual request to `razor` is answered. Rollback: `kubectl apply -f /tmp/nevermore-config.before.yaml` and restart `nevermore` again.

```bash
kubectl -n cpaas-system edit cm nevermore-config
kubectl -n cpaas-system rollout restart ds/nevermore
```

Change the upload `batch_size` from `1000` to `100`, then watch the timeouts stop and current rows arrive in ClickHouse.

### Cause 6: nevermore requests to the Kubernetes API time out, and then vector is OOMKilled

1. Confirm that nothing new reaches ClickHouse (use `DESCRIBE TABLE observability.log_workload` if the time column has another name):

   ```bash
   kubectl -n cpaas-system exec <ck-pod> -c <clickhouse-container> -- \
     clickhouse-client --query "SELECT max(timestamp) FROM observability.log_workload"
   kubectl -n cpaas-system logs <nevermore-pod> --all-containers --tail=300 | grep -iE 'timeout|deadline|apiserver|443'
   ```

2. Restart `nevermore`.

   > **Warning:** Restarting `nevermore` pauses log, audit, and event collection on each node while its pod restarts. Precondition: only when ClickHouse has no new rows and `nevermore` logs Kubernetes API timeouts. Rollback: none needed; the DaemonSet recreates the pods.

   ```bash
   kubectl -n cpaas-system rollout restart ds/nevermore
   kubectl -n cpaas-system rollout status ds/nevermore
   ```

3. If `vector` is then `OOMKilled`, raise its memory as in Cause 7.

### Cause 7: vector is OOMKilled at its memory limit, razor crash-loops, and log queries return a ClickHouse 500 error

1. Read the last termination reason and the current limit of each container:

   ```bash
   for p in $(kubectl -n cpaas-system get pod -o name | grep razor); do
     echo "== $p"
     kubectl -n cpaas-system get "$p" -o jsonpath='{range .status.containerStatuses[*]}{.name}{" restarts="}{.restartCount}{" last="}{.lastState.terminated.reason}{"\n"}{end}'
   done
   kubectl -n cpaas-system get sts razor -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" "}{.resources.limits.memory}{"\n"}{end}'
   ```

2. Raise the memory limit of the `vector` container.

   > **Warning:** Editing the `razor` workload restarts its pods; log ingestion and queries pause until they are Ready. Precondition: only when the `vector` container's last state is `OOMKilled`, and the node has the memory for the new limit. Rollback: set the previous memory limit again.

   ```bash
   kubectl -n cpaas-system edit sts razor
   ```

   In the `vector` container, raise `resources.limits.memory` (one recovery used `4Gi`; size it from observed usage and the node's free memory). In that recovery the edit generated a resource patch (`rpch`) that kept the new value through later reconciles; check that the value is still in place after the next plugin update.

3. When `vector` stops restarting and the pod is Ready, run the log query again.

## Diagnostic Steps

1. Identify which container fails and what it logs:

   ```bash
   kubectl -n cpaas-system get pods | grep -E 'razor|nevermore'
   kubectl -n cpaas-system describe pod razor-0 | sed -n '/Containers:/,/Conditions:/p'
   kubectl -n cpaas-system logs razor-0 -c vector --previous --tail=60
   kubectl -n cpaas-system logs razor-0 -c razor --tail=40
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | `TOO_MANY_PARTS` or `more than 100` on the ClickHouse sink | 1 |
   | `BufferTooSmall` in the previous `vector` log | 2 |
   | `Failed to create project table` with `SYNTAX_ERROR` at `'-'` | 3 |
   | ClickHouse looks empty right after the 4.3.1 to 4.3.2 upgrade | 4 |
   | `nevermore` times out on `/v4/callback/logs`, manual request answered | 5 |
   | No new ClickHouse rows and `nevermore` times out against the Kubernetes API | 6 |
   | `vector` last state `OOMKilled`, `8081` refused, query page shows ClickHouse `500` | 7 |

3. A `connection refused` on `8081` only says that `vector` is down; always read the previous `vector` log and the last termination reason before changing anything. A ClickHouse pod that is itself `OOMKilled` or exits with `137` is a ClickHouse capacity problem, see [Logging ClickHouse runs out of disk, CPU or memory, or is OOMKilled on ACP](Logging_ClickHouse_runs_out_of_disk_CPU_or_memory_or_is_OOMKilled_on_ACP.md).

Related articles: [razor does not become ready after a ClickHouse log storage install or upgrade on ACP](razor_does_not_become_ready_after_a_ClickHouse_log_storage_install_or_upgrade_on_ACP.md), [nevermore OOMKilled, cache written to /var/cpaas, or callback-secret mount failure on ACP](nevermore_OOMKilled_cache_written_to_var_cpaas_or_callback-secret_mount_failure_on_ACP.md).
