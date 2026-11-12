---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# New node cannot reach CoreDNS or the API server because a firewall drops tunnel traffic between nodes on ACP

Related articles: [Workload cluster abnormal or monitoring empty in the console because global cannot reach its ports on ACP](Workload_cluster_abnormal_or_monitoring_empty_in_the_console_because_global_cannot_reach_its_ports_on_ACP.md).

## Issue

Pods on one node, often a newly added one, cannot reach cluster services, while the other nodes are fine:

- A worker that was just added cannot open CoreDNS port `53`, while an older worker can.
- The log component status is abnormal because the log collection Pod (`nevermore`) fails to start on one node only, while it runs on the other nodes. This can show up right after the log storage is switched (for example from Elasticsearch to ClickHouse) and the log collector is reinstalled, but the switch is not the cause.

## Root Cause

### Cause 1: a firewall between node subnets drops Calico IPIP traffic

Both CoreDNS replicas run in one node subnet, and the new node is in another. From the new node, Pod port `1053` on one replica answers and the other replica does not. On a Calico cluster in IPIP mode, Pod-to-Pod traffic between nodes is carried as IP protocol `4` (IPIP). The firewall between the subnets does not allow IPIP, so the tunnel is dropped even where the TCP port looks open. Allowing IPIP restores communication.

A Kube-OVN cluster uses a different encapsulation (Geneve on UDP `6081`), so the rule it needs is different (Cause 2).

### Cause 2: a firewall blocks the Kube-OVN network and the kubernetes Service path from one node

The firewall on the path from the node restricts two things: the Kube-OVN network between that node and the other nodes, and access to the API server behind the `kubernetes` Service on `443`. A Pod on that node cannot reach the API server through the Service, and Pod traffic to other nodes is dropped, so DaemonSet Pods such as the log collector fail on that node only. Opening that access returns the log component to normal.

## Resolution

### Cause 1: a firewall between node subnets drops Calico IPIP traffic

Only when the CNI is Calico in IPIP mode, the new node is in a different subnet from the CoreDNS Pods, those Pods are Ready, and `1053` to the replicas is only partly open.

1. On the firewall between the node subnets, permit IP protocol `4` (IPIP) between the cluster node prefixes. Opening TCP `53` alone does not carry the tunnel.

   > **Warning:** An IPIP permission lets every encapsulated Pod flow cross, not only DNS. Make sure both CIDRs are cluster node subnets. To roll back, delete the same firewall entry. A short loss of cross-subnet Pod traffic is possible while the device commits the policy.

2. If the filtering device is host `iptables` rather than a middlebox, the equivalent on each node is below. Persist it with the mechanism the node already uses (`iptables-save` or `firewall-cmd`); to roll back, run the same commands with `-D` instead of `-I`.

   ```bash
   iptables -I INPUT -p 4 -s <other-node-cidr> -j ACCEPT
   iptables -I OUTPUT -p 4 -d <other-node-cidr> -j ACCEPT
   ```

3. The new worker should now open `1053` on every CoreDNS Pod IP and `53` on the `kube-dns` ClusterIP.

### Cause 2: a firewall blocks the Kube-OVN network and the kubernetes Service path from one node

Only when the failing Pod is on a single node, Pods on that node cannot reach the `kubernetes` Service on `443`, and the Kube-OVN tunnel between that node and the others fails while the other nodes are fine.

1. On the firewall of that node, and on any device between it and the other nodes, open the Kube-OVN tunnel traffic between all cluster nodes (Geneve UDP `6081` by default) and the API server path behind the `kubernetes` Service (the endpoint addresses and port listed in its EndpointSlice, `6443` on the control-plane nodes).

   > **Warning:** Opening ports on a node firewall widens what can reach that node. Limit the source to the cluster node prefix and save the current rule set first. To roll back, remove the rules you added or restore the saved set. A firewall reload can briefly drop existing flows on that node.

   If the node uses `firewalld`, one way that keeps the source scoped is to trust the node prefix:

   ```bash
   firewall-cmd --list-all > /root/firewalld.before.txt
   firewall-cmd --permanent --zone=trusted --add-source=<node-cidr>
   firewall-cmd --reload
   ```

2. Recreate the collector Pod on that node and confirm it stays `Running`:

   ```bash
   kubectl get pod -A -o wide | grep nevermore | grep <node-name>
   kubectl -n <namespace> delete pod <nevermore-pod-on-node>
   ```

## Diagnostic Steps

1. For a new node and CoreDNS, compare the node subnet with the subnet of the nodes running CoreDNS, and test `1053` to every replica. Partial `1053` reachability across that boundary on Calico IPIP is Cause 1:

   ```bash
   kubectl -n kube-system get pod -l k8s-app=kube-dns -o wide
   nc -vz -w 3 <coredns-pod-ip> 1053
   ```

2. For a DaemonSet Pod failing on one node only, test that node's path to the API server and to the other nodes. A timeout here while the same test passes from a healthy node is Cause 2. `kube-ovn-pinger` on the failing node logs the node-to-node and Pod-to-Pod checks that fail:

   ```bash
   kubectl get endpointslice -n default -l kubernetes.io/service-name=kubernetes
   nc -vz -w 3 <apiserver-endpoint-ip> 6443
   kubectl -n kube-system get pod -l app=kube-ovn-pinger -o wide | grep <node-name>
   kubectl -n kube-system logs <kube-ovn-pinger-pod-on-node> --tail=50
   firewall-cmd --list-all
   ```

3. If `1053` is reachable from the new node and lookups still fail only there, see [Intermittent DNS failures in Pods from a new node, NIC flapping, the KubeDNS alert or CoreDNS upstream timeouts on ACP](Intermittent_DNS_failures_in_Pods_from_a_new_node_NIC_flapping_the_KubeDNS_alert_or_CoreDNS_upstream_timeouts_on_ACP.md). If the firewall is on the node itself and blocks kubelet or metrics ports, see [Node firewall or iptables rules block kubelet 10250, metrics 10254 or control-plane traffic on ACP](Node_firewall_or_iptables_rules_block_kubelet_10250_metrics_10254_or_control_plane_traffic_on_ACP.md).
