---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# Node firewall or iptables rules block kubelet 10250, metrics 10254 or control-plane traffic on ACP

## Issue

A firewall or extra iptables rules on the cluster nodes themselves (not a firewall between sites) break part of the cluster. Typical reports:

- Web CLI to a node fails, and logs of Pods on that node cannot be viewed in the platform. The node is still `Ready` and scheduling works. The Web CLI session shows the banner `远程终端连接已断开` (remote terminal disconnected) and:

  ```text
  warning: couldn't attach to pod/nsenter-<id>, falling back to streaming logs: Internal error occurred: error sending request: Post "https://<node-ip>:10250/attach/cpaas-system/nsenter-<id>/nsenter?input=1&output=1&tty=1": dial tcp <node-ip>:10250: connect: no route to host
  Error from server: Get "https://<node-ip>:10250/containerLogs/cpaas-system/nsenter-<id>/nsenter": dial tcp <node-ip>:10250: connect: no route to host
  ```

- Container services on a two-node deployment look hung with no error, one of the nodes is not displayed, and container logs cannot be viewed.
- `kube-ovn-pinger` does not start on some nodes of a new cluster, and `kubectl` on the master cannot fetch logs from those nodes, while the nodes show `Ready`.
- Platform inspection, check "Status of monitor related component", returns Warning with `Availability of service(cpaas-system/alb2-cpaas-system) for monitoring component to get Metrics is not working properly.`, and the same for the ingress-nginx controller `-metrics` Services. No functional impact is visible.
- The production API server is down, and traffic from one master to the other masters does not pass.
- Alerts fire after iptables rules were added to the `raw` table to stop outside access to the nodes, and they do not clear at once after the rules are removed.

## Root Cause

### Cause 1: dial tcp <node-ip>:10250: connect: no route to host

Exec (Web CLI) and log retrieval are API server to kubelet connections on `10250`. From the global cluster and from other nodes, TCP to `10250` on the affected node fails (`telnet: Unable to connect to remote host: No route to host`), while `telnet <node-ip> 10250` on the node itself connects. In the other direction the node reaches the API server on `6443`, so kubelet keeps reporting status and the node stays `Ready`.

The block can be:

- iptables rules on the node that reject all external access to `10250`. `no route to host` while the host is up is what a `REJECT` with `icmp-host-prohibited` returns, which is the reject type firewalld uses by default.
- a network policy outside the node that has not been fully opened from the masters to the nodes. Then `telnet <node-ip> 10250` from the master stays at `Trying ...` instead of failing fast, and a `kube-ovn-pinger` on a working node reports `loss count 3` for pings to the pinger Pods and the node addresses of the affected nodes.

### Cause 2: kube-ovn-pinger still cannot reach the API server Service after 10250 is open

After `10250` is opened, the logs become readable and show `kube-ovn-pinger` failing to connect to the API server Service, while TCP to the API VIP on `6443` works from the same nodes. Restarting the Kube-OVN `ovs-ovn`, `kube-ovn-cni` and `kube-ovn-pinger` Pods on those nodes restores them; why the Service path failed before the restart was not determined.

A `curl` from a container on such a node that returns `curl: (60) SSL certificate problem: unable to get local issuer certificate` for `https://<service-ip>:443` or `https://<master-ip>:6443` shows that the path is reachable: the error comes after the TCP and TLS exchange started, and only means `curl` has no CA bundle for the cluster certificate.

### Cause 3: monitoring cannot scrape metrics on 10254 because the node firewall does not allow it

In the workload cluster VMUI, the job `<name>-ingress-nginx-controller-metrics` shows `up` at `0`. The controller Pods are `1/1 Running`, and the `*-controller-metrics` Services are `ClusterIP` on `10254/TCP`. From another node, port `80` of the Pod IP returns nginx `404 Not Found`, but `curl <pod-ip>:10254/metrics` returns `curl: (7) Failed to connect to <pod-ip> port 10254 after 0 ms: Could not connect to server`. `curl 127.0.0.1:10254/metrics` inside the Pod returns data, and so does the same request from the Pod's own node.

On the node, `systemctl status firewalld` is `active (running)` and `firewall-cmd --list-all` shows zone `public (active)` with no `10254` in its port list. The node firewall does not allow `10254/tcp`, so the monitoring component cannot reach the metrics endpoints from outside the node. (The `alb2-cpaas-system` warning in the same inspection can appear while its VMUI job still returns data.)

