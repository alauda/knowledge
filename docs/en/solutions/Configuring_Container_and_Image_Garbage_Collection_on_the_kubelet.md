---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500005
---

# Configuring Container and Image Garbage Collection on the kubelet

## Overview

The kubelet on every worker node continuously reclaims resources from the local container runtime. Two related mechanisms drive this:

- **Container garbage collection** — periodic deletion of dead containers belonging to terminated or replaced pods.
- **Image garbage collection** — periodic deletion of unused container images once disk pressure crosses a threshold.

Both behaviors are enabled by default with conservative thresholds. Operators rarely need to disable them; the common task is to *tune* them so that nodes do not run out of disk during heavy churn (frequent rollouts, batch-job nodes, dev clusters with many tags pulled per day).

This article describes the parameters, where to set them on Alauda Container Platform, and how to verify the change took effect on a node.

## Resolution

### Where the Parameters Live

The kubelet reads its configuration from a YAML file on each node (`/var/lib/kubelet/config.yaml` on most distributions). Garbage-collection parameters live alongside the eviction thresholds:

```yaml
# /var/lib/kubelet/config.yaml — relevant fields only
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# --- Container GC ---
# Once a node has more than this many terminated containers, kubelet
# starts removing the oldest first.
maxContainersPerPod: 1                 # legacy; use maxPerPodContainerCount
maxPerPodContainerCount: 1             # max dead containers retained per pod
maxContainerCount: 100                 # max dead containers retained on the node

# --- Image GC ---
# Once imagefs usage rises above HighThresholdPercent, kubelet deletes
# unused images until usage falls below LowThresholdPercent.
imageGCHighThresholdPercent: 85        # default 85
imageGCLowThresholdPercent: 80         # default 80
imageMinimumGCAge: 2m                  # do not GC images younger than this

# --- Eviction (node pressure) ---
# Soft and hard thresholds that trigger pod eviction; tune in concert
# with image GC so the node does not flap.
evictionHard:
  memory.available:   "100Mi"
  nodefs.available:   "10%"
  nodefs.inodesFree:  "5%"
  imagefs.available:  "15%"
  imagefs.inodesFree: "5%"
evictionSoft:
  memory.available:   "200Mi"
  nodefs.available:   "15%"
evictionSoftGracePeriod:
  memory.available:   "1m30s"
  nodefs.available:   "1m30s"
```

The variables that drive the eviction subsystem map to runtime measurements as follows:

```text
memory.available    := node.status.capacity[memory] - node.stats.memory.workingSet
nodefs.available    := node.stats.fs.available
nodefs.inodesFree   := node.stats.fs.inodesFree
imagefs.available   := node.stats.runtime.imagefs.available
imagefs.inodesFree  := node.stats.runtime.imagefs.inodesFree
```

### How to Apply Changes Across a Node Pool

On Alauda Container Platform the kubelet config is managed at the node-pool level through `configure/clusters/nodes`. Edit the relevant pool's kubelet profile, set the desired GC and eviction values, and let the platform roll the change to each member node. The platform serializes the rollout, drains nodes one at a time, restarts the kubelet, and waits for the node to become Ready before proceeding to the next.

For air-gapped or single-node environments where the platform surface is not available, the equivalent edit is direct:

```bash
# On the node — bookkeeping only; the platform-managed flow above is
# preferred wherever it is available.
sudo cp -a /var/lib/kubelet/config.yaml /var/lib/kubelet/config.yaml.bak
sudo $EDITOR /var/lib/kubelet/config.yaml
sudo systemctl restart kubelet
```

Restarting kubelet briefly drops the node from the API server's heartbeat — schedule the change during a maintenance window or use the platform-managed flow which handles drain/cordon for you.

### Recommended Tuning per Workload Profile

| Workload | Notable kubelet settings |
|---|---|
| Long-lived services with infrequent rollouts | Defaults are fine. |
| Batch / CI workloads (many short pods) | Drop `maxContainerCount` to 50 to reduce dead-container clutter; lower `imageMinimumGCAge` to 30s so transient images are reclaimed quickly. |
| Dev clusters that pull many image tags | Lower `imageGCHighThresholdPercent` to 75 and `imageGCLowThresholdPercent` to 70 so disk does not fill during long working hours. |
| Nodes with separate `/var/lib/containers` partition | Tune `imagefs.available` eviction independently of `nodefs.available`; check `crictl info` for the runtime's reported imagefs path. |

## Diagnostic Steps

Inspect the kubelet's *live* configuration (the parsed config it is actually using, not the file on disk — useful when troubleshooting drift):

```bash
NODE=<worker-node-name>
kubectl get --raw "/api/v1/nodes/${NODE}/proxy/configz" | jq .
```

The `kubeletconfig` block in the response contains every default the kubelet has applied, including those the YAML did not set explicitly.

Check the running kubelet process for the GC values:

```bash
kubectl debug node/${NODE} -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host sh -c 'grep -E "GC|eviction" /var/lib/kubelet/config.yaml'
```

Confirm garbage collection is doing work by tailing the kubelet journal:

```bash
kubectl debug node/${NODE} -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host journalctl -u kubelet --since "10 minutes ago" | grep -iE 'image_gc|container_gc|evict'
```

A healthy node logs occasional `image_gc_manager` lines reporting how many bytes were reclaimed and which images were removed; recurrent eviction lines suggest the thresholds are too tight for the workload.
