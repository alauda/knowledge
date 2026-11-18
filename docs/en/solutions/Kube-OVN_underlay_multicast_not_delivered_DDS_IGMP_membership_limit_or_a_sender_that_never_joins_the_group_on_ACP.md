---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Kube-OVN underlay multicast not delivered: DDS, IGMP membership limit or a sender that never joins the group on ACP

## Issue

Pods on a Kube-OVN underlay subnet send or receive multicast, and the data does not arrive. Unicast between the same endpoints works. Typical reports:

- DDS traffic from one underlay Pod to another is missing or arrives only after several minutes, on the same node or across nodes. The same receiver accepts DDS immediately when the sender is a physical host using that sender's address.
- An application cannot join one more multicast group, and its multicast send or receive breaks; joining works again after another group is dropped.
- A Pod sends to a multicast group. The packets can be captured on the host's physical NIC but not on the switch, and receivers that joined the group get nothing. `ping -c 3 <group>` from the Pod shows `100% packet loss`.

## Root Cause

### Cause 1: underlay DDS depends on platform multicast support that is enabled separately

On ACP 4.2 with business Pods on a Kube-OVN underlay network, DDS can fail or arrive late between Pods while unicast is normal, across several applications, while a physical sender on the same address works. This is the platform multicast path, not IPAM and not a single application's socket. Enabling multicast for this scenario is a separate request to the platform vendor; there is no in-cluster switch for it.

### Cause 2: net.ipv4.igmp_max_memberships is 20, so a new group cannot be joined

`net.ipv4.igmp_max_memberships` defaults to `20` and applies per network namespace. Once the Pod has joined 20 groups, the next `setsockopt` join fails and the application's multicast traffic for that group breaks. Leaving one group allows the new join; raising the sysctl keeps the cap from being hit again.

### Cause 3: the sending application never joins the target group

The application sends UDP to the target group but never joins it with `setsockopt(IP_ADD_MEMBERSHIP)`. The kernel therefore sends no IGMP report for that group, and OVN records no `IGMP_Group` entry for it. With IGMP snooping, OVN forwards ordinary multicast only to ports that have joined the group, so the packets match no forwarding flow and are dropped before they reach the bridge port and the switch. A group the Pod did join (for example the group it receives from) works, because it has an `IGMP_Group` entry.

The evidence on the Pod and the node:

- `ip maddr` in the container lists the joined groups on `eth0` and has no entry for the target group.
- `tcpdump -i eth0 -nnve igmp` on the node shows the gateway's `igmp query v3`, and the Pod's port answers with `igmp v3 report, 1 group record(s) [gaddr <joined-group> is_ex, 0 source(s)]` only for the joined group, never for the target group.
- The OVN `IGMP_Group` table has an entry for the joined group and none for the target group.

This is an application-side problem; the network configuration is working as designed.

## Resolution

### Cause 1: underlay DDS depends on platform multicast support that is enabled separately

Rule out Cause 3 first. If unicast works, the application joins its groups, and DDS still fails between Pods while a physical sender on the same address succeeds, request multicast enablement for the cluster. Locate where the packets stop and attach the result:

```bash
kubectl exec -n <namespace> <receiver> -- ip maddr
kubectl exec -n <namespace> <receiver> -- ip route
tcpdump -ni <pod-iface-on-node> -c 20 host <multicast-group>
```

On the receiver node, a packet on the Pod veth means the CNI delivered it. A packet on the physical NIC and none on the veth means the underlay path did not forward the group. A packet on the veth and no group membership in the receiver means the application did not join.

### Cause 2: net.ipv4.igmp_max_memberships is 20, so a new group cannot be joined

Only when a new join fails and the sysctl in the Pod prints `20`: leave a group the application owner confirms is no longer needed, or raise the limit.

> **Warning:** A higher limit uses more kernel memory for membership state in that network namespace. A value written with `sysctl -w` in a running Pod is lost when the Pod is recreated. Writing back the previous value (normally `20`) is the rollback. Dropping a group stops reception for it immediately; rejoining reverses it.

```bash
kubectl exec -n <namespace> <pod> -- sysctl net.ipv4.igmp_max_memberships
kubectl exec -n <namespace> <pod> -- sysctl -w net.ipv4.igmp_max_memberships=64
kubectl ko sbctl list Multicast_Group
```

If `kubectl ko` is not available on the operator node, take the `kubectl-ko` helper from the `kube-ovn-pinger` image the cluster already runs. To keep a higher limit across restarts, set the sysctl in the Pod spec only if the kubelet already allows that key; otherwise reapply it after each recreate.

### Cause 3: the sending application never joins the target group

Have the application join the target group with `setsockopt(IP_ADD_MEMBERSHIP)` before sending, so the kernel sends an IGMP report and OVN creates the `IGMP_Group` entry. Then check again on the node:

```bash
kubectl exec -n <namespace> <sender> -- ip maddr
tcpdump -i <pod-iface-on-node> -nnve igmp
kubectl ko sbctl list IGMP_Group
```

The target group should now appear in `ip maddr`, in an IGMP report from the Pod's port, and in `IGMP_Group`.

## Diagnostic Steps

1. Confirm unicast and read the group memberships of sender and receiver:

   ```bash
   kubectl get pod <sender> <receiver> -n <namespace> -o wide
   kubectl exec -n <namespace> <sender> -- ping -c 3 <receiver-ip>
   kubectl exec -n <namespace> <sender> -- ip maddr
   kubectl exec -n <namespace> <receiver> -- ip maddr
   ```

2. Watch IGMP on the node of the sending Pod and read OVN's group table:

   ```bash
   tcpdump -i <pod-iface-on-node> -nnve igmp
   kubectl ko sbctl list IGMP_Group
   ```

   No membership, no IGMP report and no `IGMP_Group` entry for the group the Pod sends to: Cause 3.

3. Check the membership cap:

   ```bash
   kubectl exec -n <namespace> <pod> -- sysctl net.ipv4.igmp_max_memberships
   ```

   A join error at 20 memberships: Cause 2.

4. Unicast works, groups are joined, and DDS from a Pod sender fails while a physical sender on the same address succeeds: Cause 1.

If unicast to the underlay gateway already fails, the problem is not multicast; see "Kube-OVN underlay Pods fail with resolve MAC address timeout or bridge network InitOVSBridgeFailed on ACP".