### Cause 4: a firewall enabled on the masters blocks master-to-master traffic and the API server goes down

A firewall enabled on the masters blocks the traffic between them, the API server becomes unavailable, and traffic from one master to the others does not pass.

### Cause 5: iptables raw table rules raise alerts and the cluster recovers slowly after their removal

Rules in the `raw` table `PREROUTING` chain see every packet entering the node before connection tracking and before the kube-proxy and CNI chains, including Service, tunnel and Pod traffic. Rules added there to block outside access to in-cluster services also disturb the cluster, and high-load alerts fire. After the rules are removed, the cluster returns to normal gradually rather than at once.

Restricting all ports on all nodes with iptables without affecting the cluster has no product solution. To restrict access to workload services, use **Network > Network Policies** in the Container Platform view; network policies cover the ports that workloads expose, not every port on the node.

## Resolution

### Cause 1: dial tcp <node-ip>:10250: connect: no route to host

Only when `10250` fails from other nodes, answers locally, and the node is `Ready`.

- **Block outside the node** (network policy): open `10250` from the control-plane nodes to every node.
- **Block on the node**: find the rule that rejects `10250`, or rejects everything after an allow list, and remove only that rule by line number.

  > **Warning:** Flushing a whole table (`iptables -F`) also removes the kube-proxy and CNI chains until those components re-sync, which interrupts Service and Pod traffic on the node. Deleting the wrong rule can open the node wider than intended. Save the rules first and identify the rule by line number. To roll back, run `iptables-restore < /root/iptables.before`.

  ```bash
  iptables-save > /root/iptables.before
  iptables -L INPUT -n --line-numbers | grep -E 'REJECT|DROP|10250'
  iptables -D INPUT <line-number>
  ```

- **firewalld on the node**: add the port, scoped to the cluster node range.

  > **Warning:** A rich rule with a source range that is too wide exposes the kubelet API on that node. Save the current configuration first. To roll back, run the same command with `--remove-rich-rule` and reload.

  ```bash
  firewall-cmd --state
  firewall-cmd --list-all > /root/firewalld.before.txt
  firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="<cluster-node-cidr>" port port="10250" protocol="tcp" accept'
  firewall-cmd --reload
  ```

Persist an iptables change with the mechanism the node already uses, then test from a master and from the global cluster:

```bash
nc -vz -w 3 <node-ip> 10250
kubectl logs -n <namespace> <pod-on-node> --tail=5
```

### Cause 2: kube-ovn-pinger still cannot reach the API server Service after 10250 is open

Only after Cause 1 is fixed and `kube-ovn-pinger` on the same nodes still logs API server Service connection failures while the VIP on `6443` answers. Restart the three Kube-OVN Pods on each affected node.

> **Warning:** Restarting `ovs-ovn` and `kube-ovn-cni` on a node interrupts Pod networking on that node until they are Ready again, and new Pods cannot get networking meanwhile. Do one node at a time. No rollback is needed; the DaemonSets recreate the Pods.

```bash
kubectl -n kube-system get pod -o wide | grep -E 'ovs-ovn|kube-ovn-cni|kube-ovn-pinger' | grep <node-name>
kubectl -n kube-system delete pod <ovs-ovn-pod> <kube-ovn-cni-pod> <kube-ovn-pinger-pod>
kubectl -n kube-system get pod -o wide | grep <node-name>
```

### Cause 3: monitoring cannot scrape metrics on 10254 because the node firewall does not allow it

Only when `10254/metrics` answers inside the Pod and on its node, and fails from another node. Allow `10254` on the node firewall from the addresses the monitoring component scrapes from.

> **Warning:** Opening a port on the node firewall widens what can reach the node. Limit the source to the cluster range and save the current configuration. To roll back, remove the rule (`--remove-rich-rule` with the same text) and reload.

```bash
firewall-cmd --list-all > /root/firewalld.before.txt
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="<cluster-cidr>" port port="10254" protocol="tcp" accept'
firewall-cmd --reload
curl -s http://<node-ip>:10254/metrics | head -5
```

If the site's rule is simply to open the port in the active zone, the plain form is `firewall-cmd --permanent --zone=public --add-port=10254/tcp` followed by `firewall-cmd --reload` (roll back with `--remove-port=10254/tcp`). Afterwards, `up` for the `-controller-metrics` job in VMUI should return to `1`; re-run the inspection.

