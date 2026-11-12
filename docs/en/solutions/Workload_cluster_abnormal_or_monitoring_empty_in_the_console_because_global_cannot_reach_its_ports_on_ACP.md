---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# Workload cluster abnormal or monitoring empty in the console because global cannot reach its ports on ACP

Related articles: [New node cannot reach CoreDNS or the API server because a firewall drops tunnel traffic between nodes on ACP](New_node_cannot_reach_CoreDNS_or_the_API_server_because_a_firewall_drops_tunnel_traffic_between_nodes_on_ACP.md).

## Issue

The global console shows a workload cluster as abnormal, the container overview does not open, Grafana opened from the platform UI returns an error, or monitoring and logs stay empty after a cluster is imported. After the global worker nodes are migrated, GitOps sync or business-cluster monitoring fails. Platform Inspection cannot connect to Prometheus. Typical error text:

- Console request for a workload cluster:

  ```text
  "status": "Failure", "code": 500, Get "https://erebus.cpaas-system.svc.cluster.local/kubernetes/<cluster>/version?timeout=10s": net/http: request canceled (Client.Timeout exceeded while awaiting headers)
  ```

- Grafana opened from **Operations Center > Monitoring > Grafana**: `"reason": "Unknown"`, `"code": 500`, `Post "http://<address>:11780/clusters/<cluster>/grafana/login": dial tcp <address>:11780: i/o timeout`.
- A GitOps `ApplicationSet` shows Sync Failed while health is Healthy: `ComparisonError: Failed to load live state: failed to get cluster info for "https://<business-vip>:6443": error synchronizing cache state : Get "https://<business-vip>:6443/version?timeout=32s": dial tcp <business-vip>:6443: i/o timeout`.
- Every business cluster overview page shows the banner `监控组件异常，只能获取部分监控数据，请修复。` ("Monitoring component abnormal, only partial monitoring data can be obtained, please fix.") while the cluster status is normal.

What the global cluster has to reach on a workload cluster:

| Port | What uses it |
| --- | --- |
| `6443` | Kubernetes API. `erebus` in `cpaas-system` proxies the console to this port; Argo CD uses it for GitOps. |
| `11780` | Monitoring. `apollo` queries `http://<vip>:11780/clusters/<cluster>/prometheus/api/v1/query`; Grafana uses the same path. |
| `11781` | Logs, once log data is sunk to Elasticsearch on the workload cluster. |
| `16443` | A workload VIP port used as the API server address on some sites (Cause 4). |
| `2379` | etcd client. Required between active and standby in a disaster-recovery failover, together with `80` and `443`. |

The workload cluster also has to reach the global cluster's image registry. For an imported external cluster to show logs and monitoring, open `6443`, `11780` and `11781` (once logs are sunk to that cluster) from every global node to the imported cluster's control plane (its VIP or the control-plane node addresses), and open access from the imported cluster to the global registry.

## Root Cause

### Cause 1: erebus times out on 6443 or apollo on 11780 because the path from some global nodes is closed

`erebus` logs `timeout or abort` while calling `https://<business-vip>:6443`, and `apollo` logs `context deadline exceeded` for `http://<business-vip>:11780/clusters/<cluster>/prometheus/api/v1/query`. Every node in the workload cluster can be `Ready`, and `cpaas-system` and `kube-system` Pods on both clusters can look healthy.

The path from the global nodes to that VIP is only partly open. A check from one global node, or only from the first master, is not enough: each global node needs `6443` and `11780` to the workload VIP. `11781` is the log path on the same VIP; closing it alone does not blank the container overview. Grafana from the platform UI uses `11780` as well, so an unopened `11780` to the address in the Grafana error makes monitoring look abnormal even when the monitoring components are healthy. Restarting `apollo` does not open a port that the firewall drops.

### Cause 2: an imported cluster's monitoring endpoint fell back to the master internal IP

A cluster was imported with a public VIP, and monitoring stays empty. From the `apollo` container, TCP to the workload node on `11780` fails. `kubectl get nodes -o wide` on the workload cluster shows no public `ExternalIP` on the masters, and nodes labeled `cpaas.io/system-alb` lack it too. The Endpoints object `cluster-proxy-<cluster>` then contains the master internal IP instead of the VIP that global can route to.

Two gaps stack: the firewall from global to the workload control plane does not allow `6443`, `11780` and `11781`, and the monitoring component still targets the fallen-back internal address.

