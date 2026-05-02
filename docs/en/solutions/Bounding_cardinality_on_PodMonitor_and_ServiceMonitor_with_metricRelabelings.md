---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Bounding cardinality on PodMonitor and ServiceMonitor with metricRelabelings
## Issue

Adding a `PodMonitor` or `ServiceMonitor` against a high-cardinality producer — most commonly the Istio sidecar's `/stats/prometheus` endpoint, but the same shape applies to any application that exposes thousands of unique time-series — causes the user-workload Prometheus instance to spike in memory, slow on queries, and run its WAL out of disk. The producer is "telling the truth": it really does emit that many series. The monitor is shaped to scrape *all* of it.

The fix is to scope the scrape: either drop metric families the consumers don't actually plot, or keep only the ones the dashboards and alerts reference. Both routes use the `metricRelabelings` field on the monitor.

## Resolution

Use `metricRelabelings` to filter at scrape time. Drops happen on the Prometheus side after the producer hands over its payload, so the scrape window itself does not get faster, but everything downstream (TSDB ingestion, WAL fsync, query memory, retention disk) drops proportionally.

The pattern below targets Istio sidecars but applies verbatim to any high-cardinality endpoint: pick `drop` to remove a few families, or `keep` to whitelist exactly what the consumer needs.

### PodMonitor with cardinality bounds

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: istio-proxies-monitor
  namespace: <workload-namespace>          # also applies to the mesh control-plane namespace
spec:
  selector:
    matchExpressions:
      - key: istio-prometheus-ignore        # opt-out marker on pods that should not be scraped
        operator: DoesNotExist
  podMetricsEndpoints:
    - path: /stats/prometheus
      interval: 30s                         # raise to 1m if data lands too often
      metricRelabelings:
        # Pick exactly one of the keep/drop strategies below.

        # Strategy A — drop families nobody plots; keeps everything else.
        # - action: drop
        #   sourceLabels: [__name__]
        #   regex: 'istio_agent_.*|istiod_.*|citadel_.*|galley_.*|envoy_wasm_.*|envoy_listener_[^dh].*|envoy_server_[^mu].*'

        # Strategy B — additionally drop the Istio request-duration histogram.
        # Trade-off: the visualizer's percentile latency edges go blank.
        # - action: drop
        #   sourceLabels: [__name__]
        #   regex: 'istio_request_duration_milliseconds_bucket|istio_request_bytes_bucket|istio_response_bytes_bucket'

        # Strategy C — keep only what the visualizer's traffic graph references.
        # Smallest footprint; everything else is discarded at scrape time.
        # - action: keep
        #   sourceLabels: [__name__]
        #   regex: 'istio_requests_total|istio_request_duration_milliseconds.*|istio_tcp_(connections_(opened|closed)_total|sent_bytes_total|received_bytes_total)'

        # Strategy D — keep only the four counters used by the most basic dashboard.
        # - action: keep
        #   sourceLabels: [__name__]
        #   regex: 'istio_requests_total|istio_tcp_(opened|closed|sent|received).*'
```

Apply one of A/B/C/D — they are alternatives, not additive. Comment out the others.

### ServiceMonitor: same idea, different selector

`ServiceMonitor` lives over Service endpoints rather than pods directly. The `metricRelabelings` block is identical:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-app-monitor
  namespace: <workload-namespace>
spec:
  selector:
    matchLabels:
      app: my-app
  endpoints:
    - port: metrics
      interval: 30s
      metricRelabelings:
        - action: keep
          sourceLabels: [__name__]
          regex: 'my_app_(latency_seconds_.*|requests_total|errors_total)'
```

### Choosing between drop and keep

- **drop** is incremental — start with the noisiest families, watch cardinality fall, drop more if needed. Good when you don't have a finalised list of metrics consumers care about.
- **keep** is an allowlist — anything not on the list is gone. Better long-term hygiene, but it requires walking each dashboard and alert and listing every metric it uses. Run it through a query-log of the existing Prometheus before promoting to production so nothing gets cut by accident.

### Verifying the impact

After applying the monitor, watch the active-series count for the corresponding job. The ratio of pre/post tells you whether the relabel rule did what was intended:

```text
prometheus_tsdb_head_series             # gauge of total active series
sum by (job) (rate(prometheus_tsdb_head_series_created_total[5m]))
sum by (job) (count({job="<your-pod-monitor-job>"}))
```

Memory and CPU on the Prometheus pod should drop within a couple of scrape cycles after the relabel rule lands.

## Diagnostic Steps

1. Confirm the monitor is the cause and not, say, an unrelated rule recording a high-cardinality view. Look at top jobs by series count:

   ```text
   topk(10, count by (job) ({__name__=~".+"}))
   ```

   The job at the top is what your relabel rule has to bite into.

2. Read which metric families dominate inside that job — `keep`/`drop` regexes are only effective if they target the actual top families:

   ```text
   topk(20, count by (__name__) ({job="<your-pod-monitor-job>"}))
   ```

   Use the names that come back to build the `regex` field on `metricRelabelings`.

3. Inspect the rendered scrape config to confirm Prometheus picked up the change. The Prometheus Operator merges `metricRelabelings` into the `prometheus.yml` it generates for each shard:

   ```bash
   kubectl exec -n <prometheus-namespace> prometheus-<name>-0 -c prometheus \
     -- cat /etc/prometheus/config_out/prometheus.env.yaml \
     | yq '.scrape_configs[] | select(.job_name | test("istio-proxies-monitor"))'
   ```

   The `metric_relabel_configs` block should be present with the regex you applied.

4. Watch the WAL/disk usage on the affected Prometheus pod for a representative window — at least one full retention chunk — to confirm the relabel rule is sustainably reducing series, not just shifting the spike.
