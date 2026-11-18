---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.16
  - 3.18
  - 4.0
  - 4.1
  - 4.2
  - 4.3
---

# Monitoring pages stay empty because courier-api or apollo holds a stale cluster cache on ACP

## Issue

The monitoring page of a workload cluster, the cluster overview, or Grafana shows no data, or the overview shows the banner that the monitoring component is abnormal. Prometheus or VictoriaMetrics on that workload cluster is healthy, vmui inside the cluster has series, and port 11780 on the cluster VIP answers. Typical situations:

- A newly created or newly attached cluster never loads monitoring, even with ports 11780 and 11781 open.
- After Prometheus was reinstalled on a workload cluster, none of that cluster's monitoring data is displayed, model inference monitoring included, while monitoring of the `global` cluster is normal.
- In the browser developer tools (F12, **Network**) the failing request returns HTTP 500 with `"message": "get cluster <cluster-name> from cache error"`.
- An inspection or monitoring API call fails with `bad_response: invalid character '<' looking for beginning of value`.
- After a disaster-recovery switchover of the `global` cluster, every business cluster's Prometheus is shown as not deployed although it is running.
- A severe alert for an expired certificate stays up after the certificate object was deleted.

The `global` components that serve these pages are `courier`, `courier-api`, and `apollo` in `cpaas-system`.

Related article: [Monitoring pages return 502 or context deadline exceeded because port 11780 on the cluster VIP is blocked on ACP](Monitoring_pages_return_502_or_context_deadline_exceeded_because_port_11780_on_the_cluster_VIP_is_blocked_on_ACP.md) covers the network path; check it first if a `curl` to port 11780 on the VIP times out.

## Root Cause

### Cause 1: courier-api has a stale cluster list

`courier-api` logs a cache error, vmui already has series, the VictoriaMetrics Pods are `Running` and not CPU-bound, and a newly built or newly attached cluster does not load in the UI. `courier-api` has not picked up the new cluster. The same applies after the Prometheus of a workload cluster is reinstalled: the cluster's monitoring stays empty until `courier-api` is restarted, while `global` monitoring is unaffected. Why `courier-api` does not pick up the reinstalled backend on its own is not known. A `config-reloader` line such as `Post "http://localhost:8429/-/reload": dial tcp [::1]:8429: connect: connection refused` can appear at the same time; it is a missed reload, not the reason the cluster list is stale.

### Cause 2: the response body is HTML, not JSON

`bad_response: invalid character '<' looking for beginning of value` means the component expected JSON and received an HTML page. Two sources are known:

- `courier` is `Unauthorized` when it lists the `clusters` resource on the `global` cluster (for example after `global` worker nodes were moved), so the inspection never loads a real metrics URL.
- `apollo` logs the same parse error while querying Prometheus, for example for `container_memory_working_set_bytes` and CPU utilization. A self-managed Prometheus Deployment in `cpaas-system` whose labels do not match the platform release can sit beside the real backend; the `up` query in the Prometheus UI still succeeds.

### Cause 3: a certificate alert remains after the expired certificate object was deleted

The managed cluster works, but the platform still shows a severe alert for an expired certificate whose object has already been deleted. Residual collection data held by `courier` keeps the alert up; `courier` also refreshes this state on its own in about 4 hours. When the `certificate_expires_time` series for the deleted object is still returned by VictoriaMetrics, the stale data is held by Cluster Enhancer instead, and restarting `courier` does not remove it.

### Cause 4: apollo cannot find the cluster in its cache

The `global` `apollo` keeps a cache of clusters. When the cache lacks a cluster, every monitoring request for it fails. The `apollo` log shows lines such as:

```text
ERROR Get cluster from cache error {"error": "cluster <cluster-name> not found"}
ERROR New manager error {"error": "cluster <cluster-name> not found"}
Parse cluster error {"error": "get cluster <cluster-name> from cache error"}
cache.cache/cluster List clusters error, sleep 15s, unauthorized
```

for requests such as `/v2/metrics/<cluster>/query`, `/v2/metrics/<cluster>/indicators`, or `/platform/monitoring.alauda.io/v1beta1/clusters/<cluster-name>/metrics`. A line such as `json: cannot unmarshal array into Go struct field jwtToken.aud of type string` can appear alongside them.

The stale cache shows up for a newly created cluster, right after monitoring was deployed (the page does not load even after a refresh), and after a `global` primary-to-standby switchover. It is easily mistaken for a missing firewall rule when the clusters are in separate network segments opened per port. The exact reason the cache entry goes stale is not known; restarting `apollo` rebuilds it.

On a standby `global` cluster that is not serving traffic, an abnormal monitoring status is expected; check the primary.

## Resolution

### Cause 1: courier-api has a stale cluster list

> **Warning:** Recreating `courier-api` fails in-flight monitoring and inspection calls until the new Pod is `Ready`. Do this only when the `courier-api` log shows the cache error, or when a workload cluster's monitoring stays empty after its Prometheus was reinstalled and the Prometheus Pods there are `Running`, preferably in a quiet period if this `global` cluster serves many workload clusters. The Deployment recreates the Pod; nothing needs rolling back if the new Pod is healthy.

```bash
kubectl -n cpaas-system get pod -o wide | grep courier-api
kubectl -n cpaas-system delete pod <courier-api-pod>
```

