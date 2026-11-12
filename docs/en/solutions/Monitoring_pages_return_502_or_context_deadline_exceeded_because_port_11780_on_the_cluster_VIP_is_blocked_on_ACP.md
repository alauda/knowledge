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

# Monitoring pages return 502 or context deadline exceeded because port 11780 on the cluster VIP is blocked on ACP

## Issue

The cluster monitoring page shows "loading" for every chart, or the cluster overview shows the banner `监控组件异常，只能获取部分监控数据，请修复。` (the monitoring component is abnormal; only part of the monitoring data can be retrieved, please fix it). The monitoring plugin deployed successfully and `vmagent`, `vminsert`, `vmselect`, `vmstorage`, `vm-operator` and the Prometheus Pods in `cpaas-system` are `Running`. In the browser developer tools (F12, **Network**) the monitoring call fails with HTTP 502, 500, or 503, or `vm-operator` and the global query path log `context deadline exceeded`, while a `curl` from inside the workload cluster returns JSON.

ACP publishes workload-cluster monitoring through the cluster VIP on **port 11780**. Queries from the `global` cluster look like:

```text
https://<business-vip>:11780/clusters/<cluster-name>/vmselect/api/v1/query
```

The `global` components that turn the response into a page are `courier`, `courier-api`, and `apollo`, all in `cpaas-system`.

Related article: [Monitoring pages stay empty because courier-api or apollo holds a stale cluster cache on ACP](Monitoring_pages_stay_empty_because_courier-api_or_apollo_holds_a_stale_cluster_cache_on_ACP.md) covers the case where port 11780 answers but the global components still return errors.

## Root Cause

### Cause 1: TCP to port 11780 on the VIP does not complete

From a `global` node, TCP to the workload-cluster VIP on port 11780 does not complete, so the query times out with `context deadline exceeded`, vmui in a browser returns 502, and `courier-api` logs that the business VIP on 11780 is unreachable. Any device on that path can be responsible:

- The VIP does not forward 11780 to one or more of the master addresses behind it, or an external load balancer's backend pool for 11780 does not list the nodes that actually own the port (for example nodes that have been drained).
- A firewall, WAF, or other security device in front of the VIP drops 11780. In the browser `GET /platform/monitoring.alauda.io/v1beta1/clusters/<cluster>/metrics?indicators=...` returns `503` with `"reason": "ServiceUnavailable"` and a message naming `Get "http://<cluster-vip>:11780/clusters/<cluster>/prometheus/api/v1/query?query=..."`. The cluster status can still be `正常` (normal).
- The business cluster and the `global` cluster share one VIP served by HAProxy on the nodes (for example the business API on `:16443` and the `global` API on `:6443`), and the `backend` for 11780 lists the `global` masters instead of the business masters. `courier-api` logs `EOF` for both Alertmanager and Prometheus requests, for example `List alerts error ... "https://<vip>:11780/clusters/<cluster>/alertmanager/api/v2/alerts?active=true...": EOF`, and `/platform/monitoring.alauda.io/v1beta1/clusters/<cluster>/metrics` returns `500`.
- A newly added cluster has 11780 closed from the `global` cluster to its VIP and shows only part of the monitoring data.
- The reverse direction: the workload cluster reaches the `global` VIP on 11780 and that VIP does not forward it, while the same request to a `global` master IP works. Then global monitoring is normal and only the workload cluster is abnormal.

### Cause 2: the load balancer on 11780 presents no TLS certificate

Port 11780 is reachable, but `openssl s_client` through an external load balancer completes without a certificate, while the same handshake to a master node IP returns the platform certificate. The platform queries `https://<vip>:11780`, so the HTTPS request fails even though TCP works. The `vmselect` and `vmalertmanager-alertmanager` logs stay quiet and the page returns 500. A TCP check such as `telnet` only proves the first step and does not detect this.

## Resolution

### Cause 1: TCP to port 11780 on the VIP does not complete

1. From a `global` node, compare the VIP with a master IP of the workload cluster:

   ```bash
   curl -vk --connect-timeout 5 "https://<business-vip>:11780/clusters/<cluster-name>/vmselect/api/v1/query?query=up"
   curl -vk --connect-timeout 5 "https://<master-node-ip>:11780/clusters/<cluster-name>/vmselect/api/v1/query?query=up"
   ```

2. If only the VIP fails, open TCP 11780 on every master address behind the VIP, and make sure an external load balancer's pool for 11780 lists the nodes that listen on it. If a firewall or WAF is in front of the VIP, have the network team allow 11780 to the VIP. The browser 502 clears as soon as 11780 is open; no VictoriaMetrics Pod needs a restart.

3. If the VIP is HAProxy on the nodes, find the configuration file that the running process loaded and read the 11780 backend:

   ```bash
   ps -ef | grep [h]aproxy
   grep -n -B2 -A8 11780 <haproxy-config-file>
   ```

   > **Warning:** Changing the 11780 backend and reloading HAProxy moves monitoring traffic for every cluster that shares the VIP, and a wrong backend list cuts monitoring for the cluster that was working. Do this only when the 11780 backend lists the `global` masters while the request is meant for the business cluster, and save a copy of the file first. To roll back, restore the saved file and reload HAProxy again.

   Point the 11780 backend at the business cluster's master nodes and reload HAProxy with the method already used on those nodes.

4. For the reverse direction, test from a workload node to the `global` VIP and to a `global` master IP on 11780. If only the VIP fails, the VIP forwarding for 11780 must be fixed on the network side.

### Cause 2: the load balancer on 11780 presents no TLS certificate

1. Compare the TLS handshake through the VIP and directly to a master node:

   ```bash
   openssl s_client -connect <business-vip>:11780 -servername <platform-host> </dev/null
   openssl s_client -connect <master-node-ip>:11780 -servername <platform-host> </dev/null
   ```

2. When the node presents a certificate and the VIP does not, the fault is in the virtual server for 11780 on the load balancer; have it corrected there, then repeat the VIP handshake until it returns the same certificate as the node. Reinstalling VictoriaMetrics, restarting `courier-api`, restarting workloads in `cpaas-system`, or adding a default certificate on the platform listener does not repair a VIP that drops the handshake.

## Diagnostic Steps

1. Rule out a dead collector first. All monitoring Pods should be `Running`; an `OOMKilled` VictoriaMetrics component is a different problem:

   ```bash
   kubectl -n cpaas-system get pod -o wide | grep -Ei 'vmagent|vmselect|vminsert|vmstorage|vm-operator|prometheus|courier|apollo'
   ```

2. Open vmui from inside the workload cluster. Data there plus an empty platform page means the gap is between the `global` cluster and the workload cluster, not in collection.

3. From a `global` node, run the two `curl` commands in Cause 1. Expected results:
   - Timeout on the VIP only: Cause 1.
   - JSON from both: the path is open; continue with the related article on stale caches.

4. Run the two `openssl s_client` commands in Cause 2. A certificate from the node and none from the VIP is Cause 2.

5. Check the reverse direction from a workload node to the `global` VIP on 11780 as well.
