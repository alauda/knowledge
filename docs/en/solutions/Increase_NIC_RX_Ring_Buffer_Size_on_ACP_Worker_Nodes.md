---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500227
---

# Increase NIC RX Ring Buffer Size on ACP Worker Nodes

## Issue

On Alauda Container Platform worker nodes (Kubernetes v1.34.5, debug image `registry.alauda.cn:60070/acp/container-debug:v4.3.2`), workloads can experience packet drops when the NIC's RX ring buffer is too small for the offered traffic rate. The kernel exposes per-queue counters through `ethtool -S <iface>`; rising `rx_queue_N_drops` (and related per-queue fields emitted by the active net driver, for example `virtio_net`'s `rx_queue_N_{packets,bytes,drops,xdp_*,kicks}` on a KVM-backed node) is the canonical indicator that the ring is saturating and the driver is discarding frames before the network stack can dequeue them.

The currently configured RX/TX ring sizes are read with `ethtool -g <iface>`, which prints the driver's hardware maximum (`Pre-set maximums`) alongside the running value (`Current hardware settings`); the gap between the two is the headroom available for a buffer increase, and the running value being equal to the hardware maximum means no further enlargement is possible on that NIC.

## Root Cause

When the per-queue RX ring is sized below what the workload demands during bursts, the driver has no place to stage incoming frames between hardware DMA and the kernel softirq that hands them up the stack, so the NIC overwrites or discards packets and increments the per-queue drop counter visible through `ethtool -S`. The mitigation is to enlarge the ring up to the hardware maximum reported by `ethtool -g`, provided that maximum is larger than the current value.

## Resolution

Enlarge the RX ring on the affected interface with `ethtool -G <iface> rx <N>`, choosing `<N>` no greater than the `Pre-set maximums` RX value reported by `ethtool -g <iface>` on that node; the same flag surface accepts `tx <N>` for the transmit ring when needed. On drivers whose hardware maximum is small (for example `virtio_net` caps RX at 256 on the verified node), the ioctl rejects any value above that cap, so the achievable size is environment-dependent and the per-node `ethtool -g` readout is the authoritative upper bound.

A bare `ethtool -G` invocation only changes the live setting and does not survive a reboot or interface re-initialisation. Making the change persistent across node restarts requires a node-OS-level boot-time mechanism that runs before kubelet starts so the enlarged ring is in place when pod networking comes up; this delivery is platform-specific and must be handled through whatever host-configuration mechanism is in use for the cluster's node images, rather than through any ACP cluster API.

## Diagnostic Steps

Open a privileged debug session on the target worker and inspect the ring sizes and per-queue counters directly on the host. `kubectl debug node` is supported on ACP v1.34.5; combined with the cluster-resident `container-debug:v4.3.2` image, it gives a chroot into the node filesystem with `ethtool` and `systemctl` available:

```bash
NODE=<worker-node-name>
IFACE=<interface>     # e.g. eth0 on a KVM-backed node

kubectl debug node/${NODE} \
  --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- chroot /host ethtool -g ${IFACE}

kubectl debug node/${NODE} \
  --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- chroot /host ethtool -S ${IFACE} | grep -E 'rx_queue_.*_(drops|packets)'
```

The first command prints the `Pre-set maximums` (the hardware ceiling) and the `Current hardware settings` (the running value); compare them to confirm headroom exists before attempting a change. The second command lists per-queue counters; a non-zero and increasing `rx_queue_N_drops` for one or more queues confirms the ring is the bottleneck.

After applying a new ring size, re-run `ethtool -g ${IFACE}` through the same debug session to confirm that `Current hardware settings` now reflects the requested value, and re-sample `ethtool -S ${IFACE}` over a representative traffic window to confirm `rx_queue_N_drops` stops advancing. Iterate across every worker that handles the affected traffic, since the change is per-node and per-interface.
