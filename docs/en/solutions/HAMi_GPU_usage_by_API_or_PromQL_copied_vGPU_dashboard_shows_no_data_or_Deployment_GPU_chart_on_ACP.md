---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# HAMi GPU usage by API or PromQL, copied vGPU dashboard shows no data, or Deployment GPU chart on ACP

## Issue

GPU usage data from HAMi is needed outside HAMi WebUI:

- Code has to start a Pod, delete a Pod, and query the GPU card usage of a cluster, and no HAMi or GPU usage API can be found.
- The `hami-vgpu-metrics-dashboard` that HAMi deploys was copied into the Container Platform as a custom namespace-level monitoring dashboard, and it shows no data. Panels such as GPU Total, XID Error, and GPU temp(DCGM) fail to load, and gauges such as Average GPU Temp and GPU power usage show "No data" (`无数据`). The query behind a panel returns HTTP `500` with the header `x-alb-err-reason: BackendError : read 463 byte data from backend` and a message such as `DCGM_FI_DEV_POWER_USAGE should has selector namespace=<namespace>`.
- A user wants a GPU usage chart for their own Deployment. The `监控` (Monitoring) tab, under `自定义面板` (Custom Dashboard), shows `当前无数据，请 添加图表` (no data, please add a chart), and HAMi metrics are not in the built-in metric list.
- GPU memory per namespace queried from VictoriaMetrics looks much higher than what `nvidia-smi` shows on the node, or it is unclear which HAMi metric gives allocated versus used GPU memory and cores.

A copied dashboard that fails for reasons other than the namespace selector is covered in [Custom or imported monitoring dashboards show parse errors, unsupported chart types, or no data on ACP](Custom_or_imported_monitoring_dashboards_show_parse_errors_unsupported_chart_types_or_no_data_on_ACP.md).

## Root Cause

### Cause 1: There is no dedicated platform API for HAMi GPU usage

An exporter collects HAMi and GPU metrics into the monitoring storage (Prometheus or VictoriaMetrics), and they can only be read with PromQL. The platform monitoring metrics API takes a PromQL expression, and it also serves CPU and memory for a group of Pods. Creating and deleting Pods uses the standard Kubernetes API through the platform.

The expressions already exist in the platform dashboards: in `HAMi/hami-vgpu-metrics-dashboard`, the panel menu entry "Query expression" (`查询表达式`) shows each panel's query, for example the `nodeGPUOverview` GPU count, the `vGPUCorePercentage` per-card usage, and the `nodeGPUList(DCGM)` per-node distribution.

When the GPU cluster's monitoring plugin, Alauda Container Platform Monitoring for VictoriaMetrics, is set to "Deploy agent only: Yes" (`仅部署代理: 是`), the GPU cluster runs only the agent and the data is stored on the storage cluster named in that plugin. Queries must go to that storage cluster, and the `vmcluster` label in the expressions carries the GPU cluster name.

### Cause 2: A copied hami-vgpu-metrics-dashboard shows no data because card-level metrics have no namespace label

In the Container Platform view, a dashboard expression must be restricted to a namespace, or it is rejected with `<metric> should has selector namespace=<namespace>` (for example for `DCGM_FI_DEV_POWER_USAGE` and for `sum by (deviceuuid, nodename) (vGPUCorePercentage{nodename=~""})`). The copy was made visible there with the labels `cpaas.io/dashboard.folder: container-platform` and `cpaas.io/dashboard.tag.overview: "true"`. The card-level and node-level series in that dashboard, the DCGM metrics and HAMi series such as `vGPUCorePercentage`, carry no `namespace` label, so the restriction can never match. Adding labels to the dashboard or to the queries does not help. This dashboard cannot be migrated into the Container Platform view; HAMi WebUI remains the place for vGPU monitoring. Per-container HAMi series are different (Cause 3).

### Cause 3: A Deployment GPU chart needs a custom chart, and HAMi metrics need the native PromQL mode

GPU usage of a workload is shown by adding a chart to the Deployment's `自定义面板` (Custom Dashboard). The built-in metrics (`内置指标`) cover physical GPUs only:

- `workload.gpu.utilization`: physical GPU utilization of the workload
- `workload.gpu.memory.utilization`: physical GPU memory utilization of the workload
- `workload.pod.gpu.memory.utilization`: physical GPU memory utilization of the workload's Pods

HAMi metrics are not built-in metrics. The platform monitoring dashboards have per-container HAMi panels, such as `HAMi-Memory desc of container`, `HAMi-GPU util desc of container`, `HAMi-Host memory usage`, and `HAMi-Host core util`. Their expressions carry `namespace` and `podname` labels and can be reused in a Deployment chart through the `原生` (native) PromQL method.

### Cause 4: Allocated and used GPU are different HAMi metrics

HAMi exports what the scheduler allocated separately from what is actually used:

| Metric | Meaning |
|---|---|
| `hami_vgpu_memory_allocated_bytes` | GPU memory allocated by the scheduler |
| `hami_vgpu_memory_used_byte` | GPU memory actually used |
| `hami_host_gpu_utilization_ratio` | Actual GPU core utilization |
| `hami_vgpu_core_allocated_ratio` | GPU cores allocated |

An allocation-based figure is not the same as the memory a process holds, so it can be much higher than what `nvidia-smi` lists. Compare `nvidia-smi` with the used metric, not the allocated one.

## Resolution

### Cause 1: There is no dedicated platform API for HAMi GPU usage

