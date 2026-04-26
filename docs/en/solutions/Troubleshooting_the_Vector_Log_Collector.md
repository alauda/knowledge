---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Vector is deployed as a per-node DaemonSet that tails container logs and forwards them to one or more sinks (Loki, an object store, an external syslog endpoint). Symptoms that bring an operator to this article:

- log lines from one or more namespaces are not appearing in the downstream store, or are arriving with growing latency;
- Vector pods restart on a CrashLoopBackOff or OOMKilled cycle on a subset of nodes;
- Vector's own metrics show ever-growing buffer or `events_discarded_total` counters.

The collector was running and healthy until the workload changed (a new noisy application, an outage on the downstream sink, or an upgrade to the collector image).

## Root Cause

Most Vector failures fall into one of three buckets:

1. **Source side — container log volume exceeds the collector's read budget.** A pod logging hundreds of MB/s, or a thousand-line stack trace replayed in a tight loop, fills the collector's read buffer faster than it can drain.
2. **Sink side — the downstream is rejecting or slowing acks.** Loki responds with HTTP 429 (`too many requests`) or 500s; an object-store endpoint is unreachable; the network path between collector and sink saturates.
3. **Configuration — a transformation regex misfires.** A `remap` block dies on unexpected fields; a multiline parser concatenates everything into a single megabyte event; a route condition silently drops events.

Vector handles back-pressure by buffering. If the buffer is in-memory, prolonged back-pressure becomes OOMKilled. If the buffer is on disk, it grows until the node's `/var` fills and the kubelet evicts the pod for disk-pressure.

## Resolution

### Step 1: Confirm Which Pods Are Affected

Each collector pod runs on one node and only sees the containers on that node. Identify the failing pods first:

```bash
kubectl -n <logging-namespace> get pods -l app=vector -o wide
kubectl -n <logging-namespace> get pods -l app=vector --field-selector=status.phase!=Running
```

If only some pods are affected, the cause is almost certainly node-local: a noisy workload on those nodes, a saturated disk, or a hardware degradation. If all pods are affected, look at the sink side.

### Step 2: Inspect the Collector's Own Logs

Vector logs to stdout. Enable verbose mode if the default level does not make the cause obvious:

```bash
kubectl -n <logging-namespace> logs -l app=vector --tail=200 --prefix
kubectl -n <logging-namespace> logs <vector-pod> --previous   # if it restarted
```

Common patterns:

- `transform "<name>" failed` — a `remap` or `parse_*` transform raised on an unexpected field. Fix the transform's null-handling.
- `sink "<name>" dropped event` — the sink rejected the event; the next message usually contains the upstream HTTP status.
- `Buffer full; events will be discarded` — the configured buffer reached its limit. Either raise the limit, switch to disk-backed buffering, or address the downstream slowness.

### Step 3: Look at Vector's Internal Metrics

Vector exposes Prometheus metrics on `/metrics` (port 9598 by default). The fastest signal of trouble:

```bash
kubectl -n <logging-namespace> port-forward <vector-pod> 9598:9598 &
curl -s http://localhost:9598/metrics | grep -E '^vector_(events_(in|out|discarded)_total|buffer_(events|byte_size))'
```

What to look for:

- `vector_events_in_total` rising while `vector_events_out_total` stalls — the sink is the bottleneck.
- `vector_buffer_events` climbing without bound — back-pressure is accumulating.
- `vector_events_discarded_total` non-zero — events have been lost; treat this as a P1 unless `drop_on_buffer_full` was an intentional choice.

### Step 4: Tune the Collector

Once the bottleneck is located, adjust the collector configuration:

```yaml
# Excerpt from a Vector ConfigMap — illustrative.
sources:
  k8s_logs:
    type: kubernetes_logs
    extra_label_selector: ""           # narrow if a single workload dominates
    glob_minimum_cooldown_ms: 1500
    max_line_bytes: 32768              # protect against runaway lines

transforms:
  parse_app:
    type: remap
    inputs: [k8s_logs]
    source: |
      # Coerce to object so a missing .message does not panic.
      .message = string!(.message ?? "")

sinks:
  loki:
    type: loki
    inputs: [parse_app]
    endpoint: http://loki-gateway.<ns>.svc:80
    encoding: { codec: json }
    request:
      concurrency: adaptive
      retry_attempts: 5
    buffer:
      type: disk
      max_size: 8589934592             # 8 GiB on-disk buffer
      when_full: block                 # back-pressure rather than drop
```

Key levers:

- **`max_line_bytes`** — caps the single-line size; a runaway producer cannot OOM the collector by emitting one giant line.
- **`buffer.type: disk` + `when_full: block`** — survives short downstream outages; under prolonged outage the source slows and the kubelet eventually evicts the affected pods rather than losing events.
- **`request.concurrency: adaptive`** — Vector negotiates parallelism with the sink rather than hammering it with a fixed value that the sink may rate-limit.

### Step 5: Multiline Configuration

Multiline parsing (joining stack-trace continuation lines into one event) is a source of subtle bugs. Validate the regex on a representative log file before rolling out:

```yaml
sources:
  k8s_logs:
    type: kubernetes_logs
    auto_partial_merge: true
    multiline:
      start_pattern: '^\d{4}-\d{2}-\d{2}'
      mode: continue_through
      condition_pattern: '^\s'
      timeout_ms: 1000
```

If `start_pattern` is too loose (matches more than the intended language's stack-trace prefix), unrelated log lines will be merged. If it is too strict, every line is its own event and the multiline behaviour is effectively off.

## Diagnostic Steps

Confirm the DaemonSet is rolled out and ready:

```bash
kubectl -n <logging-namespace> get daemonset vector
kubectl -n <logging-namespace> rollout status daemonset/vector
```

Spot-check a single node's collector for read-side health by tailing the node's container-log directory:

```bash
NODE=<node>
kubectl debug node/${NODE} -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host sh -c 'ls -lh /var/log/pods/ | head; df -h /var/log /var/lib/vector 2>/dev/null'
```

If `/var/log/pods/` contains many GB across thousands of files, a noisy producer is the likely culprit and source-side throttling will buy more leeway than tuning the sink.

For a sink that is suspected of rejecting events, hit it directly from inside the cluster to bypass DNS / service-mesh complications:

```bash
kubectl run curl --image=curlimages/curl --rm -it --restart=Never -- \
  -sk -X POST -H 'Content-Type: application/json' -d '{"streams":[]}' \
  http://loki-gateway.<ns>.svc:80/loki/api/v1/push
```

A 200 / 204 confirms the path; a 4xx points at the sink configuration; a hang points at network policy or service-mesh between the collector and the sink.
