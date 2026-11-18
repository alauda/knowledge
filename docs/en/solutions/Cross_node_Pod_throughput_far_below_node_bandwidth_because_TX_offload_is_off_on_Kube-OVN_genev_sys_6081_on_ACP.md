---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Cross-node Pod throughput far below node bandwidth because TX offload is off on Kube-OVN genev_sys_6081 on ACP

## Issue

On a cluster that uses the Kube-OVN Geneve overlay, an `iperf` test between two nodes reaches close to the line rate of the NIC, but the same test between two Pods on those nodes reaches much less. For example, on nodes with 25 Gbit/s NICs (ARM Kunpeng servers):

- node to node, across nodes: about 23.5 Gbit/s
- Pod to Pod, across nodes: about 9.1 Gbit/s, a loss of more than 60%

Connectivity itself is fine: cross-node Pod traffic works, it is just slow. On the nodes, `ethtool -k genev_sys_6081` shows transmit offload switched off on the Geneve tunnel interface, with TCP segmentation offload requested but not active:

```text
tx-checksumming: off
        tx-checksum-ip-generic: off
tcp-segmentation-offload: off
        tx-tcp-segmentation: off [requested on]
        tx-tcp-ecn-segmentation: off [requested on]
        tx-tcp-mangleid-segmentation: off [requested on]
        tx-tcp6-segmentation: off [requested on]
generic-segmentation-offload: on
generic-receive-offload: on
```

If cross-node Pod traffic fails rather than being slow, this article does not apply; see [Cross-node Pod traffic fails on the Kube-OVN Geneve overlay because of UDP 6081, TX offload or MTU on ACP](Cross_node_Pod_traffic_fails_on_the_Kube-OVN_Geneve_overlay_because_of_UDP_6081_TX_offload_or_MTU_on_ACP.md), where turning offload **off** is the fix.

## Root Cause

### Cause 1: a Kube-OVN defect leaves TX offload disabled on genev_sys_6081

Pod traffic between nodes is encapsulated in Geneve and leaves the node through the OVS tunnel interface `genev_sys_6081`. A Kube-OVN defect leaves TX checksum offload disabled on that interface. Because TCP segmentation offload depends on TX checksum offload, the kernel also turns TSO off, which is why the TSO features read `off [requested on]`. Every encapsulated packet then has to be segmented and checksummed in software, and cross-node Pod throughput falls far below what the node itself reaches over the same NIC.

The setting does not persist. TX offload is disabled on the interface again after the node reboots or after the `kube-ovn-cni` Pod on that node restarts. The defect is fixed in a later OVN version; until the cluster runs a fixed version, the workaround below has to be reapplied after every such event.

## Resolution

### Cause 1: a Kube-OVN defect leaves TX offload disabled on genev_sys_6081

1. On each node, confirm the symptom before changing anything. Continue only if `tx-checksumming` is `off` and the TSO features show `off [requested on]`:

   ```bash
   ethtool -k genev_sys_6081 | grep -E '^tx-checksumming|tx-checksum-ip-generic|^tcp-segmentation-offload|tx-tcp'
   ```

2. Turn TX offload on for the Geneve tunnel interface, on every node of the cluster (the physical nodes that carry Pod traffic):

   > **Warning:** This changes the offload settings of the tunnel interface that carries all cross-node Pod traffic of the node. Apply it only on nodes where `ethtool -k genev_sys_6081` shows the signature above, and test one node first. Do not apply it on a node where transmit offload was switched off on purpose to work around a NIC checksum problem (see the related article in the Issue section). If cross-node Pod traffic from the node starts failing or checksum errors rise after the change, roll back with `ethtool -K genev_sys_6081 tx off`.

   ```bash
   ethtool -K genev_sys_6081 tx on
   ```

3. Verify the result on the node. Expected: `tx-checksumming: on` and `tcp-segmentation-offload: on`:

   ```bash
   ethtool -k genev_sys_6081 | grep -E '^tx-checksumming|^tcp-segmentation-offload'
   ```

4. Repeat the cross-node Pod `iperf` test (see Diagnostic Steps). Pod-to-Pod throughput should now be close to node-to-node throughput.

5. Reapply step 2 after every reboot of a node and after every restart of the `kube-ovn-cni` Pod on a node, until the cluster runs an OVN version that contains the fix. After such an event, repeat step 1 to check whether the interface has fallen back to `tx-checksumming: off`.

## Diagnostic Steps

1. Measure node-to-node throughput across two nodes, then Pod-to-Pod throughput between Pods scheduled on the same two nodes. Run `iperf3 -s` on the server side and the client against it:

   ```bash
   # on node B, or in a Pod on node B
   iperf3 -s
   # on node A, or in a Pod on node A
   iperf3 -c <node-b-ip-or-pod-b-ip> -t 30 -P 4
   ```

   Expected for this article: the node-to-node result is close to the NIC line rate, and the Pod-to-Pod result is much lower, with no connection errors.

2. Read the offload settings of the Geneve tunnel interface on both nodes:

   ```bash
   ethtool -k genev_sys_6081
   ```

   Expected for this article: `tx-checksumming: off`, `tcp-segmentation-offload: off`, and `tx-tcp-segmentation: off [requested on]`. If `tx-checksumming` is already `on`, this cause does not apply and the throughput gap has another reason.

3. Check whether the offload state lines up with recent node reboots or `kube-ovn-cni` restarts. A node where TX offload was turned on earlier and is `off` again after a restart matches this cause:

   ```bash
   kubectl -n kube-system get pod -o wide | grep kube-ovn-cni
   uptime
   ```

   The `AGE` and restart count of the `kube-ovn-cni` Pod on the node, and the node uptime, show when the setting was last reset.

4. Rule out a connectivity fault. Cross-node Pod traffic that times out or loses packets, rather than being slow, belongs to the related article on Geneve failures, not to this one.
