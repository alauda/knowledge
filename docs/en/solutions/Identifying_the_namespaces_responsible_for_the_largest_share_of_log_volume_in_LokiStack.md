---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

When Loki ingest is at risk — querier OOMs, ingester rate-limit alerts, persistent backpressure on the collector — the immediate question is "who is generating most of these logs?" A LogQL `topk` over `count_over_time` answers that, but it has to be used carefully: the query itself can hurt the very queriers under stress. This article describes how to run the query, when to prefer cheaper alternatives, and how to scope the result so the answer is actionable.

## Resolution

Open the cluster's log search view and run the application top-N query for the last hour. Adjust the time window to match the incident; one hour is a good starting point because it is long enough to be representative and short enough to keep the scan cheap.

```text
topk(10,
  sum by (kubernetes_namespace_name) (
    count_over_time({log_type="application"}[1h])
  )
)
```

The result is a sorted list of the ten namespaces producing the most application log lines in the last hour. The same query against `log_type="infrastructure"` reveals the heaviest infrastructure namespaces:

```text
topk(10,
  sum by (kubernetes_namespace_name) (
    count_over_time({log_type="infrastructure"}[1h])
  )
)
```

Switching log type matters because Loki stores the two types in distinct streams; a query that mixes them will likely return "No datapoints found" or skew the totals.

Before running on a production cluster under stress, weigh the cost. `count_over_time` over an unfiltered selector forces the querier to fetch every chunk in the time window for every stream that matches. On a large cluster this can:

- Spike querier memory enough to OOM-kill the pod, which Loki then reports as a query timeout to the operator.
- Trigger ingester request-too-old errors if the time window crosses a recently-rotated WAL.

The cheaper alternative is to read the same answer from the collector's own metrics rather than querying Loki. The collector exports per-source byte counters that give the same ranking with no read pressure on Loki:

```text
topk(10,
  sum by (namespace) (
    rate(vector_component_received_event_bytes_total[5m])
  )
)
```

Run this in the cluster's Prometheus query view; results come back in milliseconds and the load lands on Prometheus, not on the log store.

When the LogQL query is the right choice — for example to confirm that a metric-derived ranking matches the actual on-store distribution — limit the blast radius:

- Pick the smallest time window that still gives a meaningful sample (15 minutes is often enough for a clear winner).
- Never run multiple `topk` queries in parallel; they compete for the same querier resources.
- If the cluster has a LokiStack `gateway`, prefer running the query through the gateway with a tenant filter so the load only hits the relevant ingester set.

Once the heavy namespace is identified, the actionable next steps live elsewhere — talk to the workload owner about logging verbosity, configure a per-input rate limit on the collector, or filter known-noisy streams at ingest. The query is just the diagnostic; the fix is upstream.

## Diagnostic Steps

If the LogQL query returns "No datapoints found" but the cluster is clearly logging, confirm the log type filter matches the actual labels on the logs:

```text
sum(count_over_time({log_type=~".+"}[5m])) by (log_type)
```

The result tells you which `log_type` values have data. Use one of those exact values in the `topk` query.

If the query times out, fall back to the metric-based query above. Should that also be unavailable (collector metrics not scraped), shrink the LogQL time window:

```text
topk(5,
  sum by (kubernetes_namespace_name) (
    count_over_time({log_type="application"}[5m])
  )
)
```

A five-minute window scans roughly 1/12 of the chunks an hour-window does and is much less likely to pressure the querier.

For a per-pod breakdown inside the heaviest namespace, append the pod label:

```text
topk(10,
  sum by (kubernetes_pod_name) (
    count_over_time({log_type="application", kubernetes_namespace_name="<namespace>"}[1h])
  )
)
```

This narrows the answer from "which namespace" to "which pod inside that namespace", which is usually the data point the workload owner needs.
