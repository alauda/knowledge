---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# node-exporter InfiniBand Collector Fails to Read Counter Files on Some Kernel / HCA Combinations
## Issue

On nodes equipped with InfiniBand / RoCE HCAs — typically those running a `qedr`, `mlx5_core`, or similar InfiniBand driver — node-exporter pods log repeated errors when the InfiniBand collector runs. Prometheus then fails to scrape InfiniBand metrics from those nodes, leaving gaps in any `node_infiniband_*` series:

```text
ts=2026-03-03T10:53:04.696Z caller=collector.go:169 level=error
  msg="collector failed" name=infiniband duration_seconds=0.000299582
  err="error obtaining InfiniBand class info:
       failed to read file
       \"/host/sys/class/infiniband/qedr0/ports/1/counters/VL15_dropped\":
       invalid argument"
```

The error repeats at every scrape interval. Node-exporter itself keeps running and returns other collectors' metrics normally — the `infiniband` collector is the only one affected — but any dashboard or alert that consumes InfiniBand series sees a persistent gap for the affected nodes.

## Root Cause

The InfiniBand collector walks `/sys/class/infiniband/<hca>/ports/<port>/counters/` and reads each counter file. A subset of kernel + HCA driver combinations expose certain counter files (for example `VL15_dropped` on some `qedr` HCAs) whose `read()` returns `EINVAL` instead of a numeric value. The upstream `procfs`/`sysfs`-based collector does not tolerate the error gracefully — it surfaces the read failure as a collector-wide failure, which Prometheus then records as a scrape error.

This is a known issue between the kernel driver reporting certain counters as invalid and the node-exporter collector aborting on the first read error. A fix that skips individual unreadable counters rather than failing the whole collector is available in newer monitoring stack releases; older releases do not carry the fix and do not expose a configuration option to disable just the affected counter file.

There is no client-side workaround that recovers the missing counters. The choice is to upgrade the monitoring stack, disable the whole InfiniBand collector, or accept the gap until the fix lands.

## Resolution

### Preferred — upgrade the monitoring stack operator

Follow the platform's monitoring-stack operator upgrade path to a release that carries the robust InfiniBand collector. After the upgrade rolls out:

1. The node-exporter DaemonSet reconciles and replaces pods with a build that tolerates the unreadable counter.
2. Scrape errors stop appearing in the node-exporter pod logs.
3. `node_infiniband_*` series fill in on the affected nodes within one or two scrape intervals.

Verify:

```bash
POD=$(kubectl -n monitoring get pod -l app.kubernetes.io/name=node-exporter \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n monitoring logs "$POD" -c node-exporter --tail=200 | \
  grep -c 'error obtaining InfiniBand class info' || true
```

A count of zero across a meaningful window (10+ minutes) after the upgrade confirms the fix.

### Workaround — disable the InfiniBand collector

If the upgrade cannot happen yet, disable the InfiniBand collector across the DaemonSet so node-exporter stops the repeated read-and-fail cycle. This trades the scrape-error for a deliberate absence of InfiniBand metrics, which is less disruptive than a repeatedly-failing collector:

```bash
# Add the explicit disable flag through the monitoring stack's config surface.
# The exact CR shape depends on how the platform exposes node-exporter args.
# Typical shape:
kubectl -n monitoring patch clustermonitorconfig cluster --type=merge -p '
spec:
  nodeExporter:
    extraArgs:
      - --no-collector.infiniband
'
```

After the operator reconciles, node-exporter pods restart with the collector disabled; scrape errors stop and `node_infiniband_*` series cease to exist (any dashboard / alert pinning on them reports `no data`, which is preferable to scrape failures that also destabilise other collectors).

### Do not try

- Editing node-exporter's `DaemonSet` directly. The operator reconciles it back.
- Hand-patching `/host/sys/class/infiniband/…`. The counter files are exposed by the kernel driver; a hand-made override does not survive a driver reload.
- Lowering the scrape interval. The error triggers every scrape regardless of interval; lowering the interval just makes the error fire more often.

## Diagnostic Steps

Confirm the error originates from the InfiniBand collector specifically and is not a symptom of a broader node-exporter issue:

```bash
POD=$(kubectl -n monitoring get pod -l app.kubernetes.io/name=node-exporter \
        -o jsonpath='{.items[0].metadata.name}')

# Count errors by collector name.
kubectl -n monitoring logs "$POD" -c node-exporter --tail=5000 \
  | grep '"collector failed"' \
  | sed -n 's/.*name=\([a-z]*\).*/\1/p' | sort | uniq -c | sort -rn
```

A row of `358 infiniband` (or similar large count) followed by near-zero counts for other collectors isolates the problem to the InfiniBand collector.

Inspect the specific counter file that fails to read, so you know which HCA / port is affected and can cross-reference against node hardware:

```bash
kubectl -n monitoring logs "$POD" -c node-exporter --tail=1000 \
  | grep 'error obtaining InfiniBand class info' | head -3
```

The `failed to read file` segment of each line names the HCA and the specific counter. Multiple entries against the same `(hca, port)` pair indicate one physical port is the source; multiple entries across different HCAs indicate the issue is at the driver layer rather than a specific port fault.

Confirm the scrape failure in Prometheus by querying the scrape-success metric, once any collector error causes the whole scrape to record as unsuccessful on some build lines:

```bash
kubectl exec -n monitoring "$POD" -c node-exporter -- \
  wget -qO- http://localhost:9100/metrics | \
  grep -E 'node_scrape_collector_success{collector="infiniband"}'
```

The line reports `0` when the collector fails. Under a fixed build, it reports `1` even when individual counter files error out, because the collector tolerates the read error internally.
