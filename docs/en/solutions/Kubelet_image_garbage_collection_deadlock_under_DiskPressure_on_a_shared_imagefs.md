---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500290
---

# Kubelet image garbage collection deadlock under DiskPressure on a shared imagefs

## Issue

On Alauda Container Platform, a node can become stuck reporting `DiskPressure` while the kubelet repeatedly logs `Image garbage collection failed`. The kubelet enforces a hard eviction threshold on the `imagefs.available` signal, expressed as a fraction such as `0.15` (15%). When `imagefs.available` drops below that hard eviction threshold, the node's `DiskPressure` condition flips to `True` (`reason=KubeletHasDiskPressure`). The failing garbage-collection pass carries a distinctive signature: it is logged as `Image garbage collection failed` together with `wanted to free 9223372036854775807 bytes, but freed 0 bytes`, where `9223372036854775807` is the `MaxInt64` sentinel the kubelet (v1.34.5, the vanilla upstream kubelet) uses to request freeing as much space as possible.

## Root Cause

Crossing the image-GC high threshold (`imageGCHighThresholdPercent`, default 85) makes the kubelet attempt to reclaim disk space by deleting images down toward the low threshold (`imageGCLowThresholdPercent`, default 80), but it deletes only images that are not currently referenced by any container. When the kubelet issues a CRI `RemoveImage` call for an image that is still referenced by a container, the container runtime rejects it with an `image is in use by a container` error and the image is not reclaimed. When every image on the node is referenced by a running container, the image garbage collector has nothing evictable and reclaims zero bytes — which is why a pass requesting the `MaxInt64` target reports `freed 0 bytes` on kubelet v1.34.5. Because the collector cannot free any space while images remain in use, the node stays trapped in the `DiskPressure` condition and the kubelet keeps re-failing image GC, forming a deadlock that the condition never clears on its own.

A common precondition is filesystem layout. When `/var/lib/containers` (the imagefs) shares the same underlying device as application data, application-data growth consumes the shared filesystem and pushes `imagefs.available` below the eviction threshold. Once shared-device usage holds above roughly 85%, the node is mathematically unable to satisfy the 15% `imagefs.available` free-space requirement and remains under `DiskPressure` even though image GC itself is behaving correctly.

## Resolution

Because image GC can only reclaim unused images and every image on the node is in use, deleting images will not clear the condition; the actionable lever is freeing space on the shared filesystem so that `imagefs.available` rises back above the 15% hard eviction threshold. On a shared device where imagefs and application data live together, the dominant consumer is usually non-image data rather than the image set, so the resolution is to identify and reduce whatever is consuming the shared filesystem.

A representative high-volume consumer on Alauda Container Platform is the monitoring stack's Prometheus time-series database, which on ACP runs as the StatefulSet replica `prometheus-kube-prometheus-0-0` in the `cpaas-system` namespace. Where that stack shares the node filesystem, reducing its on-disk footprint (for example, lowering retention through the monitoring stack's configuration) frees shared-device space; once usage drops back below ~85% and `imagefs.available` recovers past 15%, the `DiskPressure` condition can clear.

## Diagnostic Steps

Read the per-node `DiskPressure` condition directly from `node.status.conditions` using a custom-column selector; a node returning `True` is under disk pressure:

```bash
kubectl get nodes -o custom-columns=\
NODE:.metadata.name,\
DISK_PRESSURE:".status.conditions[?(@.type=='DiskPressure')].status"
```

Confirm the failing garbage-collection signature in the kubelet's logs on the affected node; the deadlock is identifiable by the `Image garbage collection failed` log line carrying the `MaxInt64` byte target paired with a zero-byte result:

```text
Image garbage collection failed ... wanted to free 9223372036854775807 bytes, but freed 0 bytes
```

Verify that every image is in use by checking that `RemoveImage` is rejected with the in-use error, which confirms the collector has nothing evictable rather than a runtime fault. Finally, confirm the filesystem layout: when imagefs and application data share one device, inspect total shared-device usage and treat usage held above ~85% as the condition that makes the 15% `imagefs.available` requirement unsatisfiable.
