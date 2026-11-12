---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# Cross-node traffic fails in the host network path: default route, firewall, lost tunnel packets or iptables on ACP

## Issue

The CNI Pods are `Running`, yet traffic between nodes breaks. Typical reports:

- Nodes added to a cluster through their out-of-band address become abnormal.
- An interface that the server can reach cannot be reached from inside a container on some nodes.
- Hundreds of Pods are down, and `kube-ovn-pinger` can reach its own node but no other node.
- Monitoring is abnormal on a new cluster because one `vmselect` replica has no network.
- After someone ran `iptables-restore` on a node, the workload cluster shows as abnormal in the platform, its VIP answers only some of the time, and restarting containerd does not help. On the global cluster, `erebus` logs `cluster "<workload-cluster>" is temporarily not accessible`.
- Cross-node communication fails and `ping` returns `Destination Host Prohibited`.

Each cause below is found by testing the path between two specific nodes: their routes, the firewalls between them, and whether a packet sent by one ever arrives at the other.

## Root Cause

### Cause 1: nodes joined through the out-of-band IP have their only default route on the out-of-band NIC

Hosts with an out-of-band and an in-band address (for example `bond1` and `bond0`) were added to the cluster using the out-of-band IP. On normal nodes the default route prefers `bond0` (in-band, metric `300`) with `bond1` (out-of-band, metric `301`) as backup. On the abnormal nodes the only default route is via `bond1`, and the `bond0` default route is missing. Kubernetes control-plane traffic depends on the in-band interface, so the nodes lose communication with the control plane. Restoring the default route on the joined nodes brings the node status back, but Pods still fail to start; the routing has to be correct before the node is added.

### Cause 2: the firewall between two groups of nodes is not fully open

The `kube-ovn-pinger` results on an affected node show the pattern: `ping pod` to most other pinger Pods reports `count: 3, loss count 3, average rtt 0.00ms`, with only a few at `loss count 0`; `ping node` reports `loss count 3` to most nodes and `loss count 0` only to a small group, which is the other nodes of the affected group plus the masters; DNS lookups of `kubernetes.default` and an external name work; `ping external address` reports `loss count 3`. The affected nodes and the other nodes belong to two different network zones or systems, and the network policies between them are not fully open for node and Pod traffic.

### Cause 3: replies never reach the requesting node because a conflicting subnet takes the return path

From the `kube-ovn-pinger` Pod, a request to the local node works and requests to other nodes fail. A capture on `genev_sys_6081` while a `curl` runs in the pinger's network namespace shows, on port `6443`, the requester sending repeated `[SYN]` packets and `[TCP Retransmission]` of them, and the target nodes answering with `[SYN, ACK]` (some marked `[TCP Retransmission]` and `[TCP Out-Of-Order]`) that the requester never receives. A subnet that conflicts with a cluster range sends the replies elsewhere. Removing the conflicting subnet fixes it. When the nodes are VMs, also check whether the virtualization routing mode or the physical hosts under the VMs changed.

### Cause 4: IPIP packets from one node never arrive at one peer's NIC

On a Calico cluster in IPIP mode, every node has a `tunl0` interface (`<NOARP,UP,LOWER_UP> mtu 1480`) with a `/32` address. From one master, a ping to a worker's `tunl0` address gets `100% packet loss`, while another worker reaches it. `tcpdump` on the master shows echo requests leaving on `tunl0` with no replies; a capture of IPIP (`ip proto 4`) on `eth0` shows the worker sending IPIP packets to the master (including TCP `[S.]` replies from port `6443`), and the master's `eth0` receives none of them, with no RX or TX errors or drops. The packets are lost in the underlying network between those two hosts, outside the cluster. Pods on the affected node (for example a `vmselect` replica) lose connectivity.

### Cause 5: iptables-restore overwrote the node rules and the workload cluster VIP flaps

`iptables-restore` run on a node of a workload cluster overwrites the node's iptables rules. The cluster's self-built VIP (served by keepalived, the `alive` container) then answers only some of the time, and the platform marks the cluster abnormal. Restarting containerd does not help. On the global cluster both `erebus` Pods in `cpaas-system` are `Running` with no restarts, and their log repeats:

```text
proxy.go:158] cluster "<workload-cluster>" is temporarily not accessible
Generate new reverse proxy for: 600:https://<address>:6443
```

Restarting the keepalived container restores VIP connectivity, and the workload cluster returns to normal.

