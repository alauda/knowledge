---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Pod traffic fails on Calico because of an IPPool destination, MTU, firewall, BGP sessions or IPv6 routes on ACP

## Issue

On a cluster that uses Calico as the CNI, Pod traffic fails or times out while the node itself is fine. Typical reports:

- `telnet <external-ip> <port>` from the node prints `Connected to ...`, but the same command from inside a Pod (or after `nsenter -t <pid> -n`) stays at `Trying ...`.
- Pods on some nodes cannot reach a VM outside the cluster while Pods on other nodes can, and the nodes differ in `net.ipv4.conf.all.rp_filter`.
- One business container cannot open an external port, while an agent container in the same Pod, other Pods on the node, and the host all can.
- Business nginx times out toward a master NodePort after the MTU of the physical NIC was changed.
- A Pod-to-Pod call times out, and a capture shows the request already inside the destination Pod.
- ClusterIP `telnet` fails right after a node gained an IPv6 address and IPv6 routes.
- After a node was removed and a new node with the same IP was added, Pods on the new node cannot resolve names, and `ping` from the node to a CoreDNS Pod IP returns `Destination Net Unreachable`.
- In a BGP cluster with IPIP and VXLAN off, traffic from containers to outside services arrives from the node address, and the question is whether Calico encapsulates it.

Related articles: "Calico ipipMode reverts, Felix metrics off, bandwidth annotation breaks Pods, systemd-udevd loops on calico_tmp on ACP".

## Root Cause

### Cause 1: the external destination lies inside a Calico IPPool CIDR

Calico treats every address inside the CIDR of any `IPPool` as a cluster address. Its `cali-nat-outgoing` chain masquerades Pod traffic only when the destination is outside all pools:

```text
MASQUERADE all -- 0.0.0.0/0 0.0.0.0/0 /* cali:... */ match-set cali40masq-ipam-pools src ! match-set cali40all-ipam-pools dst
```

When the external host's address falls inside a pool CIDR, Pod traffic to it is not source-NATed and is routed as if it were in-cluster traffic (over IPIP when `ipipMode: Always`). The request leaves with the Pod address, and the remote host cannot answer it. The node uses its own routing table, so the same connection works from the node.

The pool can be the active pool (for example `default-ipv4-ippool` with a `/16` that also covers a range used outside the cluster) or a pool that is disabled and unused: a disabled pool still counts. A difference in `rp_filter` between nodes looks like the cause and is not.

### Cause 2: a non-Calico firewall rule on the node blocks one container

The business container hangs on an external address. The host, an agent container in the same Pod, and other Pods on the node connect. `net.ipv4.ip_forward` is `1`, and the container's default route is the normal Calico route `default via 169.254.1.1 dev eth0`. The node has firewall rules that are not written by Calico or kube-proxy, and they conflict with the container's traffic. Correcting those rules restores the connection.

### Cause 3: the physical NIC MTU was lowered and running Pods kept the old veth MTU

With the IPIP overlay, the tunnel adds 20 bytes to every packet. When the physical NIC MTU was reduced (for example to 1496) and running Pods were not recreated, their veths stayed at 1480, so encapsulated packets exceeded the NIC MTU and were fragmented or dropped. The symptom is intermittent timeouts, for example business nginx failing toward a master NodePort, while small API checks on the master, host load and kube-proxy logs look normal.

### Cause 4: the callee Pod ACKs at once and the application does not read

A caller times out toward one replica. A capture shows the request in the callee Pod's kernel within about a millisecond and an immediate TCP ACK, but the application thread does not read the request for tens of seconds. When it resumes it sends a burst, and the caller has already reset. Other replicas of the same workload are clean. This is an application stall, not a Calico drop; changing IP pools, BGP or MTU does not shorten it.

### Cause 5: ClusterIP fails after an IPv6 address and IPv6 routes were added to a node

On a dual-stack Calico cluster, a node was given an IPv6 address and IPv6 routes, and ClusterIP access from or through that node then failed. The mechanism was not determined. Recreating that node's `calico-node` and `kube-proxy` Pods restored ClusterIP access.

### Cause 6: BGP: Unexpected connect from unknown address, after a node was re-added with the same IP

