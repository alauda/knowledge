---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Loki-backed log stack drops a portion of application logs. Collector pods (Vector, Fluentd, or Promtail) report HTTP 400 responses from the Loki distributor:

```text
ERROR sink{component_kind="sink" component_id=output_default_loki_apps ...}:
  vector::sinks::util::retries: Non-retriable error; dropping the request.
  error=Server responded with an error: 400 Bad Request
```

On the distributor side the rejection is explicit:

```text
component=distributor path=write msg="write operation failed"
  details="Max entry size '256000' bytes exceeded for stream
  '{kubernetes_namespace_name="app-ns", ...}' while adding an
  entry with length '4213818' bytes"
```

The `loki_discarded_samples_total{reason="line_too_long"}` counter climbs in lockstep with the dropped records.

## Root Cause

Loki's distributor enforces a per-entry size ceiling configured by `limits_config.max_line_size` (default **256 KB**). Any single log line that exceeds the limit is rejected outright — the write is non-retriable, so the collector drops it after reporting the 400.

Common producers of very large log lines:

- Java stack traces with full class paths and cause chains,
- base64-encoded payloads, OAuth tokens, or JWTs included in verbose error logs,
- structured logs that inline an entire HTTP request/response body,
- debug dumps that serialise an object graph.

Raising the ceiling is usually the first fix, but not the only one — a 4 MB log line is itself a code smell, and pushing the limit high (e.g. 10 MB) has cost in ingestion latency and storage.

## Resolution

1. **Find the culprit stream** so the fix can be targeted rather than cluster-wide. The distributor log entry includes the labels:

   ```text
   stream '{kubernetes_namespace_name="app-ns",
            kubernetes_pod_name="worker-abc",
            kubernetes_container_name="writer"}'
   ```

   That identifies the namespace and workload producing the oversize line.

2. **Fix the producer where feasible.** Decide whether a 4 MB log line is necessary. Usually it is not: split the payload, redact the inline binary, or log a reference to an object store URL instead of the payload itself. The win is stable ingestion latency and smaller Loki chunks, not just avoiding the rejection.

3. **Raise `max_line_size` for streams that legitimately need it.** On ACP's Logging Service, the LokiStack configuration exposes per-tenant overrides. For a tenant that genuinely needs larger entries:

   ```yaml
   apiVersion: loki.grafana.com/v1
   kind: LokiStack
   metadata:
     name: logging-loki
     namespace: logging
   spec:
     limits:
       global:
         ingestion:
           maxLineSize: 1048576   # 1 MiB
       tenants:
         application:
           ingestion:
             maxLineSize: 4194304 # 4 MiB for the oversized tenant only
   ```

   Resist the temptation to raise the global ceiling without bound. Loki's scaling assumptions are tuned for the default size; a high ceiling across all tenants makes compaction slower and memory pressure more common.

4. **Configure the collector to split long lines** when both the producer and Loki cannot be adjusted. Most modern collectors (Vector's `remap` transform, Fluent Bit's `multiline` parser) can break a single oversize event into labelled chunks that reassemble downstream. This is a last resort — it complicates queries and can reorder lines — but it preserves observability when an application refuses to shorten its output.

5. **Validate after the change.** Watch the discard metric fall to zero (or to an acceptable rate) before closing the ticket:

   ```text
   sum by (tenant, reason) (rate(loki_discarded_samples_total[5m]))
   ```

## Diagnostic Steps

Confirm the discard reason and tenant distribution:

```bash
# Query the in-cluster Prometheus via kubectl proxy (path varies by platform):
kubectl -n logging exec deploy/logging-loki-distributor -- \
  sh -c 'wget -qO- http://localhost:3100/metrics' \
  | grep loki_discarded_samples_total
```

Identify the offending streams:

```bash
for p in $(kubectl -n logging get pod -l app.kubernetes.io/component=distributor -o name); do
  kubectl -n logging logs "$p" | grep "Max entry size" | head
done | awk -F"'" '/stream/ {print $4}' | sort -u
```

Inspect a representative pod's log lengths (crude, but fast):

```bash
NS=app-ns; POD=worker-abc
kubectl -n "$NS" logs "$POD" --tail=5000 | awk '{print length}' | sort -rn | head
```

If the max line is in the hundreds of kilobytes range, expect the production rate of rejected samples to stay high until either the producer or the ceiling changes. Verify the collector itself is not truncating the line before delivery — some collectors drop oversize events silently even though they reported a successful send.
