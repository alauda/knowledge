---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Some application logs never reach the configured downstream destination. Other application logs from the same pods get through. The collector pods (Vector running as a node-side DaemonSet) emit a steady trickle of error events that name the source as a Kubernetes-logs input and the action as *discarding*:

```text
ERROR source{component_kind="source"
             component_id=input_application_container_container
             component_type=kubernetes_logs}:
  vector::internal_events::kubernetes_logs:
  Found line that exceeds max_merged_line_bytes; discarding
```

Lines that exceed the collector's merged-line size threshold are dropped at the source — they never enter the pipeline, so no transform, no batching, no destination ever sees them. Downstream the picture is "we are missing log lines"; on the collector the picture is "we are deliberately throwing away the largest ones."

## Root Cause

The Vector `kubernetes_logs` source has a tunable cap on how big a single *merged* log message can grow. The cap is what the collector applies after a multiline merge has finished combining continuation lines (typical Java stack-trace folding, Python tracebacks, multi-line JSON pretty-printed by an application). The reasoning behind a cap is well-founded — without one, a runaway multiline pattern can grow a single message to gigabytes and OOM the collector. The default is conservative for a typical workload and is **smaller** than the longest legitimate message some applications can produce: deeply nested Java exception traces, large JSON payloads logged at error level, application dumps printed to stdout.

When a merged line exceeds the cap, Vector logs the discard event above and drops the line. The line is gone — it is not held in a buffer, it is not retried, it is not sent at a smaller size. The only knob the operator has is the cap itself, exposed in the log-forwarder configuration as `tuning.maxMessageSize`.

## Resolution

Raise `tuning.maxMessageSize` on the affected input in the cluster's log-forwarder CR. The field's unit is bytes; pick a value that comfortably covers the longest legitimate merged message but stays well under the available memory of the collector pod.

### 1. Inspect the current forwarder CR

The CR's exact API group depends on the log-forwarder operator the cluster is running. The shape used in the recent observability-API release looks like:

```bash
kubectl get clusterlogforwarder -n <log-forwarder-namespace> instance -o yaml
```

(or whichever namespace and CR name your cluster uses).

Look at `spec.inputs.application` — that is the input that emits the failing source events.

### 2. Add or raise `tuning.maxMessageSize`

```yaml
apiVersion: <observability-group>/v1
kind: ClusterLogForwarder
metadata:
  name: instance
  namespace: <log-forwarder-namespace>
spec:
  inputs:
    application:
      tuning:
        maxMessageSize: 512000        # bytes; raise from the default toward your largest legitimate message
```

The example above sets 512 000 bytes (~500 KiB), which is comfortable for typical Java-style stack traces. Pick a value based on what your application actually emits — see step 4 below for how to size it from data.

Apply the change:

```bash
kubectl apply -f forwarder.yaml
# or:
kubectl edit clusterlogforwarder -n <log-forwarder-namespace> instance
```

### 3. Wait for the collector pods to reconcile

The forwarder operator regenerates the Vector configuration and rolls the collector DaemonSet. Watch for the rollout to complete:

```bash
kubectl rollout status -n <log-collector-namespace> ds/<vector-daemonset>
```

After the rollout, the discard error from the source should stop appearing in the collector logs. Re-trigger an application path that produces a long log line and verify it shows up downstream.

### 4. Sizing maxMessageSize from data

Set the cap large enough to absorb the application's longest legitimate message but small enough that a runaway producer cannot drown the collector. Two ways to size it:

- **From historical drops** — read the discarded-line count over a representative window. Vector exposes a counter for the discard event:

  ```text
  rate(vector_internal_log_events_total{event="kubernetes_logs_received_event"}[5m])
  rate(vector_component_discarded_events_total{component_id="input_application_container_container"}[5m])
  ```

  If the discard rate is non-zero only on a known producer (a specific Deployment), inspect that Deployment's longest emitted line; size `maxMessageSize` to a small multiple of it.

- **From the worst-case single message** — write a small probe pod that emits a known-size line and confirm everything below that size makes it through, everything above is dropped. The size at which it starts dropping is the current cap.

### 5. Considerations

- **Collector memory** — the cap is applied before any downstream batching, so a larger cap means individual events are bigger and the collector's per-event memory grows. A cap of a few hundred KiB is comfortable; a cap of tens of MiB requires bumping the collector pod's memory request and limit accordingly.
- **Downstream limits** — most log backends also have a per-message size limit. Raising the collector's cap above what the backend will accept just moves the drop one stage downstream. Confirm the backend's own limit (Kafka topic max, S3 part size, ClickHouse / Loki ingest body cap) and stay below the smallest of them.
- **Multiline rules first** — if the discards are caused by an over-eager multiline regex that glues together unrelated lines into a multi-MB blob, the right fix is to **tighten the multiline rule**, not to raise the cap. Investigate whether the discarded "single message" is actually one logical event or a million unrelated ones merged accidentally.

## Diagnostic Steps

1. Confirm the discards are real and not a side effect of a different failure (collector OOM, source restart, queue backpressure). The discard event is the only Vector event that says `Found line that exceeds max_merged_line_bytes`. Grep for that exact phrase:

   ```bash
   kubectl logs -n <log-collector-namespace> -l <collector-label> --tail=200 \
     | grep 'max_merged_line_bytes'
   ```

2. Identify which workload is producing the oversize lines. The discard event records the source component but not the originating pod; correlate by sampling the timestamps with the application's output:

   ```bash
   for ns in $(kubectl get ns -o name | sed 's|^namespace/||'); do
     kubectl logs -n "$ns" --all-containers --since=10m --max-log-requests=20 \
       --tail=-1 2>/dev/null | awk 'length > 250000' | head -1 \
       | xargs -r -I{} echo "$ns has a long line"
   done
   ```

   The namespaces that flag here are the candidates.

3. After raising `maxMessageSize`, verify both that no more discard events fire and that the previously-missing lines arrive at the destination. The two together prove the cap was the only thing in the way; if discards stop but lines still don't arrive, look at the *next* stage (transforms, sinks) for a similar size cap.

4. Watch the collector's memory over a representative window after the change. A higher cap that sits idle is fine; a higher cap that is constantly being approached by a runaway producer is a sign the producer has a bug — fix the application, do not let the cap stretch indefinitely.
