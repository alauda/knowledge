---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Dashboard Shows High system-reserved CPU Even With autoSizingReserved Enabled
## Issue

A node has `autoSizingReserved: true` configured on its kubelet so that the platform automatically sizes the `system-reserved` CPU and memory reservation instead of using the static default. The expected behaviour is a reservation proportional to the node's capacity — on a larger node, more is reserved; on a smaller one, less.

Instead, cluster dashboards show an *unreasonably high* `system-reserved` CPU value on some nodes (often presented as 80–100% of node CPU appearing consumed by `system-reserved`), and the node has fewer allocatable resources than the same node would have under the static default. Pods that should fit do not schedule, and the Kubernetes node event stream reports `Insufficient cpu` for workloads that used to land comfortably.

Verifying the kubelet's actual reservation on-node through `/etc/node-sizing.env` confirms a value noticeably below — or in specific corner cases, above — what the cluster operator expects for that node's sizing.

## Root Cause

The kubelet's `autoSizingReserved` path computes the per-node reservation by applying tiered factors against the node's CPU count and memory. In a subset of node sizes (specific CPU counts on specific CPU generations), a rounding / tier-boundary error in the calculation produces an anomalously low *actual reservation* — and the metrics-server / cluster dashboard then displays the **observed** kubelet CPU utilisation against that reduced reservation, which looks like very high `system-reserved` usage as a fraction of the reservation itself.

The workloads' real CPU consumption is unchanged; it is the denominator in the dashboard's `system-reserved used / system-reserved reserved` calculation that got smaller, and the ratio looks alarming. In extreme cases, the reduced reservation means fewer resources are withheld for system daemons, so transient bursts in kubelet / container-runtime activity do saturate the reservation for real and cause pod throttling.

The arithmetic has been corrected in newer platform builds. While waiting for the fix to reach the cluster's release channel, the `autoSizingReserved` flag can be turned off and the reservation set manually to a value appropriate for the node's capacity.

## Resolution

### Preferred — upgrade the platform

Follow the platform's upgrade channel to a build where the automatic sizing has been corrected. After the node's kubelet picks up the fix (reboot or kubelet restart, depending on how the node configuration is delivered), `/etc/node-sizing.env` carries the expected reservation and the dashboard's `system-reserved` metric reverts to a reasonable fraction of node capacity.

Verify after the upgrade:

```bash
NODE=<node-name>
kubectl debug node/$NODE --image=<image-with-shell> -- \
  cat /etc/node-sizing.env
# SYSTEM_RESERVED_CPU=500m
# SYSTEM_RESERVED_MEMORY=1Gi
# KUBE_RESERVED_CPU=...
# KUBE_RESERVED_MEMORY=...
```

Values proportional to the node's capacity confirm the fix applied. Compare across a representative sample of nodes in the cluster — the calculation is per-node so per-node verification matters.

### Workaround — disable auto-sizing and set explicit values

If the fixed build is not yet available in the cluster's release channel, disable `autoSizingReserved` and set `systemReserved` / `kubeReserved` manually. The values should reflect the expected reservation for the node's actual size rather than whatever the broken auto-sizing produced.

Consult a standard node-reservation recommendation (most cluster references publish a table keyed on CPU count and memory size) and set:

```yaml
# KubeletConfig (or the equivalent kubelet-configuration CR the platform owns).
kubeletConfig:
  autoSizingReserved: false
  systemReserved:
    cpu:    500m
    memory: 1Gi
  kubeReserved:
    cpu:    100m
    memory: 200Mi
  # evictionHard tied to the reservation keeps the node from thrashing
  # if a pod ever escapes its QoS class and eats into the reservation.
  evictionHard:
    memory.available:  200Mi
    nodefs.available:  "10%"
    imagefs.available: "15%"
```

Apply through the platform's node-configuration surface. The node rolls with the new kubelet configuration; `/etc/node-sizing.env` reflects the explicit values.

Both CPU and memory reservations must be set when disabling `autoSizingReserved`; omitting one or the other causes the kubelet to fall back to defaults that may not match the node's size and recreates the same sizing mismatch in the opposite direction.

### Pick the right values

The cluster's node mix matters. A common starting point for each CPU tier:

| Node CPU cores | `systemReserved.cpu` | `kubeReserved.cpu` | Total reserved |
|---|---|---|---|
| 2 | 100m | 60m | 160m (~8%) |
| 4 | 150m | 80m | 230m (~6%) |
| 8 | 250m | 100m | 350m (~4%) |
| 16 | 400m | 130m | 530m (~3.3%) |
| 32 | 600m | 170m | 770m (~2.4%) |
| 64 | 900m | 230m | 1.13 (~1.8%) |

Memory should scale similarly (roughly 1 GiB on smaller nodes to 2–4 GiB on larger nodes for `systemReserved.memory`). Tune from that baseline based on what actually runs on the node — nodes with container runtimes doing heavy image pulls, or nodes hosting the cluster's own control-plane components, need a larger reservation than workload-only nodes.

## Diagnostic Steps

Confirm the node's actual reservation versus what the cluster operator expects:

```bash
NODE=<node-name>
kubectl debug node/$NODE --image=<image-with-shell> -- \
  sh -c 'cat /etc/node-sizing.env; echo ---;
                      grep -E "systemReserved|kubeReserved" /etc/kubernetes/kubelet.conf 2>/dev/null'
```

The `/etc/node-sizing.env` values are the effective reservation; they should reconcile with both `autoSizingReserved` on/off and the static values (if any) on the `KubeletConfig`.

Read the node's `Allocatable` versus `Capacity`:

```bash
kubectl get node $NODE -o jsonpath='{.status.capacity}{"\n"}{.status.allocatable}{"\n"}'
```

The difference between `Capacity` and `Allocatable` for CPU should equal the sum of `SystemReserved.cpu` + `KubeReserved.cpu` (plus any `evictionHard` cpu, which is typically zero). A gap far larger than the explicit reservations points at the auto-sizing bug or some other reservation pathway leaking in.

Finally, cross-check the dashboard's reported `system-reserved` usage against the node's real kubelet CPU consumption:

```bash
# Sum the CPU usage of kubelet + crio + systemd units on the node.
kubectl debug node/$NODE --image=<image-with-shell> -- \
  sh -c '
    systemctl status kubelet --no-pager | awk "/Tasks:|Memory:|CPU:/"
    systemctl status crio --no-pager | awk "/Tasks:|Memory:|CPU:/"
  '
```

If the real kubelet / container runtime CPU consumption is modest and the dashboard still shows `system-reserved` at a high fraction, the dashboard is correctly reflecting the undersized reservation. The workaround above restores the denominator to a reasonable value, and the dashboard reading normalises.
