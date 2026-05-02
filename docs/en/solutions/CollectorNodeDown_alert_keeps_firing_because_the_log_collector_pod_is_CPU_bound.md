---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Alertmanager keeps firing `CollectorNodeDown` for the log-collector DaemonSet, but the collector pods are clearly `Running`. Restarting them silences the alert briefly and it returns within minutes. The user-facing symptom is intermittent gaps in the centralised log stream — Loki sees no fresh entries from the affected nodes during the window the alert is active.

The alert itself is wired to the Prometheus scrape of the collector's `/metrics` endpoint: when scraping fails for long enough, Prometheus marks the target down and the rule fires. So "CollectorNodeDown" really means "Prometheus can't scrape the collector", which on a `Running` pod is almost always a slow scrape, not a crash.

## Root Cause

The collector exposes Prometheus metrics on a per-pod port. Prometheus scrapes that endpoint with a 10-second timeout. The collector pod is single-threaded for HTTP serving inside the same runtime that ingests and forwards logs, so when the forwarding side is saturated — high log volume, expensive `filter` stages, multi-line exception detection, backpressure from a downstream sink — the scrape handler doesn't get scheduled in time and the request times out.

CPU saturation is the most common trigger. The collector container often ships with a low CPU limit (for example `1000m`) that becomes a hard ceiling once log volume grows. Once the container hits that limit during a spike, the metrics handler stops responding within the 10-second budget and the scrape registers as failed. Repeated misses cross the alert threshold and `CollectorNodeDown` fires while the pod itself is still working.

Other contributors that surface as the same symptom:

- Multi-line exception detection holds a buffer per stream; bursty stack traces multiply that cost.
- A single chatty namespace generating most of the log volume on the node disproportionately loads one collector pod.
- A backed-up downstream (Loki ingester, Kafka broker, S3 endpoint) causes the collector to spend cycles on retry/backoff, again squeezing the metrics handler.

## Resolution

Start by giving the collector enough CPU headroom that the metrics endpoint can stay responsive even during ingestion bursts. The exact value depends on volume, but doubling the existing limit is a reasonable first step; observe and tune from there:

```yaml
spec:
  collection:
    resources:
      limits:
        cpu: 2000m
        memory: 8Gi
      requests:
        cpu: 500m
        memory: 4Gi
```

Apply through whatever CRD drives the collection pipeline in this cluster (the collector spec lives on the same CR that defines the forwarder), then wait for the DaemonSet to roll out and confirm the alert clears.

If raising CPU does not by itself stop the alert, work through the per-load options:

- Identify the chatty namespaces. The collector exports `vector_component_received_event_bytes_total` per source/component. The top-by-namespace query reveals which namespaces are spending the budget; talk to the workload owners and see whether the verbosity is justified.
- Apply rate limiting at the collector. The forwarder spec exposes a per-container rate limit (`spec.inputs[].tuning.rateLimitPerContainer`) — set it on inputs that capture the noisy namespace.
- Filter at ingest. `spec.filters` can drop or sample known-noisy log streams before they reach the forwarding pipeline. This is cheaper than letting the bytes flow all the way to storage.

Filtering itself costs CPU, so always re-measure after a filter change. A pathological regex can spend more cycles than it saves.

For a clean long-term fix, treat the collector resource limits as part of the cluster's capacity plan: tie the limit to the worst-case sustained log rate per node, not the steady-state average.

## Diagnostic Steps

Reproduce what Prometheus is doing — scrape the collector endpoint from inside the cluster and time it. From a debug pod or a Prometheus pod itself:

```bash
COLLECTOR_IP=$(kubectl -n logging get pod -l app=collector -o wide \
  | awk 'NR==2{print $6}')
kubectl -n monitoring exec prometheus-0 -- \
  sh -c "time curl -kv https://$COLLECTOR_IP:24231/metrics | wc -c"
```

If the curl takes longer than 10 seconds, the scrape will time out and the alert is correctly diagnosing the collector as unreachable — even though `kubectl get pod` reports `Running`.

Check whether the container is actually pinned at its CPU limit during the alert window. Run the following PromQL against the cluster's monitoring stack:

```text
pod:container_cpu_usage:sum{pod=~'collector.*',namespace='logging'}
```

Compare the values during the alert window with the limit set on the collector container. If `cpu_usage` is sitting at the limit value for sustained periods, the limit is the constraint and the resolution above applies.

For top-namespace attribution, query the collector's own metrics:

```text
topk(10, sum by (namespace) (rate(vector_component_received_event_bytes_total[5m])))
```

The result identifies which namespaces are paying the largest share of the per-node CPU budget — those are the candidates for rate limit or filter rules.

Finally, if the alert persists after CPU is comfortably below the limit, look downstream: a Loki ingester or external sink under pressure will keep the collector busy on retries. The collector logs (`kubectl logs <collector-pod>`) usually surface those backpressure or connection errors directly.
