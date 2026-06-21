---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Prometheus TSDB dump fails to collect under DiskPressure (>85% utilisation)
## Issue

Attempting to capture a Prometheus TSDB dump for support / RCA fails. Symptoms during collection:

- The dump request times out, or `tar` fails with `No space left on device`.
- The resulting `prometheus-db.tar.gz` is incomplete or unreadable.
- The Prometheus pod itself reports high I/O wait and may transition to `CrashLoopBackOff` if the underlying disk reaches 100%.
- The hosting node has the kubelet-set `DiskPressure` taint, and pods are being evicted from it.

## Root Cause

Prometheus' TSDB needs working disk headroom to perform the metadata operations involved in a snapshot — index re-build, block compaction, and `tar` of the working directory all consume ephemeral space. When the partition that holds `/prometheus` (or, more commonly, the node ephemeral filesystem the pod runs on) crosses 85–90% utilisation:

- The kubelet sets the `node.kubernetes.io/disk-pressure` taint, which deprioritises and may evict heavy-I/O workloads — including the very pod from which you are trying to read.
- Copying historical TSDB blocks into `/tmp` for tarring can push the partition the rest of the way to 100%, leaving the runtime unable to return the data and Prometheus itself unable to write incoming samples — the operational deadlock symptom.
- The kubelet's image garbage collector may also be losing the race against the workload to free space, particularly on high-density nodes.

Three forces compete for the same finite headroom: the live TSDB, the diagnostic copy, and the kubelet's reclaim path. Until headroom is restored, none of them can complete.

## Resolution

Two tracks: free space first so the existing TSDB has room to operate, then either reduce retention or expand the underlying volume so the issue does not recur.

### 1. Free space — remove failed-dump leftovers

Earlier attempts may have left a partial archive in `/tmp` on the Prometheus pod or on the host. Remove it before retrying:

```bash
MON_NS=<monitoring-namespace>
kubectl -n "$MON_NS" exec prometheus-k8s-0 -c prometheus -- \
  rm -f /tmp/prometheus-db.tar.gz
```

If the host's ephemeral filesystem is the bottleneck, free node-side scratch as well:

```bash
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
  -- bash -c '
    df -h /var/lib/containers /var/log /tmp
    journalctl --vacuum-size=200M
    rm -rf /var/log/journal/*/system@*.journal~  || true
  '
```

### 2. Reduce Prometheus retention

A retention drop scales the on-disk TSDB footprint roughly linearly — halving retention eventually halves disk use after old blocks are pruned. Edit the monitoring config:

```bash
kubectl -n "$MON_NS" edit configmap cluster-monitoring-config
```

```yaml
data:
  config.yaml: |
    prometheusK8s:
      retention: 7d                  # was 15d — drop until headroom recovers
```

Prometheus rolls and starts pruning blocks older than the new horizon. The on-disk drop is gradual (one block compaction window at a time), but disk I/O immediately decreases because compaction touches a smaller working set.

### 3. Collect the dump immediately after headroom is reclaimed

After the partition returns below ~80% utilisation, take the dump promptly — once block rotation runs against the new retention, the data the support case wants may be gone. The standard collection path is the platform's documented Prometheus-dump procedure; any mechanism that produces a `prometheus-db.tar.gz` from `/prometheus` works:

```bash
kubectl -n "$MON_NS" exec prometheus-k8s-0 -c prometheus -- \
  tar -C /prometheus -czf /tmp/prometheus-db.tar.gz .
kubectl -n "$MON_NS" cp prometheus-k8s-0:/tmp/prometheus-db.tar.gz \
  ./prometheus-db.tar.gz -c prometheus
```

### 4. Long-term — expand the partition

If the cluster repeatedly hits this state, the underlying ephemeral filesystem (or the PVC backing `/prometheus`) is undersized. Expand the volume so the TSDB and image cache have headroom:

- For a PVC-backed Prometheus, expand the StatefulSet's `volumeClaimTemplates` (requires StorageClass with `allowVolumeExpansion: true`) and let the resize take effect on rollout.
- For ephemeral node storage, grow the node's root partition (cloud-side disk resize → host-level `growpart` + `xfs_growfs` / `resize2fs`).

## Diagnostic Steps

1. Confirm the Prometheus pod's view of its own disk:

   ```bash
   kubectl -n "$MON_NS" exec prometheus-k8s-0 -c prometheus -- df -h /prometheus
   ```

   `Use% > 85` is the boundary at which the kubelet flips DiskPressure on the host node.

2. Locate the node and confirm the taint:

   ```bash
   kubectl get pod prometheus-k8s-0 -n "$MON_NS" -o wide
   kubectl describe node <node> | grep -E 'DiskPressure|Allocatable|Capacity' -A 5
   ```

3. Verify the TSDB's on-disk integrity — a missing `meta.json` for any block makes the entire database unreadable, even after the dump succeeds:

   ```bash
   kubectl -n "$MON_NS" exec prometheus-k8s-0 -c prometheus -- \
     bash -c 'cd /prometheus && for d in */; do
                test -f "$d/meta.json" || echo "MISSING $d"; done'
   ```

4. Check the kubelet's image-GC log on the host to confirm it is not stuck:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- journalctl -u kubelet --since "30 minutes ago" \
        | grep -E 'Image garbage collection|wanted to free'
   ```

   `Image garbage collection failed` paired with `wanted to free X bytes` indicates the kubelet cannot reclaim — that is the operational-deadlock signature.
