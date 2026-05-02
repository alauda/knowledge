---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Logging Collector Pods OOMKilled Under Back-Pressure — Diagnose Upstream First, Then Raise Limits
## Issue

Logging collector pods (Vector / Fluent Bit / whichever agent is deployed by the logging service's `DaemonSet`) enter `CrashLoopBackOff`. The count of affected pods grows over time, or stays concentrated on specific nodes. `kubectl get pod` inspection confirms the failure is an OOM kill:

```text
logging-collector-5k2v6   0/1   OOMKilled          4   3m
logging-collector-8tnkc   0/1   CrashLoopBackOff   4   3m
logging-collector-xr5k2   0/1   OOMKilled          4   3m
logging-collector-9frsc   1/1   Running            0   3m
```

Some pods on the same DaemonSet keep running — the OOMKills correlate with how much log traffic a specific node generates and how far behind the collector is on shipping it, not with any pod-level misconfiguration.

## Root Cause

A logging collector buffers log events in memory between reading them from local sources (the kubelet's log directory, the journal, custom inputs) and forwarding them to their destination (Loki, Elasticsearch, Kafka, Splunk, etc.). When the destination is healthy and reachable, the buffer stays shallow and memory use is modest. Memory pressure builds in three cases:

1. **Destination slow / failing**. If the sink is slow to acknowledge or is returning errors, the collector retries and the outgoing queue grows. Back-pressure accumulates up the pipeline and pushes the collector's memory toward its limit.
2. **Cold start / historical log replay**. When the collector starts for the first time (or restarts after being down), it processes every log file that is still present on disk. Nodes with long-lived pods or large log files have days of backlog to catch up on, during which memory and CPU are above steady-state.
3. **Node-specific log volume**. Nodes that host chatty workloads (noisy app logs, debug mode, verbose stack traces) push more throughput through their collector than nodes hosting quiet workloads. The same collector pod configuration works on the quiet nodes and OOMs on the chatty ones.

The default `limits.memory` shipped with the logging service is a conservative starting point (typically around `2Gi`) intended for steady-state on average nodes. Hitting it means one of the three conditions above is active — and raising the limit *without* investigating which one is the wrong response: on condition #1 it only delays the OOM, and on a busy day can still run the buffer out of memory at a larger size.

## Resolution

Triage in order: investigate the cause, then adjust the limits only if the cause is load-related (#2 or #3), not delivery-related (#1).

### Step 1 — Check for delivery errors on the destination path

Destination-side errors are visible in the collector logs. Scan recent pods for errors on the output pipeline:

```bash
NS=cluster-logging     # logging namespace on the cluster
for pod in $(kubectl -n "$NS" get pod \
               -l app.kubernetes.io/component=collector -o name); do
  kubectl -n "$NS" logs "$pod" --tail=500 | \
    grep -iE 'error|failed to send|backoff' | head -5
done
```

If the output is populated with repeated `connection refused`, `timeout`, authentication failures, or the back-end's own error responses (`503`, `429`, `MessageSizeTooLarge`, etc.), the sink side is the problem. Fix the sink first:

- Sink unreachable → restore network connectivity or credentials.
- Sink rate-limiting (`429` / backoff pressure) → reduce ingest throughput or raise the sink's throttle.
- Sink rejecting messages (`MessageSizeTooLarge`, field validation) → fix at the collector's filter stage or at the sink.

Once the sink-side error rate drops to zero, the collector's buffer drains and the OOM pressure disappears without any limit change.

### Step 2 — Check for cold-start replay

If the collector just rolled out or was restarted recently, it will be reading every log file that is still on disk. This is expected, typically lasts for a few minutes to an hour depending on backlog size, and resolves on its own.

Confirm by inspecting a collector pod's read position metrics (if the collector exposes them) or by the shape of CPU use: a spike that tapers off within the first hour after rollout is replay; a sustained high rate is either steady-state load (#3) or a sink issue (#1).

During a cold-start replay, raise `limits.memory` temporarily if OOMs prevent the collector from completing the replay at all. Lower it back once steady-state is reached.

### Step 3 — Raise limits to match steady-state load

When the sink is healthy and the collector is past cold-start but still OOMs, the pod genuinely needs more memory for the node's log volume. Raise `limits.memory` through the logging service's `ClusterLogForwarder` / collection configuration.

Example shape (the exact CR name depends on the operator version):

```yaml
apiVersion: observability.alauda.io/v1
kind: ClusterLogForwarder
metadata:
  name: instance
  namespace: cluster-logging
spec:
  collector:
    resources:
      limits:
        cpu: "6"
        memory: "4Gi"
      requests:
        cpu: "500m"
        memory: "128Mi"
```

The operator reconciles the DaemonSet with the new resources; pods roll one per node, come up at the new limit, and the OOM rate on affected nodes should drop to zero.

Pick the new `limits.memory` based on observed steady-state usage × a safety margin:

1. Observe steady-state memory on nodes that *do* stay Running (not the OOMing ones) through `kubectl top pod -n cluster-logging`.
2. Identify the high-water mark on the chatty nodes by letting a few OOMs occur and reading the process's RSS at the moment of kill from the pod's `lastState.terminated` or from the kernel log:

   ```bash
   kubectl -n cluster-logging get pod <pod> -o json | \
     jq '.status.containerStatuses[] | .lastState.terminated'
   ```

3. Set `limits.memory` to about **1.5 × the observed steady-state** of the chattiest node. This leaves headroom for occasional bursts without wasting memory on every node.

`requests.memory` should be set close to the steady-state value so the scheduler reserves adequate headroom; leaving `requests` at the shipped default and only raising `limits` creates `Burstable`-QoS pods that are first to be evicted under node pressure.

### Step 4 — Reduce throughput if memory is not practical to raise

If the node is resource-constrained and `4Gi` for the collector is not acceptable, narrow what the collector processes:

- Add input filters that drop logs you do not need (verbose kube-system components, specific noisy namespaces).
- Increase sampling at ingestion (e.g. `sample_rate: 10` means 1-in-10 events kept).
- Direct specific namespaces' logs to a separate pipeline with tighter filters and lower retention.

Fewer events in the pipeline means less memory held in buffers at any instant; the same collector runs comfortably at a lower limit when the throughput is reduced.

## Diagnostic Steps

Enumerate every collector pod and mark which are OOMKilled, which are running, and which have excessive restarts:

```bash
NS=cluster-logging
kubectl -n "$NS" get pod -l app.kubernetes.io/component=collector \
  -o custom-columns='NAME:.metadata.name,READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,NODE:.spec.nodeName'
```

Map affected pods to their nodes — the chattiest nodes will have the highest restart counts. Cross-reference with per-node log rate:

```bash
# Estimate each node's current log volume by tailing a recent slice on the node.
for node in <affected-nodes>; do
  rate=$(kubectl logs -n "$NS" -l app.kubernetes.io/component=collector \
         --field-selector spec.nodeName="$node" --since=1m 2>/dev/null | wc -l)
  echo "$node  lines/min=$rate"
done
```

Nodes with much higher per-minute log line rates are the ones to size for.

After applying a limit change, watch the DaemonSet roll and confirm the OOM pattern stops. Let a full business cycle pass (a day, or whatever interval represents the workload's busiest period) before concluding the limit is sized right — a limit that holds during a quiet hour may still OOM at peak.
