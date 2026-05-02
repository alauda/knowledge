---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Tuning kubelet image garbage collection to avoid frequent image re-pulls
## Issue

The kubelet is removing container images that are still in active use on the node, which forces the runtime to re-pull them the next time a pod that references them is scheduled. The symptoms are:

- Frequent `Pulling image` events for images that have been pulled within the last few hours.
- A noticeable spike in registry-egress network traffic, sometimes large enough to saturate the cluster's pull-through cache or trip rate-limit defenses on an external registry.
- The node's `/var/lib/containers/storage/` (or `/var/lib/containerd/`) usage hovers near a tight ceiling and oscillates as the kubelet's image GC kicks in repeatedly.

## Root Cause

The kubelet has two thresholds that drive image garbage collection: `imageGCHighThresholdPercent` and `imageGCLowThresholdPercent`. They define the percentage of the imagefs that the kubelet considers "full enough to act" and "low enough to stop", respectively. When the high threshold is set too low for the workload's image churn — typical defaults are 85 / 80 — the kubelet enters and exits a GC cycle frequently, evicting images that were perfectly hot.

Two situations make the default values especially mismatched:

- The node has a relatively small dedicated image partition, so even a moderate working set crosses 85% quickly.
- The workload references a large catalog of images (multi-tenant clusters, build farms, AI model containers), so the **set of images that should stay** is far larger than what fits comfortably under the high mark.

In either case, the answer is to raise the high threshold (and lower the low threshold proportionally) so that the kubelet only collects when the disk is genuinely under pressure.

## Resolution

The two thresholds live on each kubelet's running configuration. There are three places they can be set; pick the one the cluster's node lifecycle is built around.

### Per-node kubelet configuration file

On a self-managed node where the kubelet reads its configuration from a file (typically `/var/lib/kubelet/config.yaml` or `/etc/kubernetes/kubelet-config.yaml`), edit the file and restart the kubelet:

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
imageGCHighThresholdPercent: 90
imageGCLowThresholdPercent: 75
# ...other fields unchanged
```

Apply with:

```bash
systemctl restart kubelet
```

Repeat on every node whose imagefs sees the same pressure. Drain the node first if production traffic is on it.

### Cluster-managed kubelet configuration

On a cluster whose nodes are managed declaratively (the cluster operator owns `/var/lib/kubelet/config.yaml`), the same fields are exposed through the platform's node-configuration custom resource. The shape varies, but the keys are the same:

```yaml
# Example: a node-config CR scoped to a node pool
spec:
  kubeletConfiguration:
    imageGCHighThresholdPercent: 90
    imageGCLowThresholdPercent: 75
```

Applying the CR triggers the operator to re-render `/var/lib/kubelet/config.yaml` on each affected node and roll the kubelet — this is a node-by-node restart, so plan a maintenance window if the rollout would otherwise contend with workload SLAs.

### Verifying the live values

After restarting the kubelet, confirm the running config picked up the new thresholds. From any node, the kubelet's read-only port (or the platform's node-debug shell) exposes the merged configuration:

```bash
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> -- \
  curl -s http://localhost:10248/configz | jq '.kubeletconfig | { high: .imageGCHighThresholdPercent, low: .imageGCLowThresholdPercent }'
```

If the read-only port is closed, read the file directly:

```bash
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> -- \
  grep -E 'imageGC(High|Low)ThresholdPercent' /var/lib/kubelet/config.yaml
```

### Choosing values

There is no universal correct pair. A starting heuristic:

| Disk pressure profile | high | low |
|---|---|---|
| Plenty of imagefs headroom | 90 | 75 |
| Tight imagefs, large image catalog | 85 | 70 |
| Very tight imagefs, must keep images | 95 | 85 |

Then watch over a week:

- If the kubelet runs GC more than once per hour, raise both thresholds.
- If `imagefs` ever crosses 95% without GC running, lower both thresholds.

## Diagnostic Steps

1. Confirm the node is the bottleneck and not the registry. From a control-plane host:

   ```bash
   kubectl get events -A --field-selector reason=Pulling \
     -o jsonpath='{range .items[*]}{.lastTimestamp}{"  "}{.involvedObject.namespace}/{.involvedObject.name}{"  "}{.message}{"\n"}{end}' \
     | sort | tail -50
   ```

   Repeated pulls for the same `<namespace>/<pod>` — especially within the kubelet's GC interval — indicate the node, not the workload.

2. Capture the kubelet's GC log lines on the affected node. The kubelet logs every eviction at `info`:

   ```bash
   journalctl -u kubelet --since "1 hour ago" | grep -E 'image_gc|imageGC|Removing image'
   ```

3. Check the imagefs occupancy at the moment GC fires. The `imageFs` stats are reported through the kubelet's stats endpoint:

   ```bash
   kubectl get --raw /api/v1/nodes/<node>/proxy/stats/summary \
     | jq '.node.fs, .node.runtime.imageFs'
   ```

4. If the eviction list looks correct (large rarely-used images going first) but pulls still feel excessive, inspect the workload — a Deployment whose pods restart every few minutes will keep refetching its image regardless of the GC settings.
