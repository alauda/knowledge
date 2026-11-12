---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# Intermittent DNS failures in Pods from a new node, NIC flapping, the KubeDNS alert or CoreDNS upstream timeouts on ACP

Related articles: [CoreDNS fails after a node restart or lookups time out when a CoreDNS node is shut down on ACP](CoreDNS_fails_after_a_node_restart_or_lookups_time_out_when_a_CoreDNS_node_is_shut_down_on_ACP.md).

## Issue

Cluster DNS comes and goes, and the cause is outside the Corefile. Typical reports:

- From a node that was just added, access to a Service by name works one moment and fails the next. Older nodes are fine.
- Many applications log `java.net.UnknownHostException` at the same time, together with lost heartbeats (`DiscoveryClient was unable to send heartbeat`), ZooKeeper `SessionExpiredException` and database `Communications link failure`. Node monitoring has gaps in the same window.
- An alert says `KubeDNS(<coredns-pod-ip>:9153)` is unavailable, and it clears by itself almost immediately.
- On a global cluster whose CNI is flannel with galaxy, every console page returns `504` or an internal server error page (`服务器内部错误`), `GET /console-platform/api/v1/token/login` returns `500`, and one `tke-platform-api` replica in `cpaas-system` is in `CrashLoopBackOff`.

CoreDNS on ACP 4.x is the `coredns` Deployment in `kube-system` (Pod label `k8s-app=kube-dns`). The CoreDNS Pods listen on `1053` inside the Pod network, use the node `/etc/resolv.conf` as their upstream list, and expose metrics on `9153`.

## Root Cause

### Cause 1: Service names fail intermittently only from a newly added node

After a node is added, lookups of Service names from that node fail intermittently while older nodes are fine. CoreDNS has not yet recognized the newly added node; restarting CoreDNS restores normal access. If the new node cannot open `1053` to every CoreDNS Pod, the cause is a firewall between the node subnets instead (see Diagnostic Steps).

### Cause 2: physical NICs flapping cause UnknownHostException bursts with connection drops

When the physical NICs of the cluster machines go up and down, each flap interrupts DNS queries and every other connection that crosses the NIC. Several systems lose name resolution and connections in the same minutes, monitoring for the affected hosts shows gaps in CPU, memory and Pod count, and nodes drop out of the cluster count. The CNI and the operating system show nothing abnormal.

A long node `search` list makes each interruption worse: with six suffixes on the node, several of them cluster-style, every short name is tried with each suffix in turn. Removing the `search` entries from the node `/etc/resolv.conf` stops the DNS failures, but connection drops continue until the NICs or links are repaired.

### Cause 3: the KubeDNS :9153 unavailable alert clears by itself

The alert names the CoreDNS metrics target (`<coredns-pod-ip>:9153`). By the time anyone looks, it has cleared and CoreDNS is serving. A short network fluctuation can make a single query or scrape time out (the CoreDNS log for the window can show a request to port `53` timing out). A custom alert rule whose trigger timing does not match the platform's own alert behavior fires on a single missed scrape and reports every such blip.

### Cause 4: CoreDNS cannot reach its upstream on a flannel and galaxy cluster

One `tke-platform-api` replica in `cpaas-system` is `CrashLoopBackOff` (`0/1`, `Exit Code: 2`, more than 1,800 restarts) with events `Readiness probe failed: Get "https://<pod-ip>:9443/healthz/ping": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)`. The CoreDNS log repeats:

```text
[ERROR] plugin/errors: 2 <name> HINFO: read udp <coredns-pod-ip>:<port>-><upstream-dns>:53: i/o timeout
```

The `HINFO` query is the probe CoreDNS sends at startup to detect forwarding loops, so its timeout means the CoreDNS Pod cannot reach the upstream through the Pod network. Node load is normal. The cluster network is flannel with galaxy (no `ovn` or `calico` Pods), and the `flannel` and `galaxy-daemonset` Pods in `kube-system` all show `1/1 Running`. Restarting the flannel and galaxy Pods restores the Pod network and platform access; what was wrong in the Pod network before the restart was not determined.

## Resolution

### Cause 1: Service names fail intermittently only from a newly added node

Only when the failures started with the new node, other nodes resolve normally, and the `1053` check in Diagnostic Steps passes. Restart CoreDNS.

> **Warning:** A rollout restart replaces the CoreDNS Pods one by one; lookups can stall briefly while a Pod is not Ready. Make sure more than one CoreDNS replica is Ready. No rollback is needed; the Deployment spec does not change.

```bash
kubectl -n kube-system rollout restart deploy/coredns
kubectl -n kube-system rollout status deploy/coredns
kubectl exec -n <namespace> <pod-on-new-node> -- nslookup <service>.<namespace>.svc.cluster.local
```

Run the last command several times; every attempt should answer.

### Cause 2: physical NICs flapping cause UnknownHostException bursts with connection drops

Only when kernel logs or the switch show the node NICs going up and down in the failure window.

