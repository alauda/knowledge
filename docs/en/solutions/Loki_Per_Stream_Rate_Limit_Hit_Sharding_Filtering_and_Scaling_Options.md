---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Loki ingesters reject log batches with HTTP 429:

```text
method=/logproto.Pusher/Push err="rpc error: code = Code(429)
  desc = entry with timestamp ... ignored,
  reason: 'Per stream rate limit exceeded (limit: 5MB/sec) while
  attempting to ingest for stream
  '{kubernetes_container_name=\"<c>\",kubernetes_namespace_name=\"<ns>\",...}'"
```

Collector pods backpressure, the `X% of records have resulted in an error` alert fires, and a slice of application logs disappears from downstream queries until the producer slows down or an operator intervenes.

## Root Cause

Loki enforces two per-tenant ingestion limits:

- **`ingestionRate`** — total MB/s the tenant can ingest across all streams.
- **`perStreamRateLimit`** — MB/s a **single stream** is allowed to contribute.

A *stream* is defined by the full set of labels attached to the log line. In ACP's Logging Service, the default label set is `kubernetes_host`, `kubernetes_namespace_name`, `kubernetes_pod_name`, `kubernetes_container_name`, `log_type`. One chatty container from a busy pod therefore is one stream, and if that container emits more than the per-stream ceiling (default `3MB/s`, raise-limit `5MB/s`) the rest of its output is rejected.

Some scale context: a stream holding 3 MB/s for a full day produces ~259 GB of log volume. The limit is a safety net, not a suggestion.

## Resolution

There are four levers. Use them in this order — each earlier lever is cheaper and safer than the later ones.

1. **Fix the source.** Inspect the stream hitting the limit and confirm the logs are intentional:

   ```bash
   # From the distributor log, the stream labels identify the offender
   kubectl -n logging logs -l app.kubernetes.io/component=distributor \
     | grep -i 'Per stream rate limit exceeded' | tail -5
   ```

   Common culprits: an application in DEBUG/TRACE in production, a retry loop that logs each iteration, a request dump that serialises large payloads. The win is bandwidth you don't have to transport, store, or query.

2. **Filter at the collector** rather than throwing everything at Loki and dropping it at the ingester. The log-forwarder supports three filter types:

   - **Drop by severity / content** for debug-level spam.
   - **Drop by metadata / label** for known noisy namespaces or containers.
   - **Audit filters** for selectively forwarding audit events rather than all of them.

   Applied at the collector, the filtered lines never consume Loki ingester or distributor CPU; applied in Loki, they consume both and then die.

3. **Enable stream sharding** where available. Loki's stream-sharding feature (delivered by the `LOG-4551` upstream in recent Logging releases) splits a single hot stream across multiple shards, which multiplies the effective per-stream rate:

   ```yaml
   # LokiStack tenant config (conceptual — verify exact path for your version)
   spec:
     limits:
       global:
         ingestion:
           perStreamRateLimit: 5
           perStreamRateLimitBurst: 20
       shards:
         enabled: true
   ```

   Stream sharding doesn't free you from the hard label-cardinality constraint, but it handles bursty producers well.

4. **Raise the per-stream limit — with a ceiling**. If the traffic is genuinely necessary:

   ```yaml
   spec:
     limits:
       global:
         ingestion:
           ingestionRate: 10            # tenant-total MB/s
           ingestionBurstSize: 20
           perStreamRateLimit: 5        # hard ceiling; do not exceed
           perStreamRateLimitBurst: 20
   ```

   Units are MB. Two rules:
   - `ingestionRate` must exceed `perStreamRateLimit` (otherwise a single stream can saturate the tenant).
   - Do not push `perStreamRateLimit` above `5MB/s` without a conversation with storage planning — retrieval latency and chunk size at that rate degrade query experience.

5. **Scale out ingesters** when the tenant is legitimately producing high aggregate volume. More ingester replicas let Loki's hash ring spread streams across pods, which increases the effective total ingestion budget. Use this only after steps 1–4 have been considered; more replicas don't help a single-stream hot spot.

## Diagnostic Steps

Identify the streams currently hitting the per-stream limit:

```bash
kubectl -n logging logs -l app.kubernetes.io/component=distributor --tail=1000 \
  | grep 'Per stream rate limit' \
  | awk -F'attempting to ingest for stream ' '{print $2}' \
  | sort | uniq -c | sort -rn | head
```

The top offenders are candidates for source-side fixing or filter addition.

Check the tenant's current config:

```bash
kubectl -n logging get lokistack <name> \
  -o jsonpath='{.spec.limits}{"\n"}'
```

Verify the discard reason metric to distinguish rate-limit drops from other loss modes:

```text
sum by (reason) (rate(loki_discarded_samples_total[5m]))
# reason="rate_limited"  → this article applies
# reason="line_too_long" → see the "Loki Rejects Log Lines Larger Than 256 KB" article
```

After filtering / sharding / limit adjustment, both the distributor `Per stream rate limit exceeded` log lines and `loki_discarded_samples_total{reason="rate_limited"}` should taper to zero within a few minutes. If they don't, the source producer is still in control — go back to step 1.
