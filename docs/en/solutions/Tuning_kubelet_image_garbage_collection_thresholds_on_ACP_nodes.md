---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500579
---

# Tuning kubelet image garbage collection thresholds on ACP nodes

## Issue

On Alauda Container Platform nodes the kubelet reclaims disk by deleting unused container images, and the aggressiveness of that reclaim is governed by two threshold fields: `imageGCHighThresholdPercent` and `imageGCLowThresholdPercent`. Image garbage collection runs when node disk usage crosses the high threshold, then frees images until usage falls back to the low threshold. When the high threshold is set low, the kubelet reclaims unused images more often, which can lead to images being deleted and pulled again on subsequent workload scheduling. On a stock cluster running Server v1.34.5 (vanilla upstream kubelet), these fields carry the upstream defaults `imageGCHighThresholdPercent: 85` and `imageGCLowThresholdPercent: 80`, applied uniformly on every node by the installer; the companion age-based controls default to `imageMinimumGCAge: 2m0s` and `imageMaximumGCAge: 0s` (age-based GC disabled), so reclaim is driven purely by the disk-usage thresholds.

## Root Cause

Image garbage collection on a node is triggered when disk usage crosses the configured `imageGCHighThresholdPercent`. Because `imageMaximumGCAge` defaults to `0s` (disabled), the only trigger is disk-usage pressure: once usage exceeds the high threshold the kubelet deletes unused images until usage drops to the low threshold, and otherwise leaves the image cache untouched. A high threshold that is too low therefore makes the kubelet cross the trigger point more readily and reclaim images that workloads may still need shortly afterward.

## Resolution

Raising `imageGCHighThresholdPercent` (for example, from a lower value up to `75`) widens the headroom before image garbage collection runs, so the kubelet triggers reclaim less often. On ACP nodes the kubelet reads its effective configuration from the node-local file `/var/lib/kubelet/config.yaml`; adjust the thresholds there and restart the kubelet so the new values take effect. Edit the file on the target node to set the desired values:

```yaml
# /var/lib/kubelet/config.yaml (excerpt)
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80
```

After editing, restart the kubelet on that node so it reloads the configuration:

```bash
systemctl restart kubelet
```

Keep `imageGCHighThresholdPercent` strictly greater than `imageGCLowThresholdPercent`; the high value is the disk-usage point that triggers reclaim and the low value is the target the kubelet frees down to. Apply the same edit on every node whose image-GC behavior should change, since the thresholds are node-local kubelet settings rather than a cluster-wide object.

## Diagnostic Steps

Read the currently effective thresholds on a node directly from the kubelet's `configz` endpoint, which returns the live merged kubelet configuration as JSON:

```bash
kubectl get --raw /api/v1/nodes/<node>/proxy/configz | grep imageGC
```

The output prints the two threshold lines exactly as the kubelet has merged them; on a default ACP node this reads `85` / `80`:

```text
"imageGCHighThresholdPercent": 85,
"imageGCLowThresholdPercent": 80,
```

Because the thresholds are baked uniformly by the installer, every node reports the same `imageGCHighThresholdPercent=85` / `imageGCLowThresholdPercent=80` baseline until a node-local edit changes it; query a control-plane node and a worker node and compare the two lines to confirm whether any node has drifted from the default.