1. Repair the flapping NICs or links on the underlay. Redundant (dual-link) uplinks work as a stopgap until the repair.
2. As a DNS-side mitigation, comment out the `search` line in the node `/etc/resolv.conf` on all nodes, then recreate the affected Pods so their resolver file no longer carries those suffixes. If NetworkManager or DHCP writes the file, remove the search domains at that source too.

   > **Warning:** Removing the node `search` line changes how short names resolve for host processes and for every Pod created afterwards; names that relied on a site suffix stop expanding. Back up the file on each node and confirm the applications use full names for site domains. To roll back, restore the backup and recreate the Pods.

   ```bash
   cp -a /etc/resolv.conf /root/resolv.conf.before
   sed -i 's/^search /# search /' /etc/resolv.conf
   grep -n search /etc/resolv.conf
   ```

### Cause 3: the KubeDNS :9153 unavailable alert clears by itself

If the CoreDNS Pods did not restart and the CoreDNS logs show no sustained errors in the window, treat the alert as a transient and give the custom rule a one-minute threshold, so that it fires only when the target stays down for one minute. In a Prometheus rule that is the `for` field.

> **Warning:** A longer threshold delays real alerts by the same amount. Save the rule first and agree on the threshold with the alert owner. To roll back, apply the saved rule.

```bash
kubectl get prometheusrule -A | grep -iE 'dns|coredns'
kubectl -n <namespace> get prometheusrule <rule> -o yaml > /tmp/<rule>.before.yaml
kubectl -n <namespace> edit prometheusrule <rule>
```

```yaml
- alert: <kube-dns-alert-name>
  expr: <existing expression>
  for: 1m
```

If the alert keeps firing with a one-minute threshold, it is no longer a timing artifact: collect CoreDNS logs and node network counters for the window and check Cause 2.

### Cause 4: CoreDNS cannot reach its upstream on a flannel and galaxy cluster

Only when the CoreDNS log shows the upstream `i/o timeout`, node resources are normal, and the cluster CNI is flannel with galaxy. Restart the flannel and galaxy Pods, then check CoreDNS and `tke-platform-api` again.

> **Warning:** Restarting the CNI Pods interrupts Pod networking on each node while its Pods are recreated, and new Pods cannot get networking meanwhile. Keep console or SSH access to the masters that does not depend on the platform UI, and use a window in which a short Pod network interruption is acceptable. No rollback is needed; the DaemonSets recreate the Pods.

```bash
kubectl get po -A -o wide | grep -E 'ovn|calico'
kubectl -n kube-system get ds | grep -E 'flannel|galaxy'
kubectl -n kube-system rollout restart ds/<flannel-daemonset> ds/<galaxy-daemonset>
kubectl -n kube-system rollout status ds/<flannel-daemonset>
kubectl -n kube-system rollout status ds/<galaxy-daemonset>
kubectl -n kube-system logs <coredns-pod> --tail=20
kubectl -n cpaas-system get pod | grep tke-platform-api
```

After the restart the platform is accessible again.

## Diagnostic Steps

1. For a new node, query a Service FQDN repeatedly from a Pod on that node, and check that the node reaches every CoreDNS Pod on `1053`. Failures only from that node with `1053` open are Cause 1. `1053` closed to some replicas points at a firewall between node subnets; see [New node cannot reach CoreDNS or the API server because a firewall drops tunnel traffic between nodes on ACP](New_node_cannot_reach_CoreDNS_or_the_API_server_because_a_firewall_drops_tunnel_traffic_between_nodes_on_ACP.md).

   ```bash
   for i in $(seq 1 20); do kubectl exec -n <namespace> <pod-on-new-node> -- nslookup <service>.<namespace>.svc.cluster.local >/dev/null 2>&1 && echo ok || echo fail; done
   kubectl -n kube-system get pod -l k8s-app=kube-dns -o wide
   nc -vz -w 3 <coredns-pod-ip> 1053
   ```

2. For bursts of `UnknownHostException` with connection drops, look for link flaps and test Pod-to-Pod across nodes. A capture on the business node narrows which hop drops (Cause 2):

   ```bash
   journalctl -k --since "<start>" --until "<end>" | grep -iE 'link (is )?(up|down)'
   ip -s link show <nic>
   kubectl exec -n <namespace> <pod> -- ping -c 5 <pod-ip-on-other-node>
   tcpdump -i <nic> host <peer-ip> and port <port> -C 100 -W 5 -w /tmp/capture.pcap
   ```

3. For the `:9153` alert, compare the alert time with CoreDNS restarts and logs, and read the rule that fired (Cause 3):

   ```bash
   kubectl -n kube-system get pod -l k8s-app=kube-dns -o wide
   kubectl -n kube-system logs -l k8s-app=kube-dns --since=1h | grep -iE 'timeout|error'
   ```

4. For console errors with a crash-looping `tke-platform-api`, read the CoreDNS log and identify the CNI. `HINFO ... i/o timeout` on a flannel and galaxy cluster is Cause 4:

   ```bash
   kubectl -n kube-system logs -l k8s-app=kube-dns --tail=50 | grep -E 'HINFO|i/o timeout'
   kubectl -n kube-system get pod -o wide | grep -E 'flannel|galaxy|ovn|calico'
   kubectl top nodes
   ```
