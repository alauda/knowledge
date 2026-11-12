---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# CoreDNS fails after a node restart or lookups time out when a CoreDNS node is shut down on ACP

Related articles: [Intermittent DNS failures in Pods from a new node, NIC flapping, the KubeDNS alert or CoreDNS upstream timeouts on ACP](Intermittent_DNS_failures_in_Pods_from_a_new_node_NIC_flapping_the_KubeDNS_alert_or_CoreDNS_upstream_timeouts_on_ACP.md).

## Issue

Cluster DNS is down or degraded after a change to the nodes, and the cause is outside the Corefile. Typical reports:

- After the nodes restarted, CoreDNS and other basic components in the global cluster are all abnormal.
- A node that ran CoreDNS was shut down. The CoreDNS Pod restarted and application lookups timed out for a while. The question is why, and which platform components a node restart can affect.
- CoreDNS was scaled from 2 to 4 replicas with `kubectl scale`, and some time later it is back to 2.

CoreDNS on ACP 4.x is the `coredns` Deployment in `kube-system` (Pod label `k8s-app=kube-dns`), configured by the ConfigMap `cpaas-coredns`. The CoreDNS Pods use the `/etc/resolv.conf` of the node they run on as their upstream list, and `9153` is their metrics port.

## Root Cause

### Cause 1: the node /etc/resolv.conf is empty after a restart, so CoreDNS has no upstream

The default Corefile forwards with `forward . /etc/resolv.conf`. When `/etc/resolv.conf` on the node exists but is empty (no `nameserver` line), CoreDNS has no upstream and fails to start; CoreDNS normally logs `no nameservers found` in this case. Components that depend on DNS fail with it.

The file can be reset to empty when the node restarts by tooling outside the platform, for example on the IaaS side (cloud-init, DHCP, or image tooling). Restoring the file contents returns cluster DNS to normal.

### Cause 2: a node running CoreDNS is shut down and lookups time out until its endpoint is removed

When a node goes down abruptly, kubelet cannot report that it is leaving. The endpoint controller removes that node's Pods from the `kube-dns` endpoints only after the node is marked `NotReady`, so there is a delay. During it, DNS caching and connection reuse in the clients keep sending queries to the offline replica until the cache expires or the connection closes, and lookups time out.

Platform components are deliberately not pinned to specific nodes or to the masters: a pinned Pod cannot fail over when its node fails, and master resources differ between clusters, so heavy components there could destabilize the masters. The components whose node going down affects the whole cluster are:

| Release | Component (Deployment) | Effect when its node goes down |
| --- | --- | --- |
| 3.8 | `cpaas-system/lcn-ccm-alb` | business traffic entering and leaving the cluster |
| 3.16 | the `*-alb`, `*-clb`, `*-lb` Deployments in `cpaas-system` | business traffic entering and leaving the cluster |
| 3.8, 3.16 | `cpaas-system/coredns` | in-cluster name resolution |

On 4.x CoreDNS is `kube-system/coredns`. `raven` and `calico-kube-controllers` affect only changes such as Pod creation and deletion; running workloads are not affected. When every business team uses its own ALB on hosts it manages, CoreDNS is effectively the only shared component to plan around.

### Cause 3: CoreDNS replica changes made with kubectl are reverted

The CoreDNS Deployment is managed by an upper-layer platform controller, which overwrites direct edits to the Deployment. A replica count set with `kubectl scale deploy` therefore returns to the earlier value after a while. A replica count changed through the platform UI persists.

## Resolution

### Cause 1: the node /etc/resolv.conf is empty after a restart, so CoreDNS has no upstream

Only when `/etc/resolv.conf` on the node running the CoreDNS Pod is empty (no `nameserver` line).

1. Restore the file contents, from your own backup or from a healthy node of the same cluster with the same resolvers.
2. Recreate the CoreDNS Pods. A Pod's resolver file is written when the Pod is created, so a container restart alone does not pick up the restored file.

> **Warning:** Writing the wrong resolvers into `/etc/resolv.conf` breaks external name resolution for the node and for CoreDNS, and recreating the CoreDNS Pods briefly delays cluster lookups. Make sure the nameservers you restore are the ones the cluster used before (compare with a healthy node). To roll back, restore the previous file and recreate the Pods again.

```bash
cat /etc/resolv.conf
cp -a /etc/resolv.conf /root/resolv.conf.empty
scp <healthy-node>:/etc/resolv.conf /etc/resolv.conf
kubectl -n kube-system delete pod -l k8s-app=kube-dns
kubectl -n kube-system get pod -l k8s-app=kube-dns -o wide -w
```

3. Ask the owner of the node image or IaaS why the file is emptied on restart; otherwise the next reboot repeats it.

### Cause 2: a node running CoreDNS is shut down and lookups time out until its endpoint is removed

No configuration change fixes a past event; the timeouts end once the endpoint is removed or the node returns. For planned work:

1. Use a change process: report node restarts or decommissioning to the cluster administrator and announce them to the other business teams on the cluster beforehand. Keep the platform components unpinned so they can fail over.
2. Drain the node before a planned shutdown. Eviction removes the CoreDNS Pod from the endpoints before the node goes away, instead of waiting for `NotReady`.

> **Warning:** Draining evicts every non-DaemonSet Pod on the node, and Pods with no other replica are unavailable until they start elsewhere. Make sure at least one other CoreDNS replica is Ready on another node. To roll back, run `kubectl uncordon <node>`; evicted Pods are not moved back automatically.

```bash
kubectl -n kube-system get pod -l k8s-app=kube-dns -o wide
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
```

### Cause 3: CoreDNS replica changes made with kubectl are reverted

Set the replica count in the platform UI rather than with `kubectl scale`, then confirm that the count holds:

```bash
kubectl -n kube-system get deploy coredns -o jsonpath='{.spec.replicas}{"\n"}'
```

## Diagnostic Steps

1. Check CoreDNS state and the previous container log:

   ```bash
   kubectl -n kube-system get pod -l k8s-app=kube-dns -o wide
   kubectl -n kube-system describe pod -l k8s-app=kube-dns | grep -iE 'Reason|Restart|Ready'
   kubectl -n kube-system logs -l k8s-app=kube-dns --previous --tail=50
   ```

2. On the node of a failing CoreDNS Pod, read the resolver file. No `nameserver` line is Cause 1:

   ```bash
   cat /etc/resolv.conf
   grep -c '^nameserver' /etc/resolv.conf
   ```

3. Compare the time of the lookup failures with node events. A CoreDNS restart and lookup timeouts right after its node was shut down is Cause 2:

   ```bash
   kubectl get events -A --field-selector reason=NodeNotReady --sort-by=.lastTimestamp
   kubectl -n kube-system get endpointslice -l kubernetes.io/service-name=kube-dns -o wide
   ```

4. A replica count that returns to the old value after `kubectl scale` is Cause 3.
