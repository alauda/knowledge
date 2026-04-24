---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

Every node carves a slice of its raw capacity away from `Allocatable` and hands it to the system layer — the kubelet, the container runtime, sshd, NetworkManager, journald, and any DaemonSets that run outside the user pod cgroup. This carve-out is `systemReserved` (and the closely related `kubeReserved`), and getting it wrong is a quiet source of incidents:

- Set it too low, and busy nodes starve their own kubelet, missing heartbeats and triggering eviction storms while user pods believe they still have room.
- Set it too high, and each node runs at lower density than necessary; cluster-wide that translates directly into more nodes for the same workload.

The platform's default reservation (typically around `1Gi` of memory and `500m` of CPU) is sized for small / medium nodes. High-memory or high-density nodes need significantly more, and the right number is a function of node hardware rather than a single cluster-wide constant.

## Resolution

### Recommended Memory Reservation

The community-derived sliding scale that drives most managed-platform autosizers:

| Node memory band      | Reserved fraction within the band |
|-----------------------|----------------------------------|
| Up to 1 GiB           | flat `255 MiB`                  |
| First 4 GiB           | 25%                             |
| Next 4 GiB (4–8 GiB)  | 20%                             |
| Next 8 GiB (8–16 GiB) | 10%                             |
| Next 112 GiB (16–128) | 6%                              |
| Above 128 GiB         | 2%                              |

A 32 GiB node lands at:

```text
0.25 * 4 GiB  +  0.20 * 4 GiB  +  0.10 * 8 GiB  +  0.06 * 16 GiB
= 1.00 + 0.80 + 0.80 + 0.96
= 3.56 GiB reserved
```

leaving `~28.44 GiB` of allocatable memory for user pods.

### Recommended CPU Reservation

Two formulas are in use depending on platform vintage. **The minimum supported reservation is `500m`** — anything lower starves the kubelet on busy nodes regardless of what the table says.

**Older formula** (legacy auto-sizing):

| Core band                  | Reserved fraction |
|----------------------------|-------------------|
| First core                 | 6%                |
| Second core                | 1%                |
| Cores 3 and 4              | 0.5% each         |
| Each remaining core        | 0.25% each        |

For a 16-core node: `60m + 10m + (2 * 5m) + (12 * 2.5m) = 110m`. This is **below** the `500m` floor, so the effective reservation rounds up to `500m`.

**Newer formula** (current auto-sizing):

```text
base_allocation_fraction       = 0.06     # 60 millicores for the first CPU
increment_per_cpu_fraction     = 0.012    # +12 millicores per additional CPU
recommended_systemreserved_cpu = base + increment * (cpus - 1)   # if cpus > 1
```

For the same 16-core node: `0.06 + 0.012 * 15 = 0.24` core, i.e. `240m`. Again, this is below the `500m` floor — round up.

The newer formula is materially more generous on dense nodes (e.g. a 64-core node lands near `816m` instead of `170m` under the old model), which fixes the under-provisioning that caused intermittent kubelet pressure on large hosts.

### Worked example: 16 vCPU / 32 GiB worker

```text
CPU reservation:    max(500m, formula) = 500m
Memory reservation: 3.56 GiB
Allocatable CPU:    16000m - 500m = 15500m
Allocatable memory: 32 GiB - 3.56 GiB ≈ 28.44 GiB
```

A 64 GiB / 32-vCPU node would land near `5.5 GiB` reserved memory and `0.45 + 0.012 * 31 ≈ 0.83 CPU` (rounded up to whatever the platform's sizing script computes; never below `500m`).

### Choosing Auto vs Manual Sizing

The platform exposes both modes through its node-configuration surface (`configure/clusters/nodes`):

- **Auto sizing** (`autoSizingReserved: true`) tells the kubelet to compute the reservation from the node's hardware on every boot using the formulas above. Use this on heterogeneous fleets where node sizes differ.
- **Manual sizing** (explicit `systemReserved.cpu` / `systemReserved.memory`) is preferred when the formula's output does not match observed system-slice usage — for example, on nodes running heavy host agents (audit forwarders, EDR) that swell `system.slice` beyond the formula's assumptions.

In both cases the reservation is delivered through a kubelet configuration object scoped to a node pool, never edited by hand on `/var/lib/kubelet/config.yaml`.

```yaml
apiVersion: machineconfiguration.k8s.io/v1
kind: KubeletConfig
metadata:
  name: large-worker-reservation
spec:
  machineConfigPoolSelector:
    matchLabels:
      pools.operator.machineconfiguration.k8s.io/worker: ""
  kubeletConfig:
    systemReserved:
      cpu: "1000m"
      memory: "5500Mi"
    kubeReserved:
      cpu: "500m"
      memory: "1Gi"
    evictionHard:
      memory.available: "500Mi"
      nodefs.available: "10%"
```

Apply with `kubectl apply -f`. The platform drains and uncordons each matching node as the kubelet restarts with the new reservation.

## Diagnostic Steps

Inspect the reservation actually in effect on a node (rather than the cluster object that should set it):

```bash
NODE=<worker-node>
kubectl get --raw "/api/v1/nodes/$NODE/proxy/configz" \
  | jq '.kubeletconfig | {systemReserved, kubeReserved, evictionHard}'
```

Compare against live system-slice usage to see how much of the reservation is consumed:

```bash
kubectl get --raw "/api/v1/nodes/$NODE/proxy/stats/summary" \
  | jq '.node.systemContainers[]
         | {name,
            workingSet: .memory.workingSetBytes,
            rss: .memory.rssBytes}'
```

Sustained working-set above ~80% of the reservation is the signal to widen it — wait for the next reconcile rather than nudging it during peak hours.

Inspect the on-node sizing script's output for a sanity check (the script ships in the kubelet bootstrap files):

```bash
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host /bin/bash -c '
    NODE_SIZES_ENV=/tmp/node-sizing.txt \
      /usr/local/sbin/dynamic-system-reserved-calc.sh true
    cat /tmp/node-sizing.txt
  '
```

If the script's output disagrees with what `configz` reports, the auto-sizing pipeline has not landed on this node yet — wait for the rollout, or fall back to manual sizing for the affected pool.