The signature of this cause is the VIP itself failing part of the time. The same `temporarily not accessible` text, returned to UI requests and by `apollo` as `410` with reason `Gone`, can also appear while the VIP answers every time; then the problem is on the platform side, not in the node network, and the steps below do not apply.

### Cause 6: Destination Host Prohibited, a host FORWARD rule rejects cross-node traffic

`calico-node`, `kube-proxy` and the other node Pods are `Running`, but a cross-node `ping` gets `Destination Host Prohibited` for every packet. `iptables -L FORWARD -n --line-numbers` on the affected node shows, after the `DOCKER-USER`, `DOCKER-ISOLATION-STAGE-1`, `ACCEPT` and `DOCKER` rules, a rule `REJECT all -- 0.0.0.0/0 0.0.0.0/0 reject-with icmp-host-prohibited`, and the command may also print `# Warning: iptables-legacy tables present, use iptables-legacy to see them`. That host firewall rule rejects the forwarded cross-node traffic.

## Resolution

### Cause 1: nodes joined through the out-of-band IP have their only default route on the out-of-band NIC

1. Compare the routing table with a normal node:

   ```bash
   ip route show default
   ip -br addr show bond0 bond1
   ```

2. Remove the node, correct the default route, and join it again. Restoring the route alone brings the node status back but does not make the Pods start.

   > **Warning:** Changing the default route can cut the SSH session that uses it; work from a console. Deleting a node evicts and removes all its Pods, and the node must be joined again; drain it first. Only when the node's default route is on the out-of-band NIC and normal nodes prefer the in-band NIC. Save `ip route` before the change; to roll back, add the saved route again.

   ```bash
   kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
   kubectl delete node <node-name>
   ip route del default via <out-of-band-gateway> dev bond1
   ip route add default via <in-band-gateway> dev bond0 metric 300
   ```

3. Make the route persistent in the node's network configuration, with a lower metric for the in-band NIC than for the out-of-band one, confirm `ip route show default` matches a normal node, and add the node again with its in-band address.

### Cause 2: the firewall between two groups of nodes is not fully open

1. Use the pinger results to map which nodes cannot reach which:

   ```bash
   kubectl -n kube-system get pod -l app=kube-ovn-pinger -o wide | grep <node-name>
   kubectl -n kube-system logs <kube-ovn-pinger-pod-on-this-node> --tail=500 | grep -E 'ping (pod|node|external)' | grep -v 'loss count 0' | head -50
   ```

2. Group the failing targets by node. A clean split along a system or zone boundary, with only the masters reachable across it, is this cause. Have the network team open the policies between the two groups for node and Pod traffic.

### Cause 3: replies never reach the requesting node because a conflicting subnet takes the return path

1. Capture on the Geneve interface in one window, and run the `curl` from the pinger's network namespace in another, on the same node:

   ```bash
   tcpdump -i genev_sys_6081 -n -v -w genev_sys_6081_traffic.pcap
   ```

2. Check the route back to the source on the target node and on the requester, and compare it with the cluster subnets:

   ```bash
   ip route get <pinger-pod-ip>
   ip route
   kubectl get subnet -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidrBlock'
   ```

   A reply route that points somewhere other than the path back to the requester, through a range that overlaps a cluster subnet, identifies the conflicting subnet.

3. Remove the conflicting subnet or route.

   > **Warning:** Deleting a subnet or a route that overlaps a cluster range changes where that whole range is routed. Confirm which object is the conflicting one and that nothing still needs it. Save it first (`kubectl get subnet <subnet> -o yaml`, or `ip route` on the node) so it can be recreated.

### Cause 4: IPIP packets from one node never arrive at one peer's NIC

1. Prove the loss on the wire. Run the `ip proto 4` capture on both nodes at the same time:

   ```bash
   ip a | grep tunl0
   ping -c 5 <peer-tunl0-ip>
   tcpdump -i any -nnve icmp and host <peer-tunl0-ip>
   tcpdump -i eth0 -nnve ip proto 4 and host <sender-node-ip> and host <receiver-node-ip>
   ip -s link show eth0
   ```

   Packets leaving the sender's NIC that never appear on the receiver's NIC, with clean NIC counters, are this cause.

2. Hand the captures to the IaaS or network team. Until the underlying network is repaired, take the affected node out of service (replace it if needed).

   > **Warning:** Draining the node moves or stops every Pod on it. To roll back, uncordon it once the underlying network is repaired.

   ```bash
   kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
   kubectl uncordon <node-name>
   ```