### Cause 3: Pods on newly migrated global workers cannot reach the business VIP

After the global cluster's worker nodes are migrated, GitOps applications fail with `ComparisonError: Failed to load live state ... dial tcp <business-vip>:6443: i/o timeout` (or `Failed to load target state: failed to get cluster version for cluster "https://<business-vip>:6443" ... (retried 3 times).`), or monitoring disappears for every business cluster with the banner above, and the `apollo` log shows `Prometheus query error`.

The Argo CD `argocd-gitops-application-controller-0` / `-1` Pods, or the global `apollo` Pods, run on the new global workers (role `<none>`). From a new worker, `curl -v -k https://<business-vip>:6443` and `telnet <business-vip> 6443` hang at `Trying...`; from a global master the same `curl` returns `403 Forbidden` (`User "system:anonymous" cannot get path "/"`), which proves the path from the master is open. The firewall toward the business clusters allows only the older global node addresses. Platform Pods are not pinned to masters, so after the migration they run on workers that have no path: `6443` for Argo CD, `11780` and `11781` for `apollo`.

### Cause 4: global cannot reach the workload cluster VIP on 16443

The workload cluster is reported abnormal with the `erebus ... version?timeout=10s ... Client.Timeout exceeded` error. On the global cluster, `kubectl get minfo -A | grep <cluster> | grep -vi run` lists that cluster's ModuleInfo objects (for example `logcenter`, `velero`, `kubernetes`, `prometheus`, `cosi`) as `Failed`. Restarting `erebus`, `apollo` and `archon` changes nothing, and the workload nodes and `kube-system` are healthy.

The workload nodes use `<vip>:16443` as the API server address (the `server` in `/etc/kubernetes/kubelet.conf`). From a workload node, `curl -k https://<vip>:16443` returns `403 Forbidden` for `system:anonymous`; from the global master, `curl -kv https://<vip>:16443` stops at `Trying ...` with no response. A network firewall blocks global's access to that VIP port.

### Cause 5: Platform Inspection cannot reach Prometheus because the prdb domain resolves to an external load balancer

Platform Inspection reports that Prometheus cannot be connected for a cluster, although Prometheus is healthy: the `prometheus` ModuleInfo is `Running`, `kubectl get ars -A | grep prome` shows `Synced` and `Ready`, the Prometheus, Alertmanager, Thanos query and Grafana Pods in `cpaas-system` are `Running`, and `sentry` logs no errors. `courier` connects using the address stored in `prdb`. That address is a domain name, and the domain resolves to the address of an external load balancer (for example an F5) that `courier` cannot reach. This was seen on ACP 3.14.

## Resolution

### Cause 1: erebus times out on 6443 or apollo on 11780 because the path from some global nodes is closed

1. Confirm the gap from more than one global node:

   ```bash
   nc -vz -w 3 <business-vip> 6443
   nc -vz -w 3 <business-vip> 11780
   nc -vz -w 3 <business-vip> 11781
   ```

2. Open `6443` and `11780` from every global node to the workload VIP, and `11781` as well when log views must work, using the firewall's own syntax.

   > **Warning:** Opening these ports to a source wider than the global node prefix exposes the workload API and monitoring listener. Limit the source to the global node addresses and keep the previous rule set. To roll back, delete the rule you added.

3. After `nc` succeeds from every global node, open the container overview and a monitoring page as the acceptance test.

### Cause 2: an imported cluster's monitoring endpoint fell back to the master internal IP

Only when the `cluster-proxy-<cluster>` addresses are internal master IPs and the import VIP is a different, reachable address.

1. Open `6443`, `11780` and `11781` from global to the workload control-plane addresses, including the public VIP, as in Cause 1.
2. On the global cluster, edit the monitoring ModuleInfo (`minfo`) of that workload cluster and set its access address under `spec` to the VIP that global can reach. Copy the address field from the monitoring `minfo` of a healthy imported cluster rather than guessing the key.

   ```bash
   kubectl get endpoints -A | grep cluster-proxy-<cluster-name>
   kubectl get minfo -A | grep -i <cluster-name>
   kubectl get minfo -n <namespace> <monitoring-minfo> -o yaml > /tmp/minfo.before.yaml
   ```

   > **Warning:** Saving a ModuleInfo rolls the monitoring stack for that cluster, and scrapes pause until the new Pods are Ready. Change only the address that points at the VIP. To roll back, run `kubectl apply -f /tmp/minfo.before.yaml`.

   ```bash
   kubectl edit minfo -n <namespace> <monitoring-minfo>
   ```