1. Find the storage cluster. Open the cluster plugin Alauda Container Platform Monitoring for VictoriaMetrics of the GPU cluster. If "Deploy agent only" is Yes, use the storage cluster named there; otherwise use the GPU cluster itself.
2. Copy the expression from a panel of `HAMi/hami-vgpu-metrics-dashboard` ("Query expression"). Expressions have this shape:

   ```text
   count(DCGM_FI_DEV_DEC_UTIL{UUID=~"(<gpu-uuid>|<gpu-uuid>)",node_name=~"(<node>|<node>)",vmcluster="<gpu-cluster>"})
   sum by (deviceuuid, nodename) (vGPUCorePercentage{nodename=~"(<node>|<node>)",vmcluster="<gpu-cluster>"})
   ```

3. Create a token in the user profile under **API Tokens** > **Add API Token** (`API 令牌` > `添加 API 令牌`), then call the metrics API of the storage cluster. A successful call returns JSON with `query` and `result`.

   ```bash
   TOKEN='<api-token>'
   curl -k -H "Authorization: Bearer ${TOKEN}" --get \
     --data-urlencode 'expr=count(DCGM_FI_DEV_DEC_UTIL{vmcluster="<gpu-cluster>"})' \
     "https://<platform-address>/platform/monitoring.alauda.io/v1beta1/clusters/<storage-cluster>/metrics"
   ```

To try expressions interactively, open vmui of the storage cluster at `https://<platform-address>/clusters/<storage-cluster>/vmselect/vmui/`. In the vmui settings, remove `/prometheus` from the server URL and apply, or queries do not run.

For Pod-group CPU and memory, copy the expressions from the matching existing dashboards in the same way.

Pods are created with the standard Kubernetes `POST` to `https://<platform-address>/kubernetes/<cluster>/api/v1/namespaces/<namespace>/pods` (Pod manifest as body) and deleted with `DELETE` on `.../pods/<pod>`.

> **Warning:** The `DELETE` call removes the Pod immediately. A Pod owned by a Deployment or another controller is recreated; a bare Pod is gone. Save the manifest of a bare Pod first; roll back by creating it again from that manifest.

```bash
curl -k -X DELETE -H "Authorization: Bearer ${TOKEN}" \
  "https://<platform-address>/kubernetes/<cluster>/api/v1/namespaces/<namespace>/pods/<pod>"
```

### Cause 2: A copied hami-vgpu-metrics-dashboard shows no data because card-level metrics have no namespace label

Do not migrate this dashboard into the Container Platform view; use HAMi WebUI for vGPU monitoring. To confirm, run a panel expression without the namespace filter in vmui or through the metrics API and list the labels on the result: no `namespace` label confirms this cause. For a per-workload view, use Cause 3.

### Cause 3: A Deployment GPU chart needs a custom chart, and HAMi metrics need the native PromQL mode

1. Open the Deployment, go to `监控` (Monitoring), and switch to `自定义面板` (Custom Dashboard).
2. Click `添加图表` (Add Chart). For physical GPU usage, choose a built-in metric: `workload.gpu.utilization`, `workload.gpu.memory.utilization`, or `workload.pod.gpu.memory.utilization`.
3. For HAMi vGPU usage, copy the expression of a per-container HAMi panel ("Query expression"), add the chart with the `原生` (native) method, and paste the expression restricted to the workload's namespace:

   ```text
   sum by (podname) (Device_memory_desc_of_container{namespace="<namespace>"})
   ```

   This draws one series per Pod of the namespace. To show one workload only, add `podname=~"<workload>-.*"`. If a pasted expression returns `should has selector namespace=<namespace>`, it is a card-level series (Cause 2).

### Cause 4: Allocated and used GPU are different HAMi metrics

Query the metric that matches the question in vmui of the storage cluster (or through the metrics API):

```text
sum by (namespace) (hami_vgpu_memory_allocated_bytes) / 1024^3
sum by (namespace) (hami_vgpu_memory_used_byte) / 1024^3
hami_host_gpu_utilization_ratio
hami_vgpu_core_allocated_ratio
```

If an aggregated expression returns `[]`, run the bare metric (for example `hami_vgpu_memory_allocated_bytes`) first and read the labels it actually carries, then aggregate by a label that exists. For a trend instead of the current value, use the vmui **Graph** view with a time range such as the last 30 minutes; the **Table** view shows instant values.

## Diagnostic Steps

1. Confirm which cluster stores the monitoring data:

   ```bash
   kubectl get pods -A | grep -E 'vmselect|vmagent|vminsert|vmstorage'
   ```

   On the GPU cluster, `vmagent` without `vmselect` matches agent-only mode: query the storage cluster.

2. Test an expression through the metrics API. A JSON body with `result` means the expression and storage cluster are right.

3. For a copied dashboard with no data, open the browser developer tools on a failing panel. HTTP `500`, `x-alb-err-reason: BackendError`, and `should has selector namespace=<namespace>` in the body: Cause 2.

4. Run the panel expression in vmui and look at the result labels. No `namespace` label on a HAMi or DCGM series confirms that the Container Platform view cannot filter it. A per-container series with `namespace` and `podname` labels (for example `Device_memory_desc_of_container`) can be charted as in Cause 3.

5. When comparing with `nvidia-smi`, run it on the GPU node itself. Run from the platform node terminal after `chroot /host`, `nvidia-smi` can fail with `Failed to initialize NVML: Unknown Error` even though it works when logged in to the node directly; that failure says nothing about the metrics.
