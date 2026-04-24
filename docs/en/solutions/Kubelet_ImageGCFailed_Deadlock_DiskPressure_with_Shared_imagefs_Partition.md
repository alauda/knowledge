---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Worker nodes report `DiskPressure: True`, become unschedulable, and frequently stop responding to API calls. The kubelet log shows the image garbage collector running, freeing nothing, and the node never leaves the pressure state:

```text
Image garbage collection failed: wanted to free 9223372036854775807 bytes,
but freed 0 bytes space with errors in image deletion: [image is in use by a container]
```

`NodeHasDiskPressure` events are recorded continuously. Because the node is in pressure, kubelet refuses to admit new pods and starts evicting existing ones, but image GC cannot reclaim the space that triggered the pressure in the first place.

## Root Cause

Kubelet's hard eviction threshold for `imagefs.available` (commonly `15%` — i.e. `0.15`) fires when the partition holding container images has less than 15% free. When this threshold is breached, kubelet attempts the standard recovery: garbage-collect unused images. The recovery only works if the node actually has unused images.

On nodes where `imagefs` and `nodefs` share the same physical partition with high-cardinality data — most often Prometheus TSDB blocks, but also large `/var/log/pods` aggregates or LVM-backed stateful volumes — most of the disk usage is *not* image data. The handful of images that exist are pinned in use by the running infrastructure pods (Prometheus itself, log collector, monitoring sidecars, the CNI agent), so kubelet's image GC iterates the image cache, finds every entry referenced by an active container, and reclaims zero bytes.

Three observable consequences compound:

1. **Threshold violation** — long-running stateful workloads grow past the 85% mark, leaving less than 15% on the shared partition.
2. **GC deadlock** — kubelet attempts reclamation, finds only in-use images, returns "freed 0 bytes," repeats every GC interval.
3. **Recovery loop** — because the node never drops below the high-water mark, it stays in DiskPressure, which blocks workload mitigation actions like Prometheus snapshot dumps or retention edits via the API.

The `9223372036854775807` figure is `int64` MaxValue — kubelet asks the image GC to free as much as it can; the GC reports it freed nothing.

## Resolution

### Immediate — drop disk usage below the eviction threshold

The fastest lever is to shrink the application that is consuming the partition. In the most common variant, that application is the in-cluster Prometheus.

1. Inspect actual disk usage so you know how much you need to free:

   ```bash
   kubectl -n cpaas-monitoring exec prometheus-k8s-0 -c prometheus -- df -h /prometheus
   ```

2. Lower the Prometheus retention. The TSDB footprint scales roughly linearly with the retention window — halving the window reclaims close to half the data. The retention is set on the Prometheus operand. For the in-cluster monitoring stack the canonical knob is the monitoring `ConfigMap`:

   ```bash
   kubectl -n cpaas-monitoring edit configmap cluster-monitoring-config
   ```

   ```yaml
   data:
     config.yaml: |
       prometheusK8s:
         retention: 7d   # was 15d
   ```

   The Prometheus operator picks the change up and the next compaction cycle drops the older blocks. Watch the partition free space climb back above the 15% threshold; once it does, kubelet clears the DiskPressure condition on the next sync.

3. If you need diagnostic data from before the truncation, take a TSDB snapshot *before* changing retention. Once retention has been reduced and compaction has run, the older blocks are gone for good.

### Durable — separate imagefs from application data

The structural fix is to keep image storage off the partition that hosts large stateful workloads:

- size the node root partition so that `/var/lib/containers` (image cache) and `/var/lib/kubelet` (ephemeral and emptyDir) sit on a partition with realistic headroom for the cluster's image churn,
- or move stateful workloads with non-trivial local footprint (Prometheus, log forwarder buffers, ephemeral compaction temp space) onto dedicated PVs backed by a separate disk so they never compete with `imagefs`.

The operator that manages node OS layout in ACP exposes both knobs. For nodes provisioned through Immutable Infrastructure, adjust the partition layout in the node-config CR; for nodes managed via standard kubelet config (`configure/clusters/nodes`), set `imageGCHighThresholdPercent` / `imageGCLowThresholdPercent` only after right-sizing the partition — lowering the GC threshold without freeing competing data only delays the same deadlock.

### When to raise the eviction threshold (don't, usually)

Pushing `evictionHard.imagefs.available` lower than `15%` looks tempting but it removes the safety margin kubelet needs to reclaim space from a still-running container runtime. Raising the threshold (e.g., to `20%`) is safer if the node is large and you want pressure events to land earlier. Lowering it is rarely the right answer.

## Diagnostic Steps

1. Identify which nodes are under pressure:

   ```bash
   kubectl get nodes \
     -o custom-columns='NAME:.metadata.name,DISK_PRESSURE:.status.conditions[?(@.type=="DiskPressure")].status'
   ```

2. Confirm the configured eviction thresholds on a pressured node:

   ```bash
   kubectl debug node/<node> -it --image=registry.alauda.cn:60070/tkestack/pause:3.10 \
     -- chroot /host journalctl -u kubelet | grep -i HardEvictionThresholds
   ```

   The signature line includes `imagefs.available` with a `Percentage: 0.15` (or whatever override is in effect).

3. Confirm the GC is the deadlock variant ("freed 0 bytes" + "image is in use by a container"):

   ```bash
   kubectl debug node/<node> -it --image=registry.alauda.cn:60070/tkestack/pause:3.10 \
     -- chroot /host journalctl -u kubelet | grep -E 'Image garbage collection failed|wanted to free'
   ```

4. Map the offending partition. On a node with high-density monitoring, the `imagefs` mount and the Prometheus PV often sit on the same block device:

   ```bash
   kubectl debug node/<node> -it --image=registry.alauda.cn:60070/tkestack/pause:3.10 \
     -- chroot /host df -h /var/lib/containers /var/lib/kubelet /prometheus
   ```

5. Quantify the top consumers on the shared partition:

   ```bash
   kubectl debug node/<node> -it --image=registry.alauda.cn:60070/tkestack/pause:3.10 \
     -- chroot /host du -sh /var/lib/containers /var/log/pods /var/lib/prometheus 2>/dev/null \
     | sort -h
   ```

If the largest entry is application data (Prometheus TSDB, log spool, application emptyDir), shrinking application data is the path forward. If the largest entry is genuinely the image cache, the node simply needs a bigger image partition or a more aggressive `imageGCLowThresholdPercent`.