After a node is removed and a new node with the same IP joins, an existing node's BIRD can fail to create a BGP session for the new node and reject its connections. There are then no routes to the Pods on the new node: from the new node, `ping` to the CoreDNS Service address works while `ping` to a CoreDNS Pod IP fails with `Destination Net Unreachable`, and its Pods cannot resolve names. TCP `179` from the new node is refused on the affected peers, whose `calico-node` log repeats:

```text
bird: BGP: Unexpected connect from unknown address <new-node-ip> (port <port>)
```

`calicoctl node status` can still show every peer `up`, but `birdcl show protocols` on the affected peer lists `Mesh_*` sessions to the other nodes and no entry for the new node. This is a low-probability timing defect in Calico BGP peering. Restarting `calico-node` on the new node does not help; restarting it on the affected peer does.

### Cause 7: container egress leaves with the node address because the IPPool has natOutgoing: true

In BGP mode with `ipipMode` and `vxlanMode` off, nothing is encapsulated. When the pool has `natOutgoing: true`, Calico source-NATs container traffic that leaves the cluster pools to the node address, so external services see the node, and return traffic comes back to the node and is translated back there. This is the expected behavior of that setting.

## Resolution

### Cause 1: the external destination lies inside a Calico IPPool CIDR

1. List the pools and check which CIDR contains the destination:

   ```bash
   kubectl get ippools.crd.projectcalico.org -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidr,DISABLED:.spec.disabled,NAT:.spec.natOutgoing'
   ```

2. If the destination is inside the pool the cluster actually uses, reach the external host through an address outside every pool CIDR (for example, have the network team map the service to such an address), then test again from the Pod. Do not shrink or delete a pool that holds Pod addresses.

3. If the destination is inside a disabled pool that no Pod uses, back the pool up and delete it, so traffic to that range is NATed like other external traffic. Leave `rp_filter` as it is.

   > **Warning:** Deleting an `IPPool` that still has allocations strands those Pods. Only when no Pod address lies in its CIDR. Roll back by applying the saved YAML. If a platform `Subnet` with the same name manages the pool, handle that object too, or the pool comes back.

   ```bash
   kubectl get pod -A -o wide | grep '<pool-prefix>' || true
   kubectl get ippools.crd.projectcalico.org <unused-pool> -o yaml > /root/ippool-<unused-pool>.yaml
   kubectl delete ippools.crd.projectcalico.org <unused-pool>
   ```

### Cause 2: a non-Calico firewall rule on the node blocks one container

Compare the node's firewall with a node where every container connects, and remove or correct the rules that are neither Calico's (`cali-*`) nor kube-proxy's (`KUBE-*`) and that affect the container's egress.

> **Warning:** Editing the filter table can cut SSH and API access. Work from a console, save the rules first, and change only rules that a healthy node does not have. Roll back with `iptables-restore < /root/iptables.before`.

```bash
iptables-save > /root/iptables.before
iptables -S
sysctl net.ipv4.ip_forward
```

Retry from the business container after the rules match a healthy node.

### Cause 3: the physical NIC MTU was lowered and running Pods kept the old veth MTU

Put the physical NIC MTU back to the value it had before the change, so that the Pod MTU plus the 20-byte IPIP header fits again, and persist it in the node network configuration so a reboot does not reapply the lower value.

> **Warning:** Changing the NIC MTU disturbs large in-flight packets on that port. Only when the NIC MTU was reduced and running Pods still show the old veth MTU. Record the current value; setting it again is the rollback (and brings the fragmentation back).

```bash
ip link show <nic>
ip -d link show | grep -E 'mtu|veth' | head
ip link set dev <nic> mtu <original-mtu>
```

### Cause 4: the callee Pod ACKs at once and the application does not read

No CNI change. Capture on the callee node long enough to see whether the application reads the payload. An immediate kernel ACK followed by tens of seconds of silence from the process, with other replicas healthy, goes to the application owner.

```bash
tcpdump -ni any -c 50 host <callee-pod-ip> and port <port>
```

### Cause 5: ClusterIP fails after an IPv6 address and IPv6 routes were added to a node

