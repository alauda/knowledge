---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Control-plane nodes raise the `DiskPressure` condition, and new workloads begin to pile up in `ContainerCreating`, `CreateContainerError`, or `ImagePullBackOff` states across unrelated namespaces. Symptoms observed on the affected node:

- The overlay storage tree under `/var/lib/containers/storage/overlay/` contains an unusually large number of layer directories.
- Manual image pruning via the container runtime CLI does not reclaim any space:

  ```bash
  crictl --timeout=120s rmi --prune
  ```

- The kubelet repeatedly announces candidate images for garbage collection, but the runtime rejects the removal because a container still references the layer:

  ```text
  image_gc_manager.go: "Removing image to free bytes" imageID="4dae2..." size=1207235428
  log.go: "RemoveImage from image service failed" err="rpc error: code = Unknown desc = delete image: image used by <id>: image is in use by a container"
  ```

Because the control plane drifts past the `imageGCHighThresholdPercent` watermark without actually reclaiming bytes, the `DiskPressure` taint stays on, and any pod that lacks a tolerations entry for it is either evicted or never scheduled.

## Root Cause

The kubelet's image garbage collector selects candidates by age and then hands the delete request to the CRI runtime. CRI-O refuses the delete when the image is still bound to a container record in the runtime store, even when that container is no longer a live workload (for example, a crash-looping pod that has been restarting every few seconds for days, or a stale `k8s_*` shim that `cri-o` never reaped). The effect is that the overlay layer count keeps growing, `imageFsAvailable` keeps falling, and the kubelet cannot break the cycle by itself.

This specific rejection path has been captured in upstream CRI-O and kubelet tracking. Until a fixed runtime version is rolled to the node, the node has to be coaxed back into a clean state manually.

## Resolution

The fix is to remove the container records that are pinning the unreclaimable images, then let the kubelet's GC pass clear the overlay. Treat one control-plane node at a time; do not drain a quorum member while another is already down.

1. Identify containers on the affected node that are in a terminal or failing state and whose images the kubelet is trying to free:

   ```bash
   kubectl get pods -A -o wide \
     --field-selector spec.nodeName=<node-name> \
     | grep -Ev 'Running|Completed'
   ```

2. On the node, list container records held by the runtime and remove those whose parent pod is already terminated or crash-looping without a legitimate retry value:

   ```bash
   crictl ps -a --state exited
   crictl rm <container-id>
   ```

   Prefer `crictl rm` over `podman rm` — CRI-O-managed containers should only be cleared through the CRI-O CLI path.

3. After the stale records are removed, retry the prune:

   ```bash
   crictl rmi --prune
   ```

   If the overlay still holds thousands of entries, bounce the kubelet so the GC loop reopens with a fresh view:

   ```bash
   systemctl restart kubelet
   ```

4. Wait for the node's `DiskPressure` condition to clear and for pending workloads on other nodes to reschedule. Only then move to the next control-plane node.

After the node is healthy, upgrade the container runtime on that node to a build that carries the fix for the `image is in use by a container` rejection. Leaving the cluster on a runtime version that hits this path means the next image churn cycle will reproduce the pressure.

## Diagnostic Steps

- Measure the size of the overlay tree and the entry count to confirm the pressure is layer-accumulation rather than, for example, a runaway log file:

  ```bash
  du -sh /var/lib/containers/storage/overlay
  ls -1 /var/lib/containers/storage/overlay | wc -l
  ```

- Tail the runtime journal to watch the removal attempts and the specific rejection reasons:

  ```bash
  journalctl -u crio -f
  ```

- From the kubelet side, confirm that `imageFsAvailable` is below the configured soft/hard eviction thresholds and that the node has taken the `node.kubernetes.io/disk-pressure` taint:

  ```bash
  kubectl describe node <node-name> | grep -A4 Conditions
  kubectl describe node <node-name> | grep Taints
  ```

- Correlate the kubelet's `image_gc_manager.go` log lines with CRI-O's `RemoveImage` failures on the same timestamp. A one-to-one mapping confirms the pattern and rules out an unrelated DiskPressure cause such as a full `/var/log` or an oversized etcd database.
