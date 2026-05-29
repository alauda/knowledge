---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500548
---

# Prometheus WAL replay slow or pod restarts before replay finishes on ACP

## Issue

On Alauda Container Platform (install package `v4.3.4`, kube-prometheus chart `v4.3.3`, container image `registry.alauda.cn:60080/3rdparty/prometheus/prometheus:v3.11.3-v4.3.4`), the unified Prometheus runs as `cpaas-system/prometheus-kube-prometheus-0-0` (StatefulSet `prometheus-kube-prometheus-0`, container `prometheus`). Prometheus persists the most recent ~2 hours of in-memory HEAD samples to disk as a write-ahead log and replays that WAL on container startup to rebuild the in-memory HEAD before serving queries.

During WAL replay the Prometheus process emits `head.go` log lines reporting replay progress: `Replaying WAL, this may take a while`, then per-segment lines of the form `WAL segment loaded segment=<N> maxSegment=<M> duration=<d>`, and finally `WAL replay completed` once the on-disk segments have been applied.

When WAL replay takes longer than the container's startup probe budget, the kubelet restarts the container before replay can finish. The pod then stays at a not-fully-ready state with an incrementing restart count and the WAL replay completion log line is never reached. The ACP default startup probe on the prometheus container is `httpGet /-/ready` on the `web` port with `failureThreshold=60` and `periodSeconds=15`, giving roughly 15 minutes of headroom before the kubelet restarts the container.

## Root Cause

WAL replay must allocate enough heap to materialise the HEAD in memory while it scans the on-disk segments. When the prometheus container's `memory.limit` is set too low for the dataset, replay cannot complete because heap pressure builds before the HEAD is reconstructed. When the container exceeds its `memory.limit`, the kernel cgroup OOM killer terminates the process with `exitCode: 137`, which on a pod with `memory.requests` lower than `memory.limit` (Burstable QoS) is the typical failure signature. Setting `memory.requests` and `memory.limit` to the same value upgrades the pod to Guaranteed QoS class.

WAL segment count scales with the cardinality of metrics ingested. A larger segment count makes replay slower because Prometheus has to read and apply more on-disk segments at startup, so a sudden cardinality jump (label explosion, a new noisy exporter, or an upgrade that introduces additional labels) lengthens replay time proportionally.

The WAL is stored on the dedicated RWO PVC `prometheus-kube-prometheus-0-db-...` (StorageClass `topolvm-hdd`, 30Gi) mounted at `/prometheus` via `subPath=prometheus-db`. The `wal/` directory contains the numbered segment files plus a `checkpoint.<N>` directory. Replay throughput is bounded by sequential read performance from this volume, so disk I/O saturation on the backing device manifests as a slow WAL replay.

## Resolution

Raise the prometheus container's `memory.limit` so the WAL replay's working set fits in heap and the pod can complete startup. The `ClusterPluginInstance/prometheus` `spec.config.components.prometheus` surface on this build exposes `retention`, `scrapeInterval`, `scrapeTimeout` plus a top-level `size` enum and a `storage` block; it does not expose a `resources` / `memory.limit` sub-field directly. The container memory limit is therefore tuned on the rendered Prometheus CR (`monitoring.coreos.com/v1 Prometheus` in `cpaas-system`) by overriding the `prometheus` container's `resources.limits.memory`, or by patching the StatefulSet `prometheus-kube-prometheus-0` container resources for the `prometheus` container:

```bash
kubectl -n cpaas-system get prometheus.monitoring.coreos.com
kubectl -n cpaas-system edit prometheus.monitoring.coreos.com <name>
```

Reduce high-cardinality sources to lower ingestion volume and shorten subsequent WAL replays. Drop unneeded labels and scale back noisy `ServiceMonitor` / `PodMonitor` scopes; the `prometheus-operator` in `cpaas-system` reconciles the change by re-rendering the Prometheus configuration Secret, and the Prometheus process picks up the reduced target set on the next reload.

Temporarily disable noisy `ServiceMonitor` or `PodMonitor` objects to reduce scrape ingestion and let Prometheus catch up on WAL replay and compaction; deleting or re-labelling the relevant `monitoring.coreos.com/v1` `ServiceMonitor` / `PodMonitor` triggers the operator to re-render the configuration and shrink the scrape target list on reload.

```bash
kubectl -n cpaas-system get servicemonitor,podmonitor
kubectl -n cpaas-system label servicemonitor <noisy-sm> alauda.io/disabled=true --overwrite
```

Move the Prometheus storage to a faster-storage class to speed WAL replay, since replay is dominated by sequential reads off the backing volume. The storage class is configured on the `ClusterPluginInstance/prometheus` `spec.config.storage`, which is rendered into the Prometheus CR's storage section. The storageClass change applies to newly provisioned PVCs; an already-Bound `prometheus-kube-prometheus-0-db-...` PVC keeps its original storage class and will not auto-migrate, so completing the swap requires PVC re-creation (and accepting the resulting loss of WAL / recent blocks) or an explicit data-migration step out of band.

