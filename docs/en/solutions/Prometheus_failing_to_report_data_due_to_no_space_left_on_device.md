---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Prometheus failing to report data due to "no space left on device"
## Issue

The web console shows the shape of objects correctly but all metrics panels — CPU, memory, pod counts — read "no datapoints found". Dashboards that depend on Prometheus data appear empty. In the Prometheus pods the logs are full of write-ahead-log (WAL) write failures:

```text
level=error caller=scrape.go:1190 component="scrape manager"
scrape_pool=serviceMonitor/network/monitor-network/0
msg="Scrape commit failed"
err="write to WAL: log samples: write /prometheus/wal/00017534: no space left on device"
```

`kubectl top nodes` returns `error: metrics not available yet`, and alerts such as `KubeAPIDown`, `KubeControllerManagerDown`, `KubeletDown` and `KubeSchedulerDown` begin to fire even though the underlying components are healthy — the alerts are actually reporting that Prometheus cannot evaluate them rather than that the components are down.

## Root Cause

Prometheus writes samples to a WAL on its PVC before flushing them into on-disk blocks. If the volume runs out of space, Prometheus can neither persist new samples nor continue evaluating recording rules against the existing ones; it surfaces the failure as `no space left on device` on every scrape and stops serving most queries.

The volume fills for one of two reasons: the retention configuration is larger than the PVC can hold given the current cluster cardinality, or an unexpected spike in cardinality (label explosion from a new workload, a newly added `ServiceMonitor` with high-churn labels) has pushed the steady-state footprint above the provisioned size. The fix is to bring the two back into balance — either shrink the retention, or grow the volume.

## Resolution

There are two supported ways to fix this. Pick one based on whether the historical retention matters to your environment.

**Option 1 — Lower the Prometheus retention.** Less history on disk, smaller footprint. For a platform Prometheus managed through the observability configuration surface, edit the `prometheus-k8s` Prometheus resource to reduce `retention` (time-based) or `retentionSize` (byte-based):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: k8s
  namespace: cpaas-system
spec:
  retention: 7d
  retentionSize: 40GiB
```

The Prometheus Operator picks up the change and rolls the stateful set automatically. Apply the same change to the user-workload Prometheus if you run one — it is a separate `Prometheus` object, typically under `user-workload-monitoring`, with its own retention settings.

**Option 2 — Increase the PVC size.** If history matters, grow the PVC in place. This only works if the underlying `StorageClass` has `allowVolumeExpansion: true`:

```bash
kubectl -n cpaas-system get pvc
kubectl -n cpaas-system edit pvc prometheus-k8s-db-prometheus-k8s-0
# bump spec.resources.requests.storage to the new size; repeat for prometheus-k8s-db-prometheus-k8s-1
```

The CSI driver expands the volume and the kubelet rolls the filesystem online, after which Prometheus can write again. If the storage class does not allow expansion, provision a larger PVC template in the `Prometheus` CR (`spec.storage.volumeClaimTemplate.spec.resources.requests.storage`) and recycle the pods so they bind to the new volumes — you will lose the data currently on the old PVCs, so reduce retention temporarily if that matters.

Note that Alertmanager runs on a separate PVC with its own sizing; the configuration object for cluster-monitoring and the configuration object for user-workload monitoring are different objects in different namespaces. A fix targeting one does not affect the other.

## Diagnostic Steps

Confirm the problem is `no space left on device` on the Prometheus pod rather than some other scrape failure:

```bash
kubectl -n cpaas-system logs prometheus-k8s-0 -c prometheus | grep "no space left on device" | tail
kubectl -n cpaas-system logs prometheus-k8s-1 -c prometheus | grep "no space left on device" | tail
```

Check PVC utilisation directly from inside the pod. Prometheus mounts its data directory at `/prometheus`:

```bash
kubectl -n cpaas-system exec prometheus-k8s-0 -c prometheus -- df -h /prometheus
kubectl -n cpaas-system exec prometheus-k8s-1 -c prometheus -- df -h /prometheus
```

Verify the PVC definitions and whether the `StorageClass` allows in-place expansion — this decides which of the two resolutions is available:

```bash
kubectl -n cpaas-system get pvc -o wide
kubectl get storageclass -o custom-columns=NAME:.metadata.name,EXPAND:.allowVolumeExpansion
```

If retention and size look reasonable but the pod is still filling up, look for cardinality growth rather than volume sizing. Query Prometheus for the series count per job to spot the offender:

```text
topk(20, count by (job) ({__name__=~".+"}))
```

A sudden climb in the `count` for one job — typically after a new `ServiceMonitor` has landed or a workload has started emitting a high-cardinality label — is the usual cause of "the disk size that used to be fine suddenly isn't".
