---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500347
---

# Collecting a Prometheus TSDB dump fails under node DiskPressure on ACP

## Issue

On Alauda Container Platform, collecting a Prometheus TSDB dump becomes difficult when the node hosting the monitoring stack is near full and the kubelet has placed it into a DiskPressure condition. By default the kubelet flags DiskPressure once `imagefs.available` drops below 15% (imagefs above roughly 85% used) or `nodefs.available` drops below 10%; on ACP nodes those eviction thresholds are configured at exactly those values. The TSDB itself lives on a dedicated volume rather than the node's general-purpose filesystem: the engine runs with `--storage.tsdb.path=/prometheus`, the standard Prometheus block layout under `/prometheus`, and that path is the mount `prometheus-kube-prometheus-0-db` backed by a dedicated PVC. Because the dump has to be staged and read off a node or volume that is at or near its threshold, the operation can be throttled or fail for lack of headroom — the visible symptom of the verified near-full DiskPressure condition, not of any change to how Prometheus writes its blocks. The platform monitoring stack runs a single unified Prometheus as the StatefulSet pod `prometheus-kube-prometheus-0-0` in the `cpaas-system` namespace, backed by the Prometheus CR `kube-prometheus-0`, with its TSDB on the dedicated 30Gi RWO `topolvm-hdd` PVC at `/prometheus` rather than the node ephemeral filesystem.

## Root Cause

The TSDB engine is upstream Prometheus 3.x shipped on ACP as image `prometheus:v3.11.3-v4.3.4`, with the standard block layout under `/prometheus`: each block directory carries a `meta.json`, an `index`, and a `chunks/` directory alongside the head WAL. A TSDB block whose `meta.json` file is missing becomes unreadable — this is generic, version-independent Prometheus behavior. The stored footprint scales with the time-based retention window: the container runs with `--storage.tsdb.retention.time=7d`, and because retention is time-based, halving the retention window proportionally reduces the time span of stored blocks and therefore the disk utilization. Independently, the kubelet's image garbage-collection machinery is present on ACP nodes with `imageGCHighThresholdPercent=85` and `imageGCLowThresholdPercent=80`; when image GC cannot make progress, the node fails to reclaim space through that path, leaving less headroom for the workloads on the node.

## Resolution

Free space on the node and, where the Prometheus footprint is the dominant consumer, reduce the retention window so the TSDB shrinks proportionally. On ACP the Prometheus retention period is set through the prometheus plugin: the `ClusterPluginInstance/prometheus` exposes `spec.config.components.prometheus.retention` as an integer number of days (default 7), which is rendered into the Prometheus CR `spec.retention` and surfaces as the `--storage.tsdb.retention.time=7d` argument on the running container.

Set a shorter retention window on the plugin instance (the example lowers it from 7 to 3 days, roughly halving the time span of stored blocks):

```bash
kubectl patch clusterplugininstance prometheus \
  --type merge \
  -p '{"spec":{"config":{"components":{"prometheus":{"retention":3}}}}}'
```

After the new retention takes effect, the Prometheus CR `kube-prometheus-0` in `cpaas-system` carries the updated `spec.retention`, which the running container reflects as a shorter `--storage.tsdb.retention.time` value.

If the node is short of space because image garbage collection has stalled, the same `imageGCHighThresholdPercent=85` / `imageGCLowThresholdPercent=80` reclaim machinery is what should be freeing image storage; clearing the underlying disk consumer so image GC can resume reclamation restores headroom on the node.

## Diagnostic Steps

Identify and size the Prometheus database volume without exec'ing into the container — the ACP `prometheus` container is distroless and ships no `df`/`cat`/`ls` binary, so an in-container `df` does not run. Resolve the mount and its backing PVC from the pod spec, then read the PVC's requested and bound capacity directly from the API:

```bash
kubectl get pod -n cpaas-system prometheus-kube-prometheus-0-0 \
  -o jsonpath='{range .spec.containers[?(@.name=="prometheus")].volumeMounts[*]}{.name}{" -> "}{.mountPath}{"\n"}{end}'
kubectl get pvc -n cpaas-system prometheus-kube-prometheus-0-db-prometheus-kube-prometheus-0-0
kubectl describe pvc -n cpaas-system prometheus-kube-prometheus-0-db-prometheus-kube-prometheus-0-0
```

Check whether the node is under DiskPressure; `kubectl describe node` surfaces the DiskPressure condition (reporting `KubeletHasNoDiskPressure` when clear) along with the node's Allocatable and Capacity, including ephemeral-storage capacity, and the same condition is readable without a full describe via jsonpath:

```bash
kubectl describe node <node-name>
kubectl get node <node-name> \
  -o jsonpath='{range .status.conditions[?(@.type=="DiskPressure")]}{.type}{"="}{.status}{" ("}{.reason}{")\n"}{end}'
```

Inspect the kubelet log for image-GC failures; log lines such as `Image garbage collection failed` and `wanted to free` indicate the node is in a failed reclamation loop, the same `ImageGCFailed` surface produced by the upstream kubelet (v1.34.5). The eviction-signal and image-GC reclaim machinery behind that surface is the standard kubelet image-GC loop bounded by the `imageGCHighThresholdPercent=85` / `imageGCLowThresholdPercent=80` thresholds.
