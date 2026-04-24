---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

An operator attempts to collect a Prometheus TSDB snapshot (for a postmortem, an escalation, or a migration) and the collection does not complete. Typical shapes:

- `kubectl cp` of the TSDB directory times out partway through.
- `tar` inside the Prometheus pod exits with `No space left on device`.
- TSDB status queries against `/api/v1/status/tsdb` time out.
- The resulting `.tar.gz` is truncated and cannot be unpacked on the receiving side.

In parallel, the Prometheus pod shows high I/O wait. If the partition climbs past 100% (for instance because a failed `tar` left behind partial output), the Prometheus container drops into `CrashLoopBackOff` and compaction stops advancing.

## Root Cause

Collecting a TSDB dump is not a pure read — it requires temporary disk headroom on the same partition that hosts `/prometheus`:

- `tar` streaming to a local path writes the archive there. If the archive is built on the Prometheus pod itself, it competes directly with the TSDB for the same filesystem.
- Prometheus snapshot endpoints (`/api/v1/admin/tsdb/snapshot`) hard-link block files into a `snapshots/` subdirectory under the TSDB. While the links themselves are cheap, any concurrent compaction or head-block checkpoint needs disk for a moment; a partition already past 85% provides no such room.
- When the kubelet detects `imagefs` under pressure (default hard threshold `15%` available), it transitions the hosting node to `DiskPressure`, deprioritizes new I/O, and marks the node unschedulable. Prometheus on that node keeps receiving scrapes but writes into a constrained window.

The diagnostic procedure itself therefore makes the underlying problem worse: the attempt to collect metrics to debug the outage consumes the remaining disk needed to serve those metrics, and the Prometheus pod eventually crashes with the partition full. A secondary failure mode — already-stuck kubelet image garbage collection — prevents the node from clearing space by recycling unused images (the typical `freed 0 bytes` / `image is in use by a container` signature), leaving the node trapped in pressure.

## Resolution

The path is: reclaim disk headroom first, then collect the dump. Do not attempt to collect while the partition is over 85% — the collection will either fail or push the partition past the point where Prometheus itself recovers.

### Reclaim headroom — short-lived

1. Remove any partial diagnostic artefacts left behind by previous attempts:

   ```bash
   ns=cpaas-monitoring
   pod=prometheus-k8s-0
   kubectl -n "$ns" exec "$pod" -c prometheus -- sh -c 'rm -f /tmp/prometheus-db.tar.gz /tmp/*.tar*'
   ```

2. Lower the Prometheus retention window. Retention roughly scales the TSDB footprint linearly — halving the window reclaims close to half the persisted volume after the next compaction cycle. The in-cluster monitoring stack takes its retention from the monitoring `ConfigMap`:

   ```bash
   kubectl -n "$ns" edit configmap cluster-monitoring-config
   ```

   ```yaml
   data:
     config.yaml: |
       prometheusK8s:
         retention: 7d   # from 15d; choose a value that leaves ≥20% free
   ```

   The Prometheus operator reloads the StatefulSet; compaction then removes the older blocks during its next cycle. Watch `df -h /prometheus` on the pod — once free space is above 20%, you can safely snapshot.

3. If the pod host node is already in `DiskPressure` and the image GC is failing with the `freed 0 bytes` / `image is in use` signature, the node is deadlocked on shared `imagefs` and cannot reclaim space via image recycling. In that case, shrinking Prometheus data (step 2) is the only effective lever short of adding disk to the node.

### Collect the snapshot safely

With ≥20% free on `/prometheus`:

1. Take a Prometheus-native snapshot. It hard-links blocks and avoids copying data twice:

   ```bash
   kubectl -n "$ns" exec "$pod" -c prometheus -- \
     wget --method=POST -qO- http://localhost:9090/api/v1/admin/tsdb/snapshot
   ```

   The response is a JSON like `{"status":"success","data":{"name":"20260325T093012Z-xxxx"}}`. The snapshot sits under `/prometheus/snapshots/<name>/`.

2. Copy the snapshot off the pod to a location that is *not* on the Prometheus partition. A laptop, a bastion host, or any other node's scratch space is fine — just not the pod itself:

   ```bash
   kubectl -n "$ns" cp "$pod:/prometheus/snapshots/<name>" ./tsdb-dump -c prometheus
   ```

3. Clean the snapshot on the pod once you have a confirmed-good copy:

   ```bash
   kubectl -n "$ns" exec "$pod" -c prometheus -- rm -rf /prometheus/snapshots/<name>
   ```

### Durable — right-size the storage

If this pattern happens repeatedly, the fix is structural:

- size the volume mounted at `/prometheus` so normal retention plus a 20–30% operational headroom fits comfortably,
- move Prometheus onto a dedicated PV backed by a separate physical disk so it does not compete with `imagefs` / `nodefs` on the node,
- set alert rules on both `prometheus_tsdb_storage_blocks_bytes` (TSDB growth) and `kubelet_volume_stats_available_bytes` (free space on the Prometheus PV) so the next disk crisis is visible before the pod crashes.

The ACP observability/monitor area carries the supported patterns for each of these, including the volume claim template used for the in-cluster Prometheus.

## Diagnostic Steps

1. Measure current disk usage on the Prometheus partition:

   ```bash
   kubectl -n cpaas-monitoring exec prometheus-k8s-0 -c prometheus -- df -h /prometheus
   ```

   Safe collection requires ≤80% used. 85–95% is the danger zone; above 95% the pod is one request away from a crash.

2. Check the node for pressure signals:

   ```bash
   kubectl get pod prometheus-k8s-0 -n cpaas-monitoring -o wide
   kubectl describe node <node> | grep -E 'DiskPressure|Allocatable|Capacity' -A 3
   ```

3. Confirm the on-disk TSDB structure is still healthy — a missing `meta.json` on any block is a separate corruption story:

   ```bash
   kubectl -n cpaas-monitoring exec prometheus-k8s-0 -c prometheus -- \
     sh -c 'ls /prometheus/*/meta.json 2>/dev/null | wc -l; \
            ls /prometheus/wal 2>/dev/null | head'
   ```

4. If the node is in `DiskPressure`, determine whether kubelet image GC is the deadlock variant:

   ```bash
   kubectl debug node/<node> -it --image=registry.alauda.cn:60070/tkestack/pause:3.10 \
     -- chroot /host journalctl -u kubelet \
     | grep -E 'Image garbage collection failed|wanted to free'
   ```

   If yes, reclamation via image GC is blocked and disk can only be freed by shrinking application data — retention reduction is the available tool.

Once the partition is safely under 80% utilization, the snapshot endpoint completes in seconds and the dump copies out cleanly.