Delete the `calico-node` and `kube-proxy` Pods on that node so the DaemonSets recreate them.

> **Warning:** Until the new Pods are Ready the node's routes and Service rules are reprogrammed and in-flight connections on it reset. Only when ClusterIP access broke after the node received IPv6 addresses and routes. Restart one node at a time and confirm ClusterIP from a Pod on that node before the next. Nothing needs to be rolled back.

```bash
kubectl -n kube-system get pod -o wide | grep -E 'calico-node|kube-proxy' | grep <node-name>
kubectl -n kube-system delete pod <calico-node-pod-on-this-node> <kube-proxy-pod-on-this-node>
kubectl -n kube-system rollout status ds/calico-node
```

### Cause 6: BGP: Unexpected connect from unknown address, after a node was re-added with the same IP

1. Find the peers that have no session to the re-added node:

   ```bash
   kubectl -n kube-system logs <calico-node-pod-on-peer> -c calico-node --tail=500 | grep 'Unexpected connect from unknown address'
   kubectl -n kube-system exec <calico-node-pod-on-peer> -c calico-node -- birdcl -s /var/run/calico/bird.ctl show protocols
   ```

2. Restart `calico-node` on each affected peer.

   > **Warning:** Restarting `calico-node` on a peer withdraws and re-learns its BGP routes, so Pods on it can briefly lose cross-node traffic. Only on peers whose log shows the message above or whose protocol list lacks the new node. Restart one peer at a time; the DaemonSet recreates the Pod, so there is nothing to roll back.

   ```bash
   kubectl -n kube-system delete pod <calico-node-pod-on-peer>
   kubectl -n kube-system exec <new-calico-node-pod-on-peer> -c calico-node -- birdcl -s /var/run/calico/bird.ctl show protocols | grep -i mesh
   ```

3. If it recurs, check session establishment with `calicoctl get bgpsessions -o wide`. If it is empty, do a rolling restart of every `calico-node` Pod except the one on the re-added node, one at a time.

### Cause 7: container egress leaves with the node address because the IPPool has natOutgoing: true

No fault to repair. Confirm the setting:

```bash
kubectl get ippools.crd.projectcalico.org -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidr,NAT:.spec.natOutgoing,IPIP:.spec.ipipMode,VXLAN:.spec.vxlanMode'
```

Showing Pod addresses to the outside instead is a design change, not a fix: with NAT off, the external network has to route the Pod CIDR back to the nodes.

## Diagnostic Steps

1. Compare the node and the Pod toward the same destination, and check whether the destination is inside a pool:

   ```bash
   telnet <external-ip> <port>
   nsenter -t <container-pid> -n telnet <external-ip> <port>
   iptables -t nat -L cali-nat-outgoing -n
   kubectl get ippools.crd.projectcalico.org -o yaml | grep -E 'name:|cidr:|disabled:|natOutgoing:'
   ```

   The node connects, the Pod stays at `Trying`, and the destination is inside a pool CIDR: Cause 1.

2. Check whether only one container fails. Run the same test from another Pod on the node; if only one container fails, compare `iptables -S` with a healthy node: Cause 2.

3. Check MTU and fragmentation:

   ```bash
   kubectl exec -n <namespace> <pod> -- ip route
   ip link show
   ping -M do -s 1400 -c 2 <destination> || true
   ```

   Timeouts that start when the NIC MTU was lowered while Pod veths kept the old MTU: Cause 3.

4. An immediate ACK in the callee Pod followed by a silent application: Cause 4. A ClusterIP failure that starts with an IPv6 route change on dual-stack: Cause 5.

5. For a re-added node, check BGP on the peers:

   ```bash
   kubectl -n kube-system logs <calico-node-pod> -c calico-node --tail=500 | grep -E 'Unexpected connect|BGP'
   ss -anp | grep ':179'
   ```

   `Unexpected connect from unknown address <new-node-ip>`: Cause 6.

6. External services see the node address and the pool has `natOutgoing: true`: Cause 7, expected behavior.

If cross-node `ping` returns `Destination Host Prohibited`, see "Cross-node traffic fails in the host network path: default route, firewall, lost tunnel packets or iptables on ACP".
