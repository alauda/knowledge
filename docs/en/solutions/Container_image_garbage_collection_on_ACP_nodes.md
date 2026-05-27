---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Container image garbage collection on ACP nodes

## Issue

On Alauda Container Platform nodes running upstream Kubernetes kubelet `v1.34.5` (4-node Ubuntu 22.04.1 LTS, containerd 2.2.1-5), unused container images can accumulate on a node and disk usage on the image filesystem keeps climbing because the kubelet's image garbage collector does not delete unused images immediately. The same kubelet binary owns both the image garbage collector and the disk-pressure eviction path — the node's live merged configuration exposes the eviction thresholds and `evictionPressureTransitionPeriod` alongside the image-GC tunables, so the symptom (steady image-disk growth, eventual `DiskPressure`) and the GC policy share a single owner.

## Root Cause

The kubelet's image garbage collector keys off the merged `KubeletConfiguration` and only considers an unused image for deletion once it has reached a minimum age. The `imageMinimumGCAge` field defines that minimum age threshold: an unused image younger than `imageMinimumGCAge` is not eligible for image garbage collection, regardless of how the GC was triggered.

The disk-usage trigger for image GC is bounded by `imageGCHighThresholdPercent` (the image-filesystem usage percent at which the kubelet starts reclaiming) and `imageGCLowThresholdPercent` (the percent it reclaims down to). On the observed cluster these fields carry the upstream defaults — `imageMinimumGCAge: 2m0s`, `imageGCHighThresholdPercent: 85`, `imageGCLowThresholdPercent: 80`, `imageMaximumGCAge: 0s` — and the values are uniform across all worker nodes and the control-plane node.

When disk pressure occurs while the unused images on the node are still younger than `imageMinimumGCAge`, the kubelet does not collect those images. The minimum-age guard is honored independently of the disk-pressure signal, so on a default-configured node the image filesystem can continue to grow until enough images cross the age threshold or the operator changes the kubelet policy on the node.

## Resolution

Tuning kubelet image-GC fields on Alauda Container Platform is a node-level kubelet configuration change. On a typical upstream node, the kubelet reads its on-disk configuration file at `/var/lib/kubelet/config.yaml` and is restarted with `systemctl restart kubelet` so new values take effect; confirm the actual delivery path for this cluster against the node-level operations runbook before editing. The document on disk follows the standard upstream `KubeletConfiguration` struct, and the image-GC fields sit at the top level — set new values for `imageMinimumGCAge`, `imageGCHighThresholdPercent`, `imageGCLowThresholdPercent`, or `imageMaximumGCAge` there, then confirm them through the `configz` diagnostic below before declaring the change effective.

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
imageMinimumGCAge: 1m0s
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80
imageMaximumGCAge: 0s
```

Lowering `imageMinimumGCAge` (for example to `1m0s` or `30s`) shortens the protection window for unused images and makes the kubelet reclaim them sooner once disk usage crosses `imageGCHighThresholdPercent`; raising it widens the window and delays reclaim. Lowering `imageGCHighThresholdPercent` causes the kubelet to start image reclaim at a lower disk-usage level, and lowering `imageGCLowThresholdPercent` makes each reclaim cycle free more disk before stopping.

## Diagnostic Steps

Read the live merged kubelet configuration on a target node via the apiserver's node-proxy `configz` endpoint. The endpoint returns the effective merged JSON the kubelet is operating against and exposes the image-GC fields directly, so the values shown there are authoritative for the running kubelet on that node:

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | jq '.kubeletconfig | {imageMinimumGCAge, imageGCHighThresholdPercent, imageGCLowThresholdPercent, imageMaximumGCAge}'
```

On a default-configured node of this cluster the response carries `imageMinimumGCAge: "2m0s"`, `imageGCHighThresholdPercent: 85`, `imageGCLowThresholdPercent: 80`, and `imageMaximumGCAge: "0s"` — the inherited upstream defaults, and the same values appear on every worker node and on the control-plane node.

Cross-check the node-pressure side with the `Node` object itself; the kubelet that owns image GC also reports `DiskPressure` and `evictionHard` in the node-level conditions surface, which is the same kubelet binary the `configz` endpoint reflects:

```bash
kubectl describe node <node>
```
