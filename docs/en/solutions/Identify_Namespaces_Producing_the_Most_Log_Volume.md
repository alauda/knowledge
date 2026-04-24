---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The cluster's log storage backend is filling up faster than expected and you want to find out which namespace (or set of namespaces) is the top contributor to ingested log volume, so you can follow up with the workload owner or adjust log-forwarding rules.

## Root Cause

Log volume accounting is per log line, tagged with the namespace of the pod that emitted it. When a single application is very chatty (stack traces on every request, debug log level left on in production, or a tight retry loop emitting one line per failure), its namespace's share of ingested bytes and lines grows disproportionately, which translates directly into backend storage pressure on the Loki-based log store used by the platform's Logging Service.

To size the problem you need to aggregate the log stream by the `kubernetes_namespace_name` label and rank it, rather than relying on per-pod or per-container views.

## Resolution

The ACP Logging Service exposes a LogQL query interface. Use `topk` over a time range to rank namespaces by log line count; use `sum by (...)` to aggregate bytes if your deployment exposes the `bytes_processed` series.

1. Identify which log store you are querying. In the ACP Logging Service, the application log tenant lives under the `application` tenant; infra/audit tenants are separate. Namespace attribution is meaningful only for the `application` tenant — infra logs are not tagged with a user namespace.

2. Rank namespaces by log-line count over the last hour:

   ```logql
   topk(10, sum by (kubernetes_namespace_name) (
     count_over_time({log_type="application"}[1h])
   ))
   ```

   Broaden the window (`[24h]`, `[7d]`) when you want a capacity-planning view rather than a point-in-time snapshot. Keep in mind that longer windows require the backend to read more chunks and may be rejected by the query-frontend if they exceed configured limits.

3. Rank namespaces by ingested bytes. When the cluster exposes `bytes_over_time` on the application stream:

   ```logql
   topk(10, sum by (kubernetes_namespace_name) (
     bytes_over_time({log_type="application"}[1h])
   ))
   ```

   Line counts and byte counts rank very differently when one namespace emits a small number of very large stack traces — always check both.

4. Drill into the top namespace by container to isolate the source:

   ```logql
   topk(10, sum by (kubernetes_container_name) (
     count_over_time({log_type="application", kubernetes_namespace_name="<ns>"}[1h])
   ))
   ```

5. Once the offender is identified, the remediations are the usual ones: lower the log level in the workload, filter or drop noisy streams at the log-forwarder stage (the forwarder accepts per-input filter pipelines), or add a retention override for that namespace in the log store's tenant config.

If the deployment does not use the ACP Logging Service and instead runs a standalone OSS log stack, the same queries work against Loki directly (label names are identical because the forwarder — Vector or Fluentd-alike — emits the `kubernetes_namespace_name` label by convention). Grafana's Explore view is the usual place to run them.

## Diagnostic Steps

- `kubectl get pods -n <logging-namespace>` — confirm the log store pods are healthy; a backlogged ingester can make the `topk` query return a stale or partial ranking.
- Inspect the log-forwarder pipeline config for any namespace allowlist/denylist; a namespace excluded at the forwarder will not show up in `topk` at all (which can be surprising if you expected it to lead).
- Check the log-store query-frontend limits (`max_query_length`, `max_entries_limit_per_query`) before running multi-day `topk` queries.
- Cross-reference the ranking with the node-level filesystem usage on the log-store backend PVCs to confirm the numbers line up; if they diverge sharply, the ingestion pipeline is either dropping labels or splitting traffic across tenants you are not querying.
