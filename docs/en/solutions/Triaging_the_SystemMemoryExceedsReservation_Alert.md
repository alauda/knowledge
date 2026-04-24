---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The platform monitoring stack fires `SystemMemoryExceedsReservation` for one or more nodes, yet the same nodes show no memory pressure: workloads are healthy, the kubelet has not started evicting pods, and `kubectl top node` reports usage well below capacity. Operators often dismiss the alert as a false positive — sometimes correctly, sometimes after the underlying drift has already nudged the node toward an eviction storm.

## Root Cause

The alert compares the resident memory of the node's `system.slice` (everything that is not a Kubernetes pod — kubelet, container runtime, sshd, journald, NetworkManager, etc.) against the size of the *reservation* the node was sized with, not against total node memory. The reservation is the gap between `capacity` and `allocatable`, declared on the kubelet via `--system-reserved` / `--kube-reserved` (or their config-file equivalents). It is the cushion that keeps the node functional when every Pod has consumed all of its requested memory.

The PromQL the alert evaluates is:

```text
sum by (node) (container_memory_rss{id="/system.slice"})
  >
((sum by (node) (
  kube_node_status_capacity{resource="memory"}
  - kube_node_status_allocatable{resource="memory"}
)) * 0.95)
```

The right-hand side is the static reservation; the left-hand side is the live RSS of system processes. The alert fires when system processes are using more than 95% of their reserved budget — a forward-looking warning that, once user pods fill `allocatable`, the kernel will have to choose between OOM-killing a container or starving the kubelet itself.

A frequent driver of the alert on otherwise healthy nodes is simply under-sized reservation: the default reservation (typically 1Gi of memory) was chosen for small / medium-density nodes. High-memory hosts and high pod-density hosts both make `system.slice` proportionally larger and burst past 95% of the cushion long before user workloads pressure the node.

## Resolution

1. **Distinguish a real alert from a transient.** A true reservation problem is sustained — the alert keeps re-firing across multiple evaluation cycles. A startup spike (kubelet, runtime, and CNI all initialising at once) can briefly cross the threshold and clear within a minute. Look at the alert's duration in the alerting UI before reaching for kubelet config.

2. **Measure live system-slice usage.** The kubelet exposes per-system-container stats via the summary API, which is what the alert is built on:

   ```bash
   NODE=<affected-node>
   kubectl get --raw "/api/v1/nodes/$NODE/proxy/stats/summary" \
     | jq '.node.systemContainers[]
            | {name, workingSet: .memory.workingSetBytes,
                       rss: .memory.rssBytes}'
   ```

   The `workingSet` of `kubelet` and `runtime` should fit comfortably inside the configured reservation. If they are routinely above 80% of it, the cushion is wrong.

3. **Inspect the reservation that is actually in effect on each node.** The platform's node-configuration surface (`configure/clusters/nodes`) exposes the kubelet's reservation values. To verify the running kubelet without trusting the rendered manifest:

   ```bash
   kubectl get --raw "/api/v1/nodes/$NODE/proxy/configz" \
     | jq '.kubeletconfig | {kubeReserved, systemReserved, evictionHard}'
   ```

   If a node is missing the keys entirely it is running with the default reservation.

4. **Right-size the reservation.** The community formula scales reservation with both CPU and memory of the node:

   - **CPU:** ~6% of the first 1 core, 1% of the next 3 cores, 0.5% of the next 4, 0.25% of every additional core, summed.
   - **Memory:** ~25% of the first 4 GiB, 20% of the next 4, 10% of the next 8, 6% of the next 112, 2% above 128 GiB, summed.

   For a 64 GiB / 16-core worker that puts the reservation around `2.4 CPU` and `~5.5 GiB`, well above the default. Round up rather than down — the cost of a 1-GiB over-reservation is much lower than a kubelet-eviction storm.

5. **Apply the new reservation through the platform's node-configuration surface.** Target a labelled subset of nodes first, watch the alert clear, then widen the rollout. Setting the reservation imperatively on a single host's `/var/lib/kubelet/config.yaml` is reverted at the next reconcile.

   Avoid `autoSizingReserved` on early platform releases that do not include the CPU-rounding fix — the auto-sized CPU value can come out lower than a hand-set reservation and re-create the same alert on busy nodes.

6. **Rule out an actual leak.** If `systemd-cgls /system.slice` shows a single process holding the bulk of the slice (`crio`, `kubelet`, `node-exporter`, a custom DaemonSet), the reservation increase only buys time — file the leak against the offending component and pin the version that fixes it.

## Diagnostic Steps

Reproduce the alert's PromQL against the in-cluster Prometheus to see how close to the threshold each node is:

```text
sum by (node) (container_memory_rss{id="/system.slice"})
  /
((sum by (node) (
  kube_node_status_capacity{resource="memory"}
  - kube_node_status_allocatable{resource="memory"}
)))
```

Values approaching `1` are the noisy nodes; values above `0.95` are the firing ones. Plot the same query over the last seven days — a slow upward drift confirms the reservation is too small for the steady-state load, while a sawtooth around `0.95` typically maps to a periodic Job (log rotation, sosreport collection, image pull burst).

Walk the node's system slice if a single process dominates:

```bash
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host /bin/sh -c '
    systemd-cgls /system.slice/ | head -n 30
    cat /etc/node-sizing.env 2>/dev/null
  '
```

After the new reservation rolls out, the alert should clear within one or two evaluation intervals; the summary API should report `systemContainers[].memory.workingSetBytes` comfortably below the new reservation, and `kubectl describe node $NODE` should show a larger gap between `Capacity` and `Allocatable`.