3. After about five minutes, TCP `11780` from `apollo` to the VIP should succeed and the monitoring page should fill in. Also confirm that the workload cluster can reach the global registry on the registry port; a closed registry path fails image pulls independently of the monitoring page.

### Cause 3: Pods on newly migrated global workers cannot reach the business VIP

Only when the failing Pod runs on a new global worker and the same `nc` succeeds from a global master.

1. Request the permanent fix: a firewall rule from every global worker node to each business cluster VIP on `6443` (GitOps) and on `11780` and `11781` (monitoring).
2. As a temporary measure, delete the affected Pods so they are scheduled again, and check where the replacements land; the scheduler can pick another new worker.

   > **Warning:** Deleting `application-controller` pauses GitOps reconciliation, and deleting `apollo` blanks monitoring pages, until the new Pod is Ready. Make sure no sync you depend on is in progress. No rollback is needed; the controller recreates the Pod.

   ```bash
   kubectl get nodes
   kubectl get pod -A -o wide | grep -E 'argocd-gitops-application-controller|apollo'
   kubectl -n <namespace> delete pod <pod-on-new-worker>
   kubectl get pod -A -o wide | grep -E 'argocd-gitops-application-controller|apollo'
   ```

### Cause 4: global cannot reach the workload cluster VIP on 16443

Only when the port fails from global and answers from inside the workload cluster. Have the network team allow the global network segment to the workload cluster segment on TCP `6443`, `11780`, `15012` and `16443`. Restarting global components does not substitute for it.

```bash
grep server /etc/kubernetes/kubelet.conf
curl -k https://<workload-vip>:16443
for p in 6443 11780 15012 16443; do nc -vz -w 3 <workload-vip> $p; done
kubectl get minfo -A | grep <cluster-name> | grep -vi run
```

Run the first two on a workload node (`403 Forbidden` for `system:anonymous` is the healthy answer) and the rest on a global master. After the firewall change every port reports connected, the ModuleInfo objects leave `Failed`, and the clusters show Normal.

### Cause 5: Platform Inspection cannot reach Prometheus because the prdb domain resolves to an external load balancer

Only when the domain in `prdb` resolves to an address `courier` cannot reach. Add a CoreDNS static record that maps that domain to the global cluster's actual API server VIP (**Host Alias** in the cluster plugin **Alauda Container Platform Cluster DNS**), then rerun the inspection.

```bash
kubectl get prdb -A -o yaml | grep -iE 'https?://'
kubectl get pod -A | grep -E 'courier|warlock'
kubectl -n <namespace> exec <courier-pod> -- nslookup <prdb-domain>
kubectl get minfo -A | grep prome
```

After the record points the domain at the global API server VIP, the inspection completes without the Prometheus fault.

## Diagnostic Steps

1. From a global node that is not the only master you usually test, probe the workload VIP. A timeout on `6443` or `11780` is Cause 1. A timeout only on `11781` blocks sunk logs and does not explain an `erebus` API timeout:

   ```bash
   nc -vz -w 3 <business-vip> 6443
   nc -vz -w 3 <business-vip> 11780
   nc -vz -w 3 <business-vip> 11781
   kubectl -n cpaas-system logs deploy/erebus --tail=50 | grep -E 'timeout or abort|6443'
   kubectl -n cpaas-system logs deploy/apollo --tail=50 | grep -E '11780|context deadline exceeded'
   ```

2. On the workload cluster, see whether the proxy target drifted to an internal IP. Internal addresses in `cluster-proxy-<cluster>` while the cluster was imported with a public VIP is Cause 2:

   ```bash
   kubectl get nodes -o wide
   kubectl get nodes -l cpaas.io/system-alb -o yaml | grep -A3 addresses
   kubectl get endpoints -A | grep cluster-proxy
   ```

3. Compare `nc` to the business VIP from a new global worker and from a master (Cause 3), and from global versus inside the workload cluster (Cause 4). Resolve the `prdb` domain from `courier` for inspection failures (Cause 5).

4. If TCP to `11780` and `11781` succeeds and the monitoring page is still empty, the port is not the problem; check the HTTPS answer on `https://<vip>:11780` and the `apollo` and `courier` logs for cache or `cluster not found` errors.
