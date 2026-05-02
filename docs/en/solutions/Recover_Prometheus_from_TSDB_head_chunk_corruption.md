---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Recover Prometheus from TSDB head chunk corruption
## Issue

The platform monitoring stack starts emitting `KubeAPIDown` (and other rule-based) alerts even though `kubectl get --raw=/healthz` and the API server pods themselves are healthy. The Prometheus pods log repeated rule-evaluation failures of the form:

```text
ts=YYYY-MM-DDTHH:MM:SS.XXXZ caller=group.go:NNN level=warn
  component="rule manager" file=/etc/prometheus/rules/...rules.yaml
  group=kube-prometheus-node-recording.rules
  msg="Evaluating rule failed"
  rule="record: instance:node_cpu:rate:sum
        expr: sum by (instance) (rate(node_cpu_seconds_total{...}[3m]))"
  err="corruption in head chunk file /prometheus/chunks_head/00xxx4:
       checksum mismatch expected:0, actual:dxxxxx6"
```

Recording- and alerting-rule queries return errors instead of values, so any alert whose expression depends on those rules fires spuriously.

## Root Cause

Prometheus persists the most recent (still-mutable) two-hour window of samples as **head chunks** plus a **write-ahead log (WAL)** under `/prometheus/`. Head chunks are written with a per-chunk checksum so that a partial or torn write can be detected on the next read.

A checksum mismatch in `/prometheus/chunks_head/...` means the head chunk file on disk is no longer self-consistent. Common triggers:

- The Prometheus pod was killed ungracefully (OOM, node power loss, forced eviction) before the in-memory head was flushed.
- The PV / underlying storage acknowledged a write that was not actually durable (storage latency spike, controller failover, kernel page-cache loss on a host crash).
- A node-level failure interrupted an in-flight write to a head chunk.

Once a head chunk is corrupt, the rule manager that tries to read it surfaces the error on every evaluation tick, which is what produces the `KubeAPIDown`-style false positives — the alert is not really about the API server, it is about the recording rule that feeds it.

## Resolution

ACP exposes the platform Prometheus through `observability/monitor` (Prometheus Operator + Thanos). The recovery procedure is the same as for any open-source Prometheus deployment: stop the operator from reconciling the StatefulSet, delete the corrupted head and WAL files inside the affected pod, and let Prometheus rebuild from the persisted blocks.

> Important: deleting `chunks_head/` and `wal/` discards the most recent (typically up to two hours) of samples for that replica. Long-term blocks already flushed to disk — and any data already shipped to Thanos / object storage — are preserved. If two Prometheus replicas are running and only one is corrupt, the surviving replica still serves the recent window.

1. **Pause the operator** so it does not fight the manual cleanup. Substitute the namespace where the platform monitoring stack lives (`cpaas-system` for the in-core ACP `observability/monitor` install).

   ```bash
   NS=cpaas-system          # adjust for your install
   kubectl -n "$NS" scale deploy prometheus-operator --replicas=0
   ```

2. **Identify the affected Prometheus pod** and confirm the corruption error on it (do not blindly clean every replica):

   ```bash
   kubectl -n "$NS" get pods -l app.kubernetes.io/name=prometheus
   kubectl -n "$NS" logs <prom-pod> -c prometheus --tail=200 \
     | grep -i "corruption in head chunk"
   ```

3. **Remove only the corrupted head chunks and WAL** inside the failing pod. The Prometheus container runs as a non-root user; the data directory is `/prometheus`.

   ```bash
   kubectl -n "$NS" exec -it <prom-pod> -c prometheus -- \
     sh -c 'rm -rf /prometheus/chunks_head/* /prometheus/wal/*'
   ```

4. **Restart the Prometheus pod** so the TSDB re-opens cleanly:

   ```bash
   kubectl -n "$NS" delete pod <prom-pod>
   ```

5. **Resume the operator** to restore normal reconciliation:

   ```bash
   kubectl -n "$NS" scale deploy prometheus-operator --replicas=1
   ```

6. **Verify**. The pod should reach `Ready`, the corruption log line should stop, and rule evaluation should succeed:

   ```bash
   kubectl -n "$NS" get pod <prom-pod> -w
   kubectl -n "$NS" logs <prom-pod> -c prometheus --tail=200 \
     | grep -E 'level=err|head chunk|"Evaluating rule failed"' || echo "clean"
   ```

If the original `KubeAPIDown` alert was a false positive caused by a broken recording rule, it should resolve on the next evaluation cycle once the rule starts producing values again.

### Prevention

- Provision the Prometheus PV on storage that honors `fsync` and survives node reboots without losing committed pages.
- Run **two** Prometheus replicas (the operator's default) so a single-replica TSDB corruption does not cause a monitoring outage.
- Keep Thanos / remote-write export to long-term object storage enabled — the recent-window loss during this recovery is then bounded to whatever has not yet been shipped.
- Avoid hard-killing Prometheus pods. When draining a node, let the kubelet's graceful termination flush the head.

## Diagnostic Steps

```bash
# 1. Confirm the alert really comes from a broken recording rule, not the API server.
kubectl get --raw=/healthz       # API server should answer "ok"
kubectl get --raw=/readyz?verbose

# 2. Find which Prometheus replicas are logging the corruption.
NS=cpaas-system
for p in $(kubectl -n "$NS" get pod -l app.kubernetes.io/name=prometheus \
             -o name); do
  echo "==== $p ===="
  kubectl -n "$NS" logs "$p" -c prometheus --tail=300 \
    | grep -E 'corruption in head chunk|"Evaluating rule failed"' | tail -5
done

# 3. Inspect the on-disk layout (sanity check before deleting anything).
kubectl -n "$NS" exec <prom-pod> -c prometheus -- ls -lh /prometheus
kubectl -n "$NS" exec <prom-pod> -c prometheus -- ls -lh /prometheus/chunks_head | head
kubectl -n "$NS" exec <prom-pod> -c prometheus -- ls -lh /prometheus/wal | head

# 4. After recovery, confirm rule evaluation is healthy.
kubectl -n "$NS" exec <prom-pod> -c prometheus -- \
  wget -qO- http://localhost:9090/api/v1/rules | \
  jq '.data.groups[].rules[] | select(.health!="ok")'
```

If `chunks_head/` keeps growing back into corruption after recovery, the root cause is upstream of Prometheus — investigate the underlying storage class, node stability, and the pod's recent termination history (`kubectl -n "$NS" describe pod <prom-pod>` for `Last State: Terminated` reasons).
