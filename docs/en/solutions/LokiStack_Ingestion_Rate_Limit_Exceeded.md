---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The log collector layer starts dropping writes into the log store. Two concurrent symptoms surface:

Loki distributor pods log `ingestion rate limit exceeded` with 429 responses:

```text
level=error caller=manager.go:49 component=distributor path=write
msg="write operation failed"
details="ingestion rate limit exceeded for user application (limit: 5242880 bytes/sec)
 while attempting to ingest '18500' lines totaling '22862596' bytes,
 reduce log volume or contact your Loki administrator to see if the limit can be increased"
org_id=application
```

Vector collector pods log the symmetric `too many requests` retry on the `lokistack` sink:

```text
WARN sink{component_kind="sink" component_id=output_default_lokistack_application component_type=http}:
 vector::sinks::util::retries: Retrying after response.
 reason=too many requests internal_log_rate_limit=true
```

And the Loki-side `loki_discarded_samples_total` metric, split by tenant and reason, shows a sustained non-zero rate for `reason="rate_limited"`:

```text
sum by (tenant, reason) (rate(loki_discarded_samples_total[2m]))
```

Raising the limits naively is tempting but doubles CPU / memory pressure on the Loki distributor and ingester pods. The question to answer first is whether the rate-limit hits are *transient* (in which case doing nothing is correct — Vector will retry and nothing is lost) or *sustained* (in which case limits must be raised *and* sized against the observed push size).

## Root Cause

Loki's `limits_config` enforces two per-tenant ingestion ceilings that matter here:

```yaml
limits_config:
  ingestion_rate_strategy: global
  ingestion_rate_mb: 4
  ingestion_burst_size_mb: 6
```

- `ingestion_rate_strategy: global` tells Loki to budget the rate **across** distributors: each distributor locally enforces `ingestion_rate_mb / N` where N is the number of distributor replicas. With `ingestion_rate_mb=4` and `N=2`, each distributor accepts ~2 MB/s per tenant.
- `ingestion_burst_size_mb` is the per-distributor burst ceiling — the maximum size of a **single** push request. Even with global rate strategy, a single Vector flush larger than this is rejected outright. In the log line above, Vector tried to push `22,862,596` bytes in one request against a `6 MB` burst → 429.

Both symptoms can appear temporarily without indicating a real capacity mismatch:

- **Collector cold start** — Vector flushes a backlog from the on-disk buffer as soon as it comes up.
- **Ingestion gap recovery** — the upstream collector was unreachable for some window, and the catch-up flush is hot.
- **Platform event storms** — mass upgrade, rolling restart, or a noisy tenant briefly exceeding its normal baseline.

In these transient shapes the collector retries via the sink's `Retry policy`, eventually drains, and the discarded-samples metric decays to zero. No configuration change is warranted. Only a **sustained** non-zero `loki_discarded_samples_total{reason="rate_limited"}` signals the steady-state ingress volume is genuinely above the configured tenant budget.

Alauda Container Platform exposes Loki through its in-cluster logging surface (`observability/log`) and through the extended **Logging Service** (`logs-docs`). Both embed the same upstream Loki project, so the behaviour of `limits_config`, the distributor-side global rate strategy, and the Vector sink's retry policy are all inherited from upstream and can be tuned through the `LokiStack` CR's `limits` / `tenants` sections.

## Resolution

### Step 1 — Decide whether a change is needed

Run the discarded-samples query at 2-minute resolution over a window that includes at least one representative workload peak:

```text
sum by (tenant, reason) (rate(loki_discarded_samples_total[2m]))
```

If the `rate_limited` component is non-zero for only a few minutes after an event (restart, upgrade, failover) and then returns to zero, do not touch the limits. The retry path absorbs the burst. Re-run the query during the next busy period to confirm steady-state.

If `rate_limited` stays non-zero for an extended window, move to Step 2.

### Step 2 — Trim logs at the source before raising limits

The Vector forwarder is the cheapest place to save volume. Common wins:

