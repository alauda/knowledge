---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Prometheus pods reach a `Running` state but never become `Ready`, and they restart every few tens of minutes in a loop:

```text
prometheus-k8s-0   5/6   Running   60 (33m ago)   24h
prometheus-k8s-1   5/6   Running   59 (26m ago)   24h
```

The Prometheus container logs show WAL replay in progress but never reach the "TSDB started" line:

```text
level=INFO source=head.go:752 msg="Replaying WAL, this may take a while" component=tsdb
level=INFO source=head.go:789 msg="WAL checkpoint loaded"                component=tsdb
level=INFO source=head.go:825 msg="WAL segment loaded"                   component=tsdb segment=52 maxSegment=283 duration=3.831967903s
```

Some pods exit with `exitCode: 137` (OOM kill) mid-replay. Metrics-scraping is effectively down during the cycle — dashboards show gaps, alerting rules miss evaluation cycles.

## Root Cause

Prometheus keeps the most recent two hours of samples in an in-memory `HEAD` block. When the container stops, that HEAD is flushed to disk as a write-ahead log (WAL). On startup, Prometheus rebuilds the in-memory HEAD by replaying every WAL segment. The replay finishes once the last segment has been parsed and the in-memory data structure is consistent; at that point Prometheus logs `TSDB started` and the container becomes ready.

Three things make replay slow enough to exceed the startup-probe budget:

1. **Memory limit too low.** Replay allocates at least as much memory as the steady-state HEAD consumed before shutdown. If the pod's memory limit was sized for a smaller working set than the actual HEAD, the kernel OOM-kills the container mid-replay and Kubernetes restarts it — replay starts over from zero, the same OOM happens, the cycle continues.

2. **High segment count driven by high cardinality.** A WAL segment is ~128 MiB by default, and each segment's replay is CPU+memory work. Cluster-level bursts in label cardinality (upgrades that temporarily add labels, noisy exporters, churning namespaces) cause segment counts to balloon. A cluster whose segment count jumped from a healthy 50 to 283 will pay roughly 5× the replay time.

3. **Slow / saturated disk.** Replay reads every segment from disk sequentially. If the PVC's storage class is backed by a network-attached filesystem that shares bandwidth with other tenants, or the node is under IO pressure from something else, replay-read IOPS drop and the wall-clock time rises. This is the only root cause where CPU and memory are plentiful but the wall clock still hits the startup-probe ceiling.

The fix path depends on which of these is dominant. Step 1 below is the diagnosis — read the pod's `exitCode`, `memory` use, segment count, and disk IO — then pick the matching remediation from Step 2.

## Resolution

### Step 1 — diagnose which root cause is dominant

Find the Prometheus pod and its namespace. On ACP with the `prometheus` moduleplugin installed, Prometheus typically runs in `cpaas-monitoring` (or whichever namespace the plugin placed it in):

```bash
NS=cpaas-monitoring   # or kube-system, or the plugin's namespace
kubectl -n "$NS" get pod -l app.kubernetes.io/name=prometheus
```

**Memory check** — exit code 137 is the OOM signature:

```bash
kubectl -n "$NS" get pod <prom-pod> -o=jsonpath='{.status.containerStatuses[?(@.name=="prometheus")].lastState.terminated.exitCode}{"\n"}'
# 137 → OOM kill; any other non-zero → investigate separately
```

**Segment count** — replay time scales roughly linearly with segment count:

```bash
kubectl -n "$NS" exec <prom-pod> -c prometheus -- sh -lc '
  du -sh /prometheus/wal /prometheus 2>/dev/null
  ls /prometheus/wal 2>/dev/null | wc -l
'
```

A "healthy" cluster typically has 50–100 WAL segments. A cluster in trouble has 200+.

**Disk IO check** — use `vmstat` on the node hosting the pod:

```bash
NODE=$(kubectl -n "$NS" get pod <prom-pod> -o=jsonpath='{.spec.nodeName}')
kubectl debug node/"$NODE" -it --image=busybox -- sh -lc 'chroot /host vmstat -t 5 5'
```

In the output, watch the `b` column (blocked processes waiting on IO) and `wa` (IO wait %). A cluster where replay is disk-bound shows `b > 1` persistently and `wa > 20 %`.

### Step 2a — if OOM: raise the memory limit

Patch the monitoring config that owns Prometheus. For the ACP prometheus plugin, the values are on the `Prometheus` CR or on the plugin's ConfigMap:

