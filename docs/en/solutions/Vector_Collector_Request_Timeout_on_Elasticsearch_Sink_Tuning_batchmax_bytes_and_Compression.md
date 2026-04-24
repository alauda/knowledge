---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Log collector pods (Vector) emit repeated `Request timed out` warnings while forwarding to an Elasticsearch output. Events may still be reaching Elasticsearch intermittently, but a steady stream of warnings appears in the collector log and, over time, back-pressure builds and events start to be dropped or delayed.

```text
WARN sink{component_kind="sink" component_id=output_elasticsearch component_type=elasticsearch}:
  vector::sinks::util::retries: Request timed out. If this happens often while the
  events are actually reaching their destination, try decreasing `batch.max_bytes`
  and/or using `compression` if applicable. Alternatively `request.timeout_secs`
  can be increased.
  internal_log_rate_limit=true
```

## Root Cause

Vector has a built-in request-level timeout controlled by `request.timeout_secs`, with a default of **60 seconds**. It also batches events before flushing to a sink; for the Elasticsearch sink the batch size defaults to **`batch.max_bytes = 10 MB`**. A single flush that cannot complete within 60 seconds is aborted and retried, which is the exact condition that produces the warning above.

In the managed log-forwarding surface, `request.timeout_secs` is not exposed as a tunable — it is always 60. That leaves three degrees of freedom that can bring the flush under the ceiling:

1. **Network performance** between the collector and the Elasticsearch output.
2. **Output performance** — how quickly Elasticsearch can accept and index a 10 MB bulk request.
3. **Collector-side CPU headroom** — Vector compresses, serialises, and handshakes TLS inside the collector pod. If the collector is hitting CPU limits, each flush takes longer for reasons unrelated to the network.

Practically, a `Request timed out` warning is Vector saying "I could not push `batch.max_bytes` over the wire and through the indexer in `request.timeout_secs`." The fix is one or more of: shrink the batch, compress it on the wire, or relieve the collector's own CPU pressure.

## Resolution

### Preferred path on ACP

ACP **Observability — Log** (`docs/en/observability/log/`) and the **Logging Service** extension (`logs-docs`) both use Vector as the collection engine and expose the same tuning knobs under the `ClusterLogForwarder` (CLF) CR. The same three adjustments apply without modification:

- `spec.outputs.<name>.tuning.maxWrite` — maps to Vector's `batch.max_bytes`.
- `spec.outputs.<name>.tuning.compression` — maps to Vector's `compression`.
- Collector pod CPU request/limit — managed through the CLF's collector spec.

There is no ACP-specific remapping; the operator writes a Vector configuration that honours these fields one-to-one. Start with the collector-CPU check below, then tune `maxWrite` and `compression` on the specific output that is timing out.

### Underlying mechanics — resolve the timeout

1. **Rule out collector CPU pressure first.** If Vector is CPU-starved, shrinking the batch only helps marginally and the symptom comes back under load. Query the collector pods' usage against their limits:

   ```bash
   kubectl -n <logging-namespace> top pod -l app.kubernetes.io/instance=<clf-cr-name>
   ```

   For a historical view, plot `pod:container_cpu_usage:sum{pod=~".*<clf-collector>.*", namespace="<logging-namespace>"}` in the metrics front-end. If the line sits at the container's `limits.cpu` for sustained periods, raise it. Raise incrementally until the plot no longer hits the ceiling; then set `resources.requests.cpu` to the steady-state value and `resources.limits.cpu` a bit above it.

2. **Shrink `batch.max_bytes` per output.** For an Elasticsearch output that times out, set `spec.outputs.<name>.tuning.maxWrite` to a value smaller than the 10 MB default. A common starting point is 5 MB:

   ```yaml
   apiVersion: logging.alauda.io/v1
   kind: ClusterLogForwarder
   metadata:
     name: <clf-cr-name>
     namespace: <logging-namespace>
   spec:
     outputs:
       - name: elasticsearch
         type: elasticsearch
         elasticsearch:
           index: app-log
           url: http://<es-host>:9500
           version: 8
         tuning:
           maxWrite: 5000000   # 5 MB; Vector's batch.max_bytes
   ```

   The Logging Operator rolls out the change by restarting the collector pods; the new value takes effect immediately.

3. **Turn on compression.** Compression reduces the number of bytes that have to cross the network per flush. It only helps when the bottleneck is network throughput rather than Elasticsearch's indexing rate, and it costs collector CPU — apply step 1 first.

   Pick an algorithm Vector supports for the Elasticsearch sink (most commonly `gzip`) and that Elasticsearch is configured to accept:

   ```yaml
   spec:
     outputs:
       - name: elasticsearch
         type: elasticsearch
         elasticsearch:
           index: app-log
           url: http://<es-host>:9500
           version: 8
         tuning:
           compression: gzip   # Vector's `compression` field
   ```

   Confirm with the Elasticsearch administrator that the chosen algorithm is enabled on the ingest side. The supported set per sink is documented by the upstream Vector project.

4. **Iterate.** After each change, watch the `Request timed out` counter converge to zero over a representative load window. If the warning still appears, reduce `maxWrite` further, or combine shrink + compression, or both. Do not increase `request.timeout_secs` — it is not exposed through the managed CLF surface and raising it elsewhere just hides a real throughput problem.

## Diagnostic Steps

Confirm the warning is coming from the collector, and identify which pods are affected:

```bash
ns=<logging-namespace>
cr=<clf-cr-name>

for pod in $(kubectl -n "$ns" get pods -l app.kubernetes.io/instance="$cr" -o name); do
  echo "### $pod"
  kubectl -n "$ns" logs "$pod" | grep -c 'vector::sinks::util::retries: Request timed out'
done
```

Pods whose count climbs quickly are the ones the fix needs to target. A single pod timing out while the rest are fine usually points at a node-local network problem rather than a global throughput issue.

Capture a representative log line for the record:

```bash
for pod in $(kubectl -n "$ns" get pods -l app.kubernetes.io/instance="$cr" -o name); do
  kubectl -n "$ns" logs "$pod" | grep 'vector::sinks::util::retries: Request timed out' | tail -1
done
```

Inspect the effective output tuning and confirm the new values landed after the CLF edit:

```bash
kubectl -n "$ns" get clusterlogforwarder "$cr" \
  -o jsonpath='{range .spec.outputs[*]}{.name}{"\t"}{.tuning}{"\n"}{end}'
```

Verify receiver-side health — a Vector timeout can be the symptom of an overloaded Elasticsearch cluster. Cross-check the Elasticsearch node logs or metrics for bulk-queue rejections (`esrejectedexecutionexception`) and indexing latency. If the receiver is saturated, tuning the collector alone cannot solve the problem; scale up or scale out Elasticsearch first, and revisit the collector afterwards.
