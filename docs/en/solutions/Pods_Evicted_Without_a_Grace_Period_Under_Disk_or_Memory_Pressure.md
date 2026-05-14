---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Pods Evicted Without a Grace Period Under Disk or Memory Pressure
## Issue

When a node approaches disk or memory saturation, kubelet terminates pods immediately with no draining interval. Workloads observe abrupt SIGKILLs, in-flight requests fail, and connections close without a graceful shutdown — despite the pods themselves declaring a `terminationGracePeriodSeconds`.

## Root Cause

The kubelet supports two eviction modes:

- **Hard eviction** fires when a resource crosses a configured limit. The kubelet kills the selected pod **immediately**, ignoring the pod's `terminationGracePeriodSeconds`.
- **Soft eviction** fires at a lower threshold and waits for a per-signal grace period before acting. If the condition clears during the grace window, nothing is killed.

A default kubelet ships only with hard thresholds (`memory.available<100Mi`, `nodefs.available<10%`, etc.). With no soft thresholds configured, the first time pressure crosses the hard line every selected pod is torn down without warning. For stateful workloads — databases, queue consumers, long-lived HTTP servers — this looks like the node "randomly killing pods," and the lack of a draining signal makes it hard to diagnose from the application logs.

## Resolution

Introduce soft eviction thresholds and a grace period so the kubelet pressures the workload *before* it must start killing pods.

1. **Pick soft thresholds slightly more lenient than the hard ones.** The kubelet evaluates soft first; if pressure clears, no pod is evicted. Example shape:

   ```yaml
   apiVersion: kubelet.config.k8s.io/v1beta1
   kind: KubeletConfiguration
   evictionHard:
     memory.available:  "100Mi"
     nodefs.available:  "10%"
     nodefs.inodesFree: "5%"
     imagefs.available: "15%"
   evictionSoft:
     memory.available:  "500Mi"
     nodefs.available:  "15%"
     nodefs.inodesFree: "10%"
     imagefs.available: "20%"
   evictionSoftGracePeriod:
     memory.available:  "90s"
     nodefs.available:  "90s"
     nodefs.inodesFree: "90s"
     imagefs.available: "90s"
   evictionMaxPodGracePeriod: 120
   ```

   `evictionMaxPodGracePeriod` caps the per-pod grace on soft-evicted pods; the kubelet uses the smaller of this value and the pod's own `terminationGracePeriodSeconds`.

2. **Apply through ACP's platform-configure surface.** Treat this as a node-configuration change under `configure/clusters/nodes` so the drop-in survives node reconciliation. Target one node pool first, watch soak metrics for a day, then expand.

3. **Watch the trade-off.** Soft eviction with long grace periods can delay reclamation when pressure rises quickly. If a node sees sharp, short spikes (bursty logging workloads, batch jobs), keep the grace periods tight (30–60s) and rely on PodDisruptionBudgets plus horizontal scaling to absorb the churn instead of widening the grace window.

4. **Cooperate from the workload side.** Applications should honour `SIGTERM` within the grace period — drain connections, flush buffers, then exit. An application that holds open connections for the full 120 seconds will always appear as a hard kill even when the kubelet did give it time.

## Diagnostic Steps

Dump the effective kubelet configuration from the API:

```bash
kubectl get --raw /api/v1/nodes/<node>/proxy/configz \
  | jq '.kubeletconfig | {evictionHard, evictionSoft, evictionSoftGracePeriod, evictionMaxPodGracePeriod}'
```

An empty `evictionSoft` object confirms only hard eviction is active.

Find the node-level pressure events and which pods were selected:

```bash
kubectl describe node <node> | sed -n '/Conditions/,/Capacity/p'
kubectl get events -A --field-selector involvedObject.kind=Pod,reason=Evicted \
  -o custom-columns='NS:.involvedObject.namespace,POD:.involvedObject.name,MSG:.message'
```

Check kubelet logs on the node to see which signal triggered the eviction:

```bash
kubectl debug node/<node> -it --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host journalctl -u kubelet --since "1 hour ago" \
  | grep -iE 'eviction|pressure|reclaim'
```

If evictions continue after adding soft thresholds, compare the real pressure curve to your thresholds with metrics — `node_memory_MemAvailable_bytes`, `node_filesystem_avail_bytes{mountpoint="/var/lib/containers"}`, `node_filesystem_files_free`. Evictions that fire under the soft threshold but above the hard one mean the grace period is shorter than the time it takes the workload to release resources.