### Cause 4: a firewall enabled on the masters blocks master-to-master traffic and the API server goes down

Only when the firewall on the masters is active and master-to-master traffic fails. Restore the traffic between the masters: either return the firewall to its previous state, or allow the control-plane ports between the master addresses. In general Kubernetes terms these are `6443` (API server), `2379` and `2380` (etcd) and `10250` (kubelet), plus the CNI traffic between nodes; the full list for ACP nodes is the communication matrix in the installation documentation.

> **Warning:** Rules on a broken control plane are added node by node; keep console or out-of-band access to each master and agree with the security owner on the option used. To roll back, remove the added rules.

```bash
systemctl is-active firewalld
firewall-cmd --list-all
for p in 6443 2379 2380 10250; do nc -vz -w 3 <other-master-ip> $p; done
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="<master-cidr>" accept'
firewall-cmd --reload
```

If the site decides to turn the firewall off instead:

> **Warning:** Stopping and disabling firewalld removes every rule it enforced on that master, now and after reboot. Only when the security owner accepts an unfiltered node and `firewall-cmd --list-all` was saved. To roll back, run `systemctl enable --now firewalld`, which re-applies the saved permanent configuration.

```bash
systemctl stop firewalld
systemctl disable firewalld
```

Then check etcd and the API server:

```bash
kubectl -n kube-system get pod -l component=etcd -o wide
kubectl get --raw='/readyz?verbose' | tail -5
```

### Cause 5: iptables raw table rules raise alerts and the cluster recovers slowly after their removal

Only when the alerts started with rules added to the `raw` table. Remove those rules; expect recovery to be gradual.

> **Warning:** Removing the rules restores outside access that the security team wanted to block. Save the table and agree with the security owner. To roll back, run `iptables-restore -T raw < /root/iptables-raw.before` (or re-add the rules), which brings the alerts back.

```bash
iptables-save -t raw > /root/iptables-raw.before
iptables -t raw -S
iptables -t raw -D PREROUTING <rule-spec-from-the-list-above>
```

Use network policies to restrict access to workload services instead.

## Diagnostic Steps

1. Test the port from several directions. Failing from other nodes while answering locally means a filter on the path or on the node:

   ```bash
   nc -vz -w 3 <node-ip> 10250
   ssh <node> 'curl -sk https://127.0.0.1:10250/healthz; echo'
   kubectl get node <node-name>
   ```

2. List what filters the node. Look for rules that are not from kube-proxy (`KUBE-`), Calico (`cali-`) or Kube-OVN (`ovn`):

   ```bash
   systemctl is-active firewalld
   iptables-save | grep -vE 'KUBE-|cali-|ovn' | grep -E 'REJECT|DROP'
   iptables -t raw -S
   ```

3. For a metrics alert, compare local and remote scrapes. Run the second `curl` from a different node and again on the Pod's own node. `Could not connect to server` from the other node, data on the own node, and no `10254` in `firewall-cmd --list-all` is Cause 3:

   ```bash
   kubectl -n <namespace> exec <ingress-pod> -- curl -s 127.0.0.1:10254/metrics | head -3
   curl -s --max-time 3 http://<pod-ip>:10254/metrics | head -3
   firewall-cmd --list-all | grep 10254
   ```

4. Map the findings:

   - Logs and Web CLI fail with `no route to host` on `10250`, node `Ready`: Cause 1.
   - `10250` open, `kube-ovn-pinger` still cannot reach the API server Service: Cause 2.
   - `kube-ovn-pinger` `CrashLoopBackOff` on every node of a new cluster with `failed to get self pod ... context deadline exceeded`, no rejecting rule, bonded physical NICs: not a firewall; see [Cross-node Pod traffic fails on the Kube-OVN Geneve overlay because of UDP 6081, TX offload or MTU on ACP](Cross_node_Pod_traffic_fails_on_the_Kube-OVN_Geneve_overlay_because_of_UDP_6081_TX_offload_or_MTU_on_ACP.md).
   - Metrics target down, `10254` answers locally only: Cause 3.
   - API server down, master-to-master traffic blocked, firewall active: Cause 4.
   - Alerts began with `raw` table rules: Cause 5.
   - The global cluster cannot reach a workload cluster's VIP ports: see [Workload cluster abnormal or monitoring empty in the console because global cannot reach its ports on ACP](Workload_cluster_abnormal_or_monitoring_empty_in_the_console_because_global_cannot_reach_its_ports_on_ACP.md).