### Cause 5: iptables-restore overwrote the node rules and the workload cluster VIP flaps

1. On the global cluster, confirm that `erebus` sees the cluster as unreachable, then test the workload cluster's VIP repeatedly:

   ```bash
   kubectl -n cpaas-system get pod -o wide | grep erebus
   kubectl -n cpaas-system logs <erebus-pod> --tail=500 | grep -E 'temporarily not accessible|Generate new reverse proxy'
   for i in $(seq 1 30); do curl -k -s -o /dev/null -m 2 -w '%{http_code}\n' https://<cluster-vip>:6443/healthz; sleep 1; done | sort | uniq -c
   ```

   Restarting `erebus` can confirm that the status persists; the fault is on the VIP side.

2. Restart the keepalived container (`alive`) on the workload cluster masters, one master at a time.

   > **Warning:** Only when the `healthz` loop above shows failures or timeouts. Restarting keepalived moves or briefly drops the VIP, so API access through the VIP is interrupted for a moment. Test the VIP between masters. There is nothing to roll back; the container comes back with its own configuration.

   ```bash
   kubectl get pod -A -o wide | grep -i alive
   crictl ps | grep -i alive || docker ps | grep -i alive
   ```

   If `alive` is a Pod, delete that Pod on the master so it is recreated. Otherwise restart the container with the node's runtime (`docker restart <container-id>`, or `crictl stop <container-id>` for a kubelet-managed container, which kubelet then starts again).

3. Save the node's rules (`iptables-save`) before anyone runs `iptables-restore` on a cluster node again.

### Cause 6: Destination Host Prohibited, a host FORWARD rule rejects cross-node traffic

Only when a cross-node ping returns `Destination Host Prohibited` and the `FORWARD` chain holds a `REJECT ... reject-with icmp-host-prohibited` rule that healthy nodes do not have, delete that rule by its line number.

> **Warning:** Changing the host firewall opens forwarded traffic that the rule used to reject; agree it with whoever owns the node security policy. Save the rules first. To roll back, run `iptables-restore < /root/iptables.before-forward`. The line number changes when rules are added or removed, so read it again right before the delete.

```bash
iptables-save > /root/iptables.before-forward
iptables -L FORWARD -n --line-numbers
iptables -D FORWARD <line-number-of-the-REJECT-rule>
ping -c 3 <other-node-or-pod-ip>
```

Find where the host loads the rule from (for example a saved iptables service ruleset) so that a reboot does not bring it back.

## Diagnostic Steps

Pick one failing pair of nodes and test the path between them in both directions:

```bash
kubectl get nodes -o wide
ip route show default
ip route get <peer-node-ip>
kubectl -n kube-system logs <kube-ovn-pinger-pod> --tail=200 | grep 'loss count' | grep -v 'loss count 0' | head
tcpdump -ni <node-nic> host <peer-node-ip> -c 50
iptables -L FORWARD -n --line-numbers | grep -E 'REJECT|DROP'
```

- A default route on a different NIC than on healthy nodes, on nodes joined through another address, is Cause 1.
- Pinger losses that split the cluster into two groups, with masters reachable from both, are Cause 2.
- Requests that leave, answers that are sent, and answers that never arrive at the requester, together with an overlapping subnet, are Cause 3.
- Encapsulated packets that leave one NIC and never reach the other, with clean counters, are Cause 4.
- `temporarily not accessible` in `erebus` with a VIP that answers only some of the time, after `iptables-restore` on a node, is Cause 5. A VIP loop that returns only `200` while the platform still reports `temporarily not accessible` does not match Cause 5.
- `Destination Host Prohibited` with a `REJECT` rule in the `FORWARD` chain is Cause 6.
- If the cluster VIP is a domain name that a node or a Pod cannot resolve, see [Platform console does not open because the cluster VIP domain name cannot be resolved inside the cluster on ACP](Platform_console_does_not_open_because_the_cluster_VIP_domain_name_cannot_be_resolved_inside_the_cluster_on_ACP.md).
- If Geneve packets arrive but are damaged, see [Cross-node Pod traffic fails on the Kube-OVN Geneve overlay because of UDP 6081, TX offload or MTU on ACP](Cross_node_Pod_traffic_fails_on_the_Kube-OVN_Geneve_overlay_because_of_UDP_6081_TX_offload_or_MTU_on_ACP.md).
