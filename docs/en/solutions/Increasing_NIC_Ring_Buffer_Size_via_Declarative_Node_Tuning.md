---
title: Diagnose and increase NIC ring buffer size on an Alauda Container Platform worker node
component: networking
scenario: how-to
tags: [ethtool, nic, ring-buffer, node, troubleshooting]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Diagnose and increase NIC ring buffer size on an Alauda Container Platform worker node

## Issue

A worker node on Alauda Container Platform (kube v1.34.5 lab cluster, Ubuntu 22.04 nodes, containerd 2.2.1-5) shows signs that its NIC's rx or tx descriptor ring cannot keep up with traffic — packet drops, queue overflow counters incrementing, or `ring full` strings in offline node bundles. The driver-default ring buffer sizes are too small for the workload [ev:c1].

The same symptom can be inspected after the fact from a node bundle / sosreport without going back to the live host, by grepping the captured `ethtool -S <iface>` outputs for per-queue counter lines [ev:c2].

The remediation is to increase the per-NIC rx and tx ring buffer sizes (within the per-driver hardware maximum reported by `ethtool -g`) [ev:c3].

## Diagnostic Steps

Open a node-level debug pod and `chroot /host` to run `ethtool` against the worker's primary interface. On the KVM-backed lab cluster the primary interface is `eth0` (driver `virtio_net`); on other environments it can be `ens3`, `eno1`, or similar — list with `ip -br addr` first. The debug image `registry.alauda.cn:60070/acp/container-debug:v4.3.2` ships `ethtool` and standard host tools [ev:c1]:

```bash
kubectl debug node/<node-name> \
    --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
    -it=false -- chroot /host bash -c 'ip -br addr show; ethtool -i eth0; ethtool -g eth0'
```

`ethtool -g <iface>` prints both the per-driver hardware maximum and the currently-configured ring sizes [ev:c3]:

```text
Ring parameters for eth0:
Pre-set maximums:
RX:		256
RX Mini:	n/a
RX Jumbo:	n/a
TX:		256
Current hardware settings:
RX:		256
RX Mini:	n/a
RX Jumbo:	n/a
TX:		256
```

Read the per-queue NIC counters with `ethtool -S <iface>`; the exact spellings depend on the NIC driver. On `virtio_net` the per-queue counters surface as `rx_queue_N_{packets,bytes,drops,xdp_drops,kicks}` and `tx_queue_N_xdp_tx_drops`; other drivers (for example `vmxnet3`) instead expose `pkts rx OOB` and `ring full` lines for the same condition. Look for non-zero `*drops*` or per-queue overflow counters [ev:c1]:

```bash
kubectl debug node/<node-name> \
    --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
    -it=false -- chroot /host bash -c 'ethtool -S eth0 | grep -iE "drop|ring|oob|kicks"'
```

When a node bundle or sosreport has already been collected, the same signals can be searched offline against the captured `ethtool_-S_*` files. Use a grep pattern that covers the per-queue counter spellings the bundle's NIC driver emits — for example `Queue|ring full|OOB` for `vmxnet3`, or `rx_queue.*drops|kicks` for `virtio_net` [ev:c2]:

```bash
grep -E 'Queue|ring full|OOB|rx_queue.*drops|kicks' \
    <sosreport_dir>/sos_commands/networking/ethtool_-S_*
```

## Resolution

Once a NIC has been confirmed to be ring-buffer-bound and the per-driver hardware maximum (reported by `ethtool -g`) is larger than the current setting, raise the rx and tx ring sizes with `ethtool -G <iface> rx <N> tx <N>`. The target value must not exceed the `Pre-set maximums` line — for example on the `virtio_net` driver above the hard ceiling is 256, so a request for `rx 4096` would be rejected by the driver. On NICs that allow it (many physical drivers report maximums of 4096 or higher), 4096 is a common target [ev:c3]:

```bash
kubectl debug node/<node-name> \
    --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
    -it=false -- chroot /host bash -c 'ethtool -G eth0 rx 4096 tx 4096; ethtool -g eth0'
```

Re-run the diagnostic block above to confirm that `Current hardware settings` reflects the new value and that the per-queue drop counters stop incrementing under load [ev:c1][ev:c3].

> Note: `ethtool -G` applies the new ring sizes immediately via a Linux net-driver ioctl, but the change is not persisted across a node reboot. For a persistent setting, the same `ethtool -G` invocation has to be wired into the node's boot-time configuration (for example a systemd oneshot unit ordered before the cluster networking stack starts, delivered at provisioning time). The exact persistence mechanism depends on how worker nodes are provisioned in the environment and is out of scope here.