Wait until the replacement is `Ready`, then reload the cluster in the UI. If the `courier` log shows it still serves the old cluster list, recreate `courier` as well, after `courier-api` is back, not at the same time:

> **Warning:** Recreating `courier` fails cluster-list calls until the new Pod is `Ready`. The controller recreates the Pod; do not change the Pod template.

```bash
kubectl -n cpaas-system delete pod <courier-pod>
```

### Cause 2: the response body is HTML, not JSON

1. Read which component receives the HTML before restarting anything:

   ```bash
   kubectl -n cpaas-system logs deploy/courier --tail=200 | grep -Ei 'unauthorized|clusters'
   kubectl -n cpaas-system logs deploy/apollo --tail=200 | grep -F "bad_response"
   ```

2. If `courier` is denied listing `clusters`, recreate its Pod so it rebuilds its cache.

   > **Warning:** In-flight inspection calls fail until the new `courier` Pod is `Ready`. Do this only when the log shows `Unauthorized` on `clusters`. The controller recreates the Pod.

   ```bash
   kubectl -n cpaas-system delete pod <courier-pod>
   ```

3. If `apollo` logs `bad_response` against Prometheus, recreate the `apollo` Pod.

   > **Warning:** Recreating `apollo` interrupts monitoring queries for every cluster until the Pod is `Ready`. Do this only after the log shows `bad_response` against Prometheus. The controller recreates the Pod; no data is deleted.

   ```bash
   kubectl -n cpaas-system delete pod <apollo-pod>
   ```

### Cause 3: a certificate alert remains after the expired certificate object was deleted

1. Run the alert expression in the VictoriaMetrics UI. If no `certificate_expires_time` series is returned for the deleted object while the alert still shows it, the stale state is in `courier`.
2. Restart `courier`, or wait about 4 hours for it to refresh on its own.

   > **Warning:** Deleting the `courier` Pod fails in-flight monitoring and inspection calls and pauses notification sends and the active-alert scrape until the replacement is `Ready`. Do this only when the expired certificate object is already gone and the alert still fires. The controller recreates the Pod.

   ```bash
   kubectl -n cpaas-system get pod | grep courier
   kubectl -n cpaas-system delete pod <courier-pod>
   ```

3. If the series for the deleted object is still returned, restarting `courier` alone does not help; restart the Cluster Enhancer components `cluster-enhancer-controller` and `cluster-enhancer-apiserver` instead:

   > **Warning:** Certificate monitoring and etcd-backup status for that cluster are unavailable until both Pods are `Ready`. Do this only when the VictoriaMetrics UI still returns the series for a deleted certificate. The Deployments recreate the Pods.

   ```bash
   kubectl get deploy -A | grep cluster-enhancer
   kubectl -n <namespace> rollout restart deploy/<cluster-enhancer-controller-deployment> deploy/<cluster-enhancer-apiserver-deployment>
   ```

### Cause 4: apollo cannot find the cluster in its cache

1. Read the `apollo` log on the `global` cluster:

   ```bash
   kubectl -n cpaas-system get pod | grep apollo
   kubectl -n cpaas-system logs <apollo-pod> --tail=300 | grep -Ei 'cache|not found|cluster'
   ```

2. After a disaster-recovery switchover, first make sure the platform access domain resolves to the standby cluster VIP on the hosts, then check it from inside the cluster:

   ```bash
   kubectl exec -it -n cpaas-system deployments/sentry -- nslookup <platform-domain> $(kubectl get services -n kube-system kube-dns -o jsonpath='{.spec.clusterIP}')
   ```

   If the in-cluster answer is still the old VIP, recreate the `coredns` Pods in `kube-system` and repeat until it resolves to the standby VIP. Restarting `apollo` before DNS is correct only rebuilds the same stale view.

3. Recreate the `apollo` Pod.

   > **Warning:** Recreating `apollo` interrupts monitoring queries for every cluster until the new Pod is `Ready`. Do this only when the `apollo` log or the F12 response shows `get cluster <cluster-name> from cache error` or a cluster that is not found, and the monitoring Pods on that workload cluster are `Running`. The controller recreates the Pod; no stored data is touched.

   ```bash
   kubectl -n cpaas-system delete pod <apollo-pod>
   ```

4. If the page is still empty after `apollo` is `Ready`, test port 11780 as described in the related article.

## Diagnostic Steps

1. Confirm that collection works: the monitoring Pods are `Running` and vmui inside the workload cluster returns data.

   ```bash
   kubectl -n cpaas-system get pod -o wide | grep -Ei 'vmagent|vmselect|vminsert|vmstorage|prometheus|courier|apollo'
   ```

2. From a `global` node, `curl` port 11780 on the workload VIP. Expected for this article: JSON is returned. A timeout belongs to the related article.

3. Match the log or F12 response to a cause:
   - `cache error` in `courier-api`: Cause 1.
   - The cluster's Prometheus was reinstalled shortly before its monitoring went empty, and `global` monitoring is normal: Cause 1.
   - `Unauthorized` on `clusters` in `courier`, or `bad_response: invalid character '<'`: Cause 2.
   - `get cluster <cluster-name> from cache error` or `cluster <cluster-name> not found` in `apollo` or in the F12 response: Cause 4, even when port 11780 is open.

4. A certificate alert that survives the deletion of the expired certificate object: Cause 3. Use the VictoriaMetrics UI result to decide between `courier` and Cluster Enhancer.