- Drop `stdout`/`stderr` noise from chatty debug components via Vector `filter` transforms or the `ClusterLogForwarder` filter field.
- Reject binary / base64 blobs that leak into stdout (Java stacktraces that embed pickled data, audit rows with inline payloads).
- Route infrastructure-only logs to a separate tenant so application rate limit does not gate platform logs.

Volume reduction here is "free" in the sense that it costs collector CPU but not Loki-tier storage or memory.

### Step 3 — Size the new ingestion limits from the actual push size

The distributor log tells you the exact push size that tripped the gate. In the example the single-push size was `22,862,596` bytes (~22 MiB). Set:

- `ingestionBurstSize` — **must** exceed the largest observed single-push size. Round up with headroom: for a 22 MiB observed push, set `ingestionBurstSize: 32Mi`.
- `ingestionRate` — set above the **sustained** per-tenant byte rate measured at the distributor. Compute from `rate(loki_distributor_bytes_received_total{tenant="<tenant>"}[5m])` over the busy window and add ~30 % headroom.

Apply via the `LokiStack` CR, in the relevant tenant's `limits` block. For example:

```yaml
apiVersion: loki.grafana.com/v1
kind: LokiStack
metadata:
  name: logging-loki
  namespace: <logging-namespace>
spec:
  limits:
    tenants:
      application:
        ingestion:
          ingestionRate: 16             # MiB/s per tenant
          ingestionBurstSize: 32        # MiB, per distributor
```

Tune only the tenants that actually hit the limit. Leaving `audit` and `infrastructure` at their defaults keeps the overall resource budget predictable.

### Step 4 — Budget for the resource cost

Raising `ingestionRate` and `ingestionBurstSize` increases CPU and memory pressure on both the distributor and the ingester. Before rolling out, verify:

- Distributor / ingester pods are not already near their configured `resources.limits`.
- Loki node pool has headroom, or scale replicas (`spec.template.distributor.replicas` / `ingester.replicas`) proportionally to the rate increase.
- The object store (S3 / MinIO) can absorb the higher chunk flush rate without throttling.

Roll the change out, watch the discarded-samples rate decay to zero, and re-measure after the next peak to confirm the new ceiling holds.

### Are dropped logs lost?

A 429 from Loki is **not** a terminal failure. Vector retries per its `Retry policy`, and as long as the buffer on the collector pod is not exhausted the logs eventually ingest. Loss occurs only when the rate-limit condition persists long enough that the collector buffer overflows — which is why a *sustained* rate-limit rate (not a transient spike) is the indicator that intervention is needed.

## Diagnostic Steps

1. Confirm the rate-limit hits at the metric layer and identify affected tenants:

   ```text
   sum by (tenant, reason) (rate(loki_discarded_samples_total[2m]))
   ```

2. Confirm the rate-limit hits at the distributor log layer and extract the observed push size (the numerator for sizing `ingestionBurstSize`):

   ```bash
   ns=<logging-namespace>
   pod=$(kubectl -n "$ns" get pod -l app.kubernetes.io/component=distributor \
         -o jsonpath='{.items[0].metadata.name}')
   kubectl -n "$ns" logs "$pod" | grep "ingestion rate limit exceeded"
   ```

3. Check which tenants are hitting the limit. A count-per-tenant tells you scope:

   ```bash
   for tenant in application audit infrastructure; do
     count=$(kubectl -n "$ns" logs "$pod" | grep "ingestion rate limit exceeded" \
             | grep -c "org_id=$tenant")
     echo "$tenant: $count"
   done
   ```

4. Cross-check the collector side. If Vector is retrying and eventually succeeding, the rate metric on Loki should decay. If Vector buffer is near full, collector pods will surface `backpressure` or buffer saturation warnings — that is the signal that logs will shortly be dropped end-to-end:

   ```bash
   kubectl -n "$ns" logs <vector-collector-pod> | grep -Ei 'too many requests|buffer|backpressure'
   ```

5. Once new limits are applied, re-run step 1. The `rate_limited` component should fall to zero; if it does not, the sized limit was still below the real ingress rate, or a new tenant has crossed its own threshold.