```yaml
apiVersion: cluster.alauda.io/v1alpha1
kind: ClusterPluginInstance
metadata:
  name: prometheus
spec:
  pluginName: prometheus
  config:
    storage:
      storageClass: <faster-storage-class>
      capacity: 40
```

As a last-resort recovery when replay cannot complete and historical recent samples can be sacrificed, delete the contents of `/prometheus/wal/` inside the Prometheus pod. The pod then starts without replaying, at the cost of losing approximately the last 2 hours of in-memory samples that had not yet been flushed to a TSDB block. The prometheus container's busybox build includes `/bin/sh` and `rm`, so this recipe is mechanically valid:

```bash
kubectl -n cpaas-system exec prometheus-kube-prometheus-0-0 -c prometheus -- \
  sh -c 'rm -rf /prometheus/wal/*'
kubectl -n cpaas-system delete pod prometheus-kube-prometheus-0-0
```

## Diagnostic Steps

Tail the prometheus container log for the WAL replay markers to confirm replay is the active phase and observe how far it has progressed before any restart. The `head.go` emitter is the vanilla upstream Prometheus `v3.11.3` source, so the log lines match the standard form:

```bash
kubectl -n cpaas-system logs prometheus-kube-prometheus-0-0 -c prometheus \
  --tail=200 | grep -E 'head.go|tsdb|Replaying WAL|WAL segment loaded|TSDB started'
```

Confirm whether the container is being restarted by the startup probe by checking the pod restart count and container state. A non-zero restart count combined with the absence of a WAL replay completion log line indicates replay is exceeding the startup probe budget:

```bash
kubectl -n cpaas-system get pod prometheus-kube-prometheus-0-0 \
  -o jsonpath='{.status.containerStatuses[?(@.name=="prometheus")].restartCount}{"\n"}'
kubectl -n cpaas-system describe pod prometheus-kube-prometheus-0-0
```

Inspect the prometheus container's QoS class and resource block to determine whether the container is currently Guaranteed or Burstable, and whether OOMKills with `exitCode: 137` are correlated with replay or steady-state operation:

```bash
kubectl -n cpaas-system get pod prometheus-kube-prometheus-0-0 \
  -o jsonpath='{.status.qosClass}{"\n"}'
kubectl -n cpaas-system get pod prometheus-kube-prometheus-0-0 \
  -o jsonpath='{.spec.containers[?(@.name=="prometheus")].resources}{"\n"}'
```

Inspect the on-disk WAL segment count to gauge replay cost. The prometheus container is a busybox-style distroless image that ships `/bin/sh`, `ls`, and `rm` but not `du`, `wc`, `head`, or `df`, so segment counting must use a shell pipeline that avoids those missing binaries:

```bash
kubectl -n cpaas-system exec prometheus-kube-prometheus-0-0 -c prometheus \
  -- ls /prometheus/wal/ | wc -l
kubectl -n cpaas-system exec prometheus-kube-prometheus-0-0 -c prometheus \
  -- ls /prometheus/wal/
```

Identify the top high-cardinality label and metric names that drive segment growth using `promtool tsdb analyze`. `promtool` `v3.11.3` is co-located in the same upstream Prometheus binary distribution and ships inside the container image, callable via `kubectl exec` against the `prometheus` container:

```bash
kubectl -n cpaas-system exec prometheus-kube-prometheus-0-0 -c prometheus -- \
  promtool tsdb analyze /prometheus --limit=10
```

Determine whether the pod is I/O-bound during WAL replay by inspecting the underlying node's `vmstat` output. High `wa` (CPU IO-wait %) combined with low `id` (CPU idle %) indicates the system is waiting on disk; `bi` (block-input KB/s) below the expected device throughput indicates slow reads from the backing volume. On ACP, the node-level `vmstat` view is taken with `kubectl debug node/<node>` using the `container-debug` image and `chroot /host` so `vmstat` reads the node's `/proc` rather than the debug pod's `/proc`:

```bash
kubectl get pod prometheus-kube-prometheus-0-0 -n cpaas-system \
  -o jsonpath='{.spec.nodeName}{"\n"}'
kubectl debug node/<node> -it \
  --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- chroot /host vmstat -t 5 10
```

Cross-reference the `ServiceMonitor` / `PodMonitor` inventory with the cardinality findings to pick which scrape targets to scale back. The `prometheus-operator` in `cpaas-system` reconciles every change to these objects into the rendered Prometheus configuration Secret:

```bash
kubectl -n cpaas-system get servicemonitor,podmonitor -o wide
```
