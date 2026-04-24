---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

When users run LogQL queries from the log console (or against a Loki-backed network-flow view), results trickle in only after a long wait, or the query times out outright. Small time ranges return quickly; anything covering an hour or more stalls.

## Root Cause

The `loki-querier` component is responsible for running LogQL queries: it fans out to the ingesters for recent data and to the object store for older chunks, then merges the streams. With only the default replica count, a single `loki-querier` pod can become the bottleneck when queries span many streams or a wide time range — especially on clusters with non-trivial log volume. The symptom looks like slow UI rendering but the real wait is on the querier side.

## Resolution

Raise the querier replica count on the LokiStack custom resource so the fan-out is spread across more pods. Check the current size in the `LokiStack` spec, then add (or raise) the `querier` replica override under `spec.template.querier`:

```bash
kubectl -n <log-namespace> edit lokistack <lokistack-name>
```

Update the spec:

```yaml
apiVersion: loki.grafana.com/v1
kind: LokiStack
metadata:
  name: <lokistack-name>
  namespace: <log-namespace>
spec:
  template:
    querier:
      replicas: 3
```

The LokiStack controller reconciles the `querier` StatefulSet to the new replica count within a few seconds. Re-run the same LogQL query after the new pods reach `Ready`.

A few caveats to keep in mind:

- **Right-size the other components too.** Raising only the querier shifts pressure onto `loki-query-frontend` (which splits and schedules sub-queries) and onto object storage (which serves chunk reads). If query-frontend queue depth stays high or the object store is throttled, scaling the querier alone will not fully restore performance.
- **Check the LokiStack `size`**. Very small sizes (e.g. `1x.demo`) are meant for evaluation only — their per-component resource requests and replica counts are minimal. For ongoing workloads, use a production size such as `1x.small` (or larger) instead of pinning individual replica overrides on a demo size.
- **Resource budget.** Each extra querier pod reserves the CPU/memory from the LokiStack's per-component resource requests. Confirm the nodes in the log-stack node pool have capacity before raising the count.

For a setup backed by the standalone Loki deployment (outside the LokiStack operator) the same principle applies — scale the `querier` Deployment/StatefulSet in the same Helm/values-driven way.

## Diagnostic Steps

Reproduce the slow query from a pod with access to the Loki gateway, or directly against the log UI, with a range wide enough to trigger the timeout:

```bash
kubectl -n <log-namespace> get pods -l app.kubernetes.io/component=querier
```

Look at the querier pod log and metrics to confirm the bottleneck is CPU / concurrency:

```bash
kubectl -n <log-namespace> logs -l app.kubernetes.io/component=querier --tail=200
kubectl -n <log-namespace> top pod -l app.kubernetes.io/component=querier
```

If `kubectl top` shows the querier pinned near its CPU limit while queries are in flight, that confirms the fan-out capacity is the limit. After scaling, re-run the same query and watch `kubectl top` — CPU per pod should drop and total throughput rise.

If the querier is idle but the query still times out, look upstream (`query-frontend` or `gateway`) or downstream (ingesters, object store) for the real bottleneck — adding more queriers will not help.
