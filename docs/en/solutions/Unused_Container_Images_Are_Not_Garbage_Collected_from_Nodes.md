---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Unused Container Images Are Not Garbage Collected from Nodes
## Issue

Unused container images accumulate on worker nodes even after the pods that referenced them are deleted. Disk usage on `/var/lib/containers` (or the equivalent CRI storage path) trends upward until the node eventually enters a `DiskPressure` condition and begins evicting pods.

## Root Cause

The kubelet performs image garbage collection on a timer, and only considers an image **eligible** once it has been unused for at least `imageMinimumGCAge` (default `2m`). It then deletes images in two tiers:

- When filesystem usage exceeds `imageGCHighThresholdPercent` (default `85%`), it starts removing images oldest-first.
- It stops once usage drops below `imageGCLowThresholdPercent` (default `80%`).

A newly-deleted pod therefore does not free its image from disk immediately. On bursty workloads that pull many distinct images in a short window, disk usage can climb faster than the GC cycle reclaims it — especially if `imageMinimumGCAge` is long, if the high threshold is set high, or if image pulls are large (AI/ML, build agents). The alarmed operator often observes "the kubelet is not removing images" when in reality the thresholds simply have not been crossed yet.

## Resolution

Tune kubelet image GC parameters on the node pool so that reclamation kicks in before disk pressure, not after.

1. **Measure before tuning.** Get the steady-state image footprint and pull rate on the affected nodes:

   ```bash
   kubectl get --raw /api/v1/nodes/<node>/proxy/configz \
     | jq '.kubeletconfig | {imageMinimumGCAge,
           imageGCHighThresholdPercent,
           imageGCLowThresholdPercent,
           imageMaximumGCAge}'
   ```

   Then check the partition hosting image storage:

   ```bash
   kubectl debug node/<node> -it --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host df -h /var/lib/containers
   ```

2. **Lower the thresholds** so GC has room to work. Reasonable defaults for most clusters:

   | Parameter | Default | Suggested |
   |---|---|---|
   | `imageMinimumGCAge` | `2m` | `1m` on pull-heavy workloads; leave at `2m` otherwise |
   | `imageMaximumGCAge` | `0s` (disabled) | `168h` (7d) — bounds how long unused images can live |
   | `imageGCHighThresholdPercent` | `85` | `75` |
   | `imageGCLowThresholdPercent` | `80` | `65` |

3. **Apply the settings through ACP's platform-configure surface**, not by editing `/var/lib/kubelet/config.yaml` on the node directly — direct edits are wiped by the next node reconcile. Create a node-configuration change under `configure/clusters/nodes` for the node pool and let the platform roll the change out with drain + kubelet restart.

4. **Scale the image partition** if the pull mix genuinely exceeds what GC can reclaim (common for AI training images and layered build caches). Moving `/var/lib/containers` onto a dedicated, larger volume is usually simpler than hunting for images to retain.

5. **Clean up registry credentials.** Stale `imagePullSecrets` often cause the kubelet to re-pull the same image under a new digest, amplifying disk usage. Consolidate to a single pull secret per namespace where possible.

## Diagnostic Steps

Check the current effective kubelet configuration on the affected node:

```bash
kubectl get --raw /api/v1/nodes/<node>/proxy/configz \
  | jq '.kubeletconfig | {
          imageMinimumGCAge,
          imageMaximumGCAge,
          imageGCHighThresholdPercent,
          imageGCLowThresholdPercent
        }'
```

Look for GC activity in kubelet logs:

```bash
kubectl debug node/<node> -it --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host journalctl -u kubelet --since "1 hour ago" \
  | grep -E 'image_gc|ImageGC|garbage collect'
```

Check how much of the image store is actually reclaimable versus pinned by running pods:

```bash
kubectl debug node/<node> -it --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host crictl images --digests
```

Cross-reference the list against currently running pods:

```bash
kubectl get pod -A -o jsonpath='{range .items[*]}{.spec.containers[*].image}{"\n"}{end}' \
  | sort -u
```

Any image present in `crictl images` but absent from the running-pod list is a candidate for GC once it is older than `imageMinimumGCAge` and disk pressure rises.
