---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

One or more cluster nodes flap into `NotReady` and the kubelet status logs report errors similar to:

```text
container runtime is down, PLEG is not healthy: pleg was last seen active ...
```

Workloads on the affected node stop receiving lifecycle updates, new pods fail to schedule there, and if the condition persists the controller-manager starts evicting pods off the node. The node usually recovers briefly after a kubelet restart and then flaps again a few minutes later.

## Root Cause

The Pod Lifecycle Event Generator (PLEG) is a component inside the kubelet that periodically asks the container runtime for the list of containers and their state. Each iteration is called a "relist". If the kubelet cannot complete a full relist within the PLEG health window (three minutes), it marks the node `NotReady` with `PLEG is not healthy` and surfaces a CRI-level error.

The underlying causes cluster into four buckets:

- **Container runtime latency or hang.** The CRI endpoint is responding slowly, stuck on a deadlocked goroutine, or serialised behind an expensive operation (for example, removing a very large container root filesystem). Every relist queues behind it and PLEG times out.
- **Pod density too high for the relist window.** PLEG cost scales with the number of containers on the node, not with host CPU / memory budget. A 96-core host running 1,000 containers still has to walk each one per relist and will miss the deadline before a smaller host with 50 containers ever does.
- **CNI problems during pod status fetch.** Getting pod network status is part of the relist path; a hung CNI call (network plugin unresponsive, `cni-bin` missing a binary, network policy controller stuck) stalls PLEG exactly the same way a runtime hang does.
- **Resource starvation of the kubelet itself.** Containers without requests/limits starving the node of CPU, memory pressure causing OOM kills of kubelet helpers, or a hot I/O loop starving the container runtime process of syscall throughput — all of these show up at the PLEG boundary because that is the first thing the kubelet misses a deadline on.

## Resolution

The immediate recovery is to cordon and drain the node, restart the runtime and kubelet, and clean up dead containers and dangling images that add unnecessary cost to each relist. Then address whichever of the structural causes apply.

Step 1 — drain the node so workloads fail over cleanly:

```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

Step 2 — on the node host, restart the runtime and kubelet. Use `kubectl debug node/<node-name>` to get a privileged shell into a debug container that has `/host` bind-mounted, then `chroot /host` to operate on the host filesystem and services:

```bash
kubectl debug node/<node-name> --image=busybox:1.36 -it -- chroot /host \
  sh -c 'systemctl restart crio && systemctl restart kubelet'
```

Step 3 — purge exited containers and untagged images. These accumulate on a node across workload churn and inflate every relist:

```bash
kubectl debug node/<node-name> --image=busybox:1.36 -it -- chroot /host \
  sh -c '
    crictl ps -a | awk "/Exited/ {print \$1}" | xargs -r crictl rm
    crictl images | awk "/<none>/ {print \$3}" | xargs -r crictl rmi
  '
```

Step 4 — uncordon the node:

```bash
kubectl uncordon <node-name>
```

If PLEG recurs after this cleanup, it is one of the structural causes and the fix is not on the node itself:

- **Set `resources.requests` and `resources.limits` on every workload.** Unbounded pods routinely starve the kubelet at load. Start with the offender identified by `kubectl top pod --sort-by=cpu` and `--sort-by=memory` during the incident window.
- **Cap pod density** on hosts that exceed roughly 250 pods per node. The kubelet's `maxPods` default is 110; values above that are supported but the PLEG budget tightens quickly, especially with many short-lived containers. Lower `maxPods` on the node-config for affected pools, or scale horizontally.
- **Check CNI health.** The cluster CNI on ACP is Kube-OVN. Watch the Kube-OVN controller and daemon pods for restart loops or stuck reconciles during the same window as the PLEG error:

  ```bash
  kubectl -n kube-system get pod -l app=kube-ovn-cni -o wide
  kubectl -n kube-system logs ds/kube-ovn-cni --since=30m | grep -iE 'timeout|deadline|reconcile'
  ```

  A hang inside the CNI during pod-status fetch surfaces as a PLEG symptom on the kubelet side even though the root cause is in the network stack.
- **Upgrade the runtime if a known deadlock has been fixed upstream.** The node-config surface (`configure/clusters/nodes`, or the **Immutable Infrastructure** extension) is where the runtime version is pinned; bumping the runtime is a declarative rolling change from there, not a per-node yum transaction.

## Diagnostic Steps

Confirm PLEG is the actual condition the node is reporting (not a generic `KubeletNotReady`):

```bash
kubectl describe node <node-name> | sed -n '/Conditions/,/Addresses/p'
```

Look at the kubelet log around the transition to `NotReady` to see which CRI call was outstanding when PLEG timed out:

```bash
kubectl debug node/<node-name> --image=busybox:1.36 -it -- chroot /host \
  journalctl -u kubelet --since='30 min ago' \
    | grep -iE 'pleg|relist|container runtime'
```

Look at the container runtime log for the same window — a runtime-side deadlock or exceptionally long syscall usually shows as a matching stall there:

```bash
kubectl debug node/<node-name> --image=busybox:1.36 -it -- chroot /host \
  journalctl -u crio --since='30 min ago' | tail -200
```

Count containers on the node to rule out density:

```bash
kubectl debug node/<node-name> --image=busybox:1.36 -it -- chroot /host crictl ps -a | wc -l
```

Nodes routinely over 300 live containers plus exited-not-yet-reclaimed are in the danger zone for PLEG.

Spot-check unused resources that balloon relist cost:

```bash
kubectl debug node/<node-name> --image=busybox:1.36 -it -- chroot /host \
  sh -c 'crictl ps -a | grep -i Exited | wc -l; crictl images | grep -c "<none>"'
```

Large numbers for either indicate garbage collection is not keeping up — the periodic kubelet container and image GC settings may need tightening for that node pool.

For the capacity angle, pair node-level pod count with cluster-wide top pods during the incident:

```bash
kubectl top node
kubectl top pod -A --sort-by=cpu | head -20
kubectl top pod -A --sort-by=memory | head -20
```

If the top consumers are consistently unbounded workloads on the same node that hits PLEG, the fix is requests/limits (and pod anti-affinity to spread replicas), not anything on the runtime side.