```bash
# If configured via a Prometheus CR:
kubectl -n "$NS" edit prometheus k8s
# Raise spec.resources.limits.memory and spec.resources.requests.memory (keep them equal
# to get Guaranteed QoS, which protects against eviction).

# If configured via a ConfigMap (e.g. cluster-monitoring-config):
kubectl -n "$NS" edit configmap cluster-monitoring-config
```

Starting guideline: double the previous memory limit. If the pod survives replay and shows a stable working set, leave the limit there; if it still OOMs, double again. The HEAD's steady-state memory is visible in Prometheus's own metric `prometheus_tsdb_head_series` multiplied by roughly 3 KiB/series — that is the floor for the limit.

### Step 2b — if high segment count: reduce cardinality

Find the high-cardinality sources:

```bash
kubectl -n "$NS" exec <prom-pod> -c prometheus -- \
  promtool tsdb analyze /prometheus --limit=10
```

The output ranks metrics by label cardinality. Common offenders: metric labels that capture full pod UIDs, per-request labels on HTTP metrics, per-user identifiers baked into a metric label. Address at the source — edit the exporting application to drop the high-cardinality label — or relabel at scrape time via the `ServiceMonitor` / `PodMonitor` CR to strip the offending labels.

Temporarily, you can disable a noisy ServiceMonitor / PodMonitor to let Prometheus catch up on replay:

```bash
kubectl -n <target-ns> annotate servicemonitor <sm-name> \
  monitoring.coreos.com/disable=true
```

Remove the annotation once replay completes and the steady-state is stable.

### Step 2c — if disk-bound: move the PVC to faster storage or add resources

If the PVC's storage class is slow, migrate the WAL to a faster class. This is a full data move — either by detaching the PVC and copying the data to a new PVC, or by scaling Prometheus to zero, creating a new PVC, re-attaching, and letting Prometheus backfill from the remote write / long-term store (if one is configured).

On ACP with Rook-Ceph, the appropriate class is typically `rook-ceph-block` on NVMe OSDs; avoid filesystem-backed storage classes for the WAL.

### Step 3 — last-resort: delete the WAL

If replay simply cannot complete within any reasonable timeout — the pod must come back up now and you are willing to lose the last 2 hours of samples — you can delete the WAL directory:

```bash
# One pod at a time; if running HA pair, the other pod still has the WAL.
kubectl -n "$NS" exec <prom-pod> -c prometheus -- sh -lc '
  cd /prometheus
  ls -l
  rm -rf wal/*
'
kubectl -n "$NS" delete pod <prom-pod>
```

The pod will come back with an empty HEAD. Historical blocks on disk (each a directory like `01GHCQHVM7BEH6JFX3PJJWQHVZ`) remain queryable; only the last ~2 hours of in-memory samples are gone.

## Diagnostic Steps

Confirm the replay is the stalled stage and not, for example, the object-storage sidecar (Thanos sidecar / long-term-store writer), which can produce superficially similar "not ready" symptoms:

```bash
kubectl -n "$NS" logs <prom-pod> -c prometheus --tail=200 | \
  grep -E 'Replaying WAL|TSDB started|WAL segment loaded'
```

The last line should increment its `segment=N` value over time. If the number is not advancing at all for minutes, the container is stuck (not just slow) — that points at a disk-IO or code-level issue, not the high-cardinality / memory scenario.

Measure steady-state series count after replay completes — this sets the floor for future memory limits:

```bash
kubectl -n "$NS" exec <prom-pod> -c prometheus -- \
  curl -s http://localhost:9090/api/v1/query?query=prometheus_tsdb_head_series | \
  jq -r '.data.result[0].value[1]'
```

Multiply by 3 KiB for a rough working-set estimate; compare against the pod's `memory.limits`. Less than 2× headroom means the next cardinality burst will re-trigger this issue.

Finally, check whether the pod has `QoS: Guaranteed` — required to avoid eviction under node memory pressure:

```bash
kubectl -n "$NS" get pod <prom-pod> -o=jsonpath='{.status.qosClass}{"\n"}'
```

`Guaranteed` requires `requests == limits` for both CPU and memory. `Burstable` QoS leaves the pod vulnerable to eviction mid-replay even if the limit alone would have been enough — so the right fix is often to set `requests == limits`, not just to raise limits.
