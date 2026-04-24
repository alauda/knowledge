---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The gateway in front of Loki is steadily returning 500s on the write path, and the distributor logs a matching error whose wall-clock duration always lands at **approximately 1.00 seconds**:

```text
level=warn ... orgID=infrastructure
  msg="POST /loki/api/v1/push (500) 1.001088422s"
```

Counting these in the distributor logs gives a non-trivial rate (tens of thousands in a recent window), which is enough to trip the `LokiStackWriteRequestErrors` alert and to drive retry loops on the collector side. The defining feature is the duration: every failure clusters at one second, never at a random value — a strong hint that a hard-coded 1 s timeout is being hit rather than a network issue.

## Root Cause

Loki's distributor talks to the ingesters over a gRPC client pool. That client pool has a per-request deadline controlled by `ingester_client.remote_timeout`. Older releases of the Logging Service shipped this value at **1 s**, which is tight enough that any of the following push the request past the deadline:

- A brief ingester pause (GC, slow disk flush, transient network blip).
- An elevated ingestion rate where even the normal p99 at the ingester exceeds a second.
- Tenants with very long log lines or wide label sets where serialisation per-chunk takes longer than in the benchmark case.

When the deadline trips, the distributor receives a gRPC `DeadlineExceeded`, converts it to an HTTP 500 on the `/loki/api/v1/push` path, and the caller retries. Because the timeout is uniform and the request always dies at the same point, the duration on every failure is approximately 1 s, which is the fingerprint in the log above.

The value is not tenant-facing and cannot be tuned through the standard LokiStack CRD; it is an operator-internal knob that the Logging Service itself ships. The fix in the managed Logging Service is to raise the default from `1s` to `5s`, which has been rolled into recent Logging Service minor releases.

## Resolution

### Preferred: upgrade the ACP Logging Service to a version that ships the larger default

The supported path on ACP is to keep Loki under the Logging Service's management and upgrade to a version that carries the `5s` default. Once the operator reconciles the new configuration, the distributor picks up the larger deadline, and the cluster of 500s at `~1s` clears on its own.

Check the running Logging Service version in the cluster:

```bash
# The namespace varies by deployment; adjust to where the Logging Service lives.
kubectl -n cpaas-logging get clusterlogging,loki,lokistack
```

If the version predates the fix, schedule the Logging Service upgrade through the normal operator-lifecycle flow (`extend` / in-core operator management). After the upgrade, confirm the new timeout is in effect in the rendered ConfigMap:

```bash
kubectl -n cpaas-logging get cm -l app.kubernetes.io/name=loki \
  -o jsonpath='{.items[*].data.config\.yaml}' | grep -A2 ingester_client
```

The expected block now reads:

```text
ingester_client:
  remote_timeout: 5s
```

and the distributor no longer records failures pinned to the one-second mark.

### Fallback: self-managed Loki (not under the Logging Service)

If Loki is deployed directly (a plain upstream Loki installation alongside ACP, not a LokiStack-managed instance), the timeout can be raised by hand in `limits_config` / `ingester_client`:

```yaml
ingester_client:
  remote_timeout: 5s
```

Apply the change through whatever mechanism manages the Loki config (Helm chart values, hand-written ConfigMap, kustomize overlay). Note two warnings:

- **On a LokiStack managed by the Logging Service operator this edit will be reverted** at the next reconcile. The operator owns that file; do not patch it by hand.
- **Longer timeouts hide downstream slowness.** If the ingester's own p99 is already elevated for a structural reason (undersized disks, memory pressure, too few ingester replicas), raising the timeout only buys time. Plan to look at ingester-level sizing in parallel with the timeout bump.

## Diagnostic Steps

Confirm the fingerprint: 500s clustered at exactly one second on the distributor:

```bash
# Namespace of Loki within the Logging Service (adjust as needed).
LOKI_NS=cpaas-logging

POD=$(kubectl -n "$LOKI_NS" get pod \
        -l app.kubernetes.io/component=distributor \
        -o jsonpath='{.items[0].metadata.name}')

kubectl -n "$LOKI_NS" logs "$POD" \
  | grep 'msg="POST /loki/api/v1/push (500) 1\.' | tail -5

kubectl -n "$LOKI_NS" logs "$POD" \
  | grep -c 'msg="POST /loki/api/v1/push (500) 1\.'
```

A high count with durations all near `1.00something s` pins the cause on the client timeout rather than on a bad ingester.

Verify the configured timeout the operator actually deployed:

```bash
kubectl -n "$LOKI_NS" get cm -l app.kubernetes.io/name=loki \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{.data.config\.yaml}{"\n---\n"}{end}' \
  | grep -B1 -A2 ingester_client
```

Output shape:

```text
ingester_client:
  remote_timeout: 1s     # or 5s if already upgraded
```

If the timeout is already `5s` but the error rate is still elevated, the limit is not the bottleneck — look at the ingester's own metrics (`loki_ingester_chunks_flushed_total`, `loki_ingester_memory_chunks`, CPU throttling on the ingester pods) and at the distributor's request-size histogram. Scaling the ingester StatefulSet replicas, widening the resource requests, or moving off undersized storage are the usual next steps.

For completeness, confirm that the read path is healthy (this symptom should not affect querying, but a sanity check helps rule out a correlated outage):

```bash
kubectl -n "$LOKI_NS" logs deploy/logging-loki-gateway --tail=50 \
  | grep -E 'query|label'
```

Read-path 200s with normal latency confirm the failure is write-side only — the expected pattern for an ingester-client timeout.
