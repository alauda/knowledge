---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.16
  - 4.0
  - 4.1
  - 4.2
---

# Custom or imported monitoring dashboards show parse errors, unsupported chart types, or no data on ACP

## Issue

A dashboard that was built in, or imported into, the platform monitoring dashboards (**Operations Center** > **Monitoring** > **Monitoring Dashboards**) does not behave like it did in Grafana. Typical symptoms:

- A panel shows `加载失败，请 刷新` (load failed, please refresh) with the error `update matchers error: 1:59: parse error: missing unit character in duration`. The query uses `[$__range]`.
- After a Grafana dashboard JSON was imported, some panels show `不支持的图表类型` (unsupported chart type) instead of a chart.
- A standard Grafana dashboard JSON (for example one supplied by a hardware or software vendor) was imported, and some panels show no data although the same expressions return data on the Prometheus page. This is sometimes described as the import "escaping" or changing characters of the original JSON.
- A user wants to create a new folder for dashboards, or wants application monitoring to show a custom dashboard selected by application labels.
- An external dashboard JSON was imported into the custom monitoring panel of an application (the **Monitoring** tab of a Deployment), and the panels show `加载失败，请 刷新`. In the browser developer tools a `monitordashboards` request fails with `mysql_up should has selector namespace=...`.
- There is no Envoy Gateway dashboard under **Monitoring Dashboards** comparable to the ALB dashboards, and 4xx/5xx response-code data is needed for alerting.
- In the monitoring dashboards the **HTTPRoute status** and **Rule Status** panels show no data while every other panel is normal.

Built-in dashboards that freeze the browser, stay blank, or are missing are a different problem; see [Monitoring page freezes the browser or built-in dashboards are missing on ACP](Monitoring_page_freezes_the_browser_or_built_in_dashboards_are_missing_on_ACP.md) and [Monitoring dashboard panels are blank or drop to zero while the backend has data on ACP](Monitoring_dashboard_panels_are_blank_or_drop_to_zero_while_the_backend_has_data_on_ACP.md).

## Root Cause

### Cause 1: Grafana built-in variables such as $__range are not supported

A query such as `sum(last_over_time(api_requests_total{appId="$appId"}[$__range]))` fails with `parse error: missing unit character in duration`. The platform monitoring dashboard does not support Grafana built-in variables such as `$__range`, and it does not support making the range selector inside a query follow a variable. The placeholder is sent unchanged, so the range selector is not a valid PromQL duration.

### Cause 2: the imported panel type is not supported

Some Grafana panel types are not supported by the platform dashboard. An imported panel of such a type shows `不支持的图表类型` (unsupported chart type).

### Cause 3: imported queries keep Grafana template-variable selectors

An imported query can keep label selectors that reference Grafana template variables, for example `DCGM_FI_DEV_POWER_USAGE{instance=~"$instance", gpu=~"$gpu"}` in the NVIDIA DCGM Exporter dashboard. If those variables are not defined on the platform dashboard, they do not resolve and the panel returns no data.

### Cause 4: dashboard folders and label-based application dashboards

Whether a new dashboard folder can be created depends on the version. On ACP 4.0.3 new monitoring folders cannot be created. On versions whose **Create Dashboard** form has a required **Folder** (`文件夹`) field, limited to 32 characters, typing a new name into that field creates the folder.

Showing a custom dashboard in application monitoring based on application labels is not supported.

### Cause 5: importing external JSON into an application's custom monitoring panel is not supported

On the **Monitoring** tab of a Deployment, the custom panel accepts charts built in the console. Importing an external dashboard JSON into it, or changing its panels through YAML, is not a supported feature. Imported panels fail with `加载失败，请 刷新`; in the browser developer tools the `variables?expr=label_values...` and `metrics?start=...` requests fail, and a `monitordashboards` request returns `code: 500`, `reason: "Unknown"` with a message such as `mysql_up should has selector namespace=...`. The message shows that queries on this panel must carry a `namespace=` selector, which the imported query does not have.

Importing a Grafana JSON as a dashboard under **Operations Center** > **Monitoring** > **Monitoring Dashboards** is a different feature and is not affected.

### Cause 6: the Envoy Gateway dashboards have not been added

The Envoy Gateway dashboards are not listed under **Monitoring Dashboards** until they are added to the cluster. They are not installed with Envoy Gateway itself.

### Cause 7: HTTPRoute status and Rule Status panels are empty because the cluster has no HTTPRoute

Both panels are built from HTTPRoute resources. When the cluster has no HTTPRoute, they have nothing to show. This is expected and is not a fault.

### Cause 8: a dashboard variable expression is malformed

An imported dashboard can carry a variable (`变量`, Variables) whose own expression is invalid, for example with an extra closing parenthesis. The panels that use the variable then show no data, while the panel expressions return data on the Prometheus page when real values are filled in. This differs from Cause 3: here the variable is defined on the dashboard, but its query cannot be parsed.

## Resolution

### Cause 1: Grafana built-in variables such as $__range are not supported

Remove the variable from the range selector. Put a fixed duration in the query, or use a query that does not need the range, and select the window with the time range picker at the top of the dashboard (for example `近 7 天`, last 7 days):

```promql
sum(last_over_time(api_requests_total{appId="$appId"}[7d]))
```

A simple check that the time picker drives the panel is a query such as `up{service=~".*"}`, which renders data across the selected range.

### Cause 2: the imported panel type is not supported

Edit each affected panel and change its type to a line chart (`趋势图`). No setting renders the unsupported Grafana panel type.

### Cause 3: imported queries keep Grafana template-variable selectors

1. Edit the panel query and remove the selectors that reference Grafana template variables (`$instance`, `$gpu`, and similar), or replace them with fixed values or with variables defined on the platform dashboard.
2. Run the edited expression in vmui or the Prometheus UI before saving it, for example:

   ```promql
   DCGM_FI_DEV_POWER_USAGE
   ```

   With the legend `GPU {{.gpu}}`, this draws the power usage of each GPU.

### Cause 4: dashboard folders and label-based application dashboards

If the **Create Dashboard** form has the **Folder** field, type the new folder name (up to 32 characters) there when creating the dashboard. On a version without that field, new folders cannot be created. Label-based custom dashboards in application monitoring are not available; there is no configuration for them.

### Cause 5: importing external JSON into an application's custom monitoring panel is not supported

1. Build each chart with **Add Chart** (`添加图表`) on the application's custom panel instead of importing a JSON file.
2. Test each expression in vmui or the Prometheus UI first, restricted to the application's namespace:

   ```promql
   mysql_up{namespace="<namespace>"}
   ```

There is no bulk-import path for application custom panels.

### Cause 6: the Envoy Gateway dashboards have not been added

1. Follow [How to Add Dashboards for EnvoyGateway](How_to_add_Dashboard_for_EnvoyGateway.md) (ACP 4.2.x and later) on the cluster where Envoy Gateway is installed. It applies a manifest, `envoy-gateway-dashboard.yaml`, that creates the `MonitorDashboard` resources `envoygateway-adminspace-control-panel-dashboard` and `envoygateway-adminspace-data-panel-dashboard` and the `PodMonitor` resources `envoy-gateway-controlplane-monitoring` and `envoy-gateway-proxy-monitoring` in `cpaas-system`.
2. Verify the objects:

   ```bash
   kubectl -n cpaas-system get monitordashboard envoygateway-adminspace-control-panel-dashboard envoygateway-adminspace-data-panel-dashboard
   kubectl -n cpaas-system get podmonitor envoy-gateway-controlplane-monitoring envoy-gateway-proxy-monitoring
   ```

3. Open the dashboards in the `container-platform` folder. The data-plane dashboard has a **Response Codes (Route)** panel, which reads `envoy_cluster_upstream_rq_xx` grouped by `envoy_response_code_class`. For an alert on the 5xx responses of one gateway, use an expression such as:

   ```promql
   sum by (envoy_cluster_name) (rate(envoy_cluster_upstream_rq_xx{gateway_namespace="<gateway-namespace>", gateway="<gateway-name>", envoy_response_code_class="5"}[2m]))
   ```

   Use `envoy_response_code_class="4"` for 4xx.

To remove the dashboards and PodMonitors again, run `kubectl delete -f envoy-gateway-dashboard.yaml` with the same manifest.

### Cause 7: HTTPRoute status and Rule Status panels are empty because the cluster has no HTTPRoute

Confirm that the cluster has no HTTPRoute:

```bash
kubectl get httproute -A
```

`No resources found` means the empty panels are expected and nothing needs to be fixed. The panels show data once HTTPRoute resources exist.

### Cause 8: a dashboard variable expression is malformed

1. Export the dashboard object and keep the export as a copy to compare against:

   ```bash
   kubectl get monitordashboards.ait.alauda.io -A | grep -i <dashboard-name>
   kubectl get monitordashboards.ait.alauda.io -n <namespace> <dashboard-name> -o yaml > /tmp/<dashboard-name>.yaml
   grep -n -E 'label_values|expr|query' /tmp/<dashboard-name>.yaml
   ```

2. For every variable used by the empty panels, run its PromQL part in the Prometheus page or vmui: for a `label_values(<series>, <label>)` variable that is the `<series>` part, otherwise the whole query. An extra closing parenthesis fails with a parse error such as `unexpected right parenthesis ')'`.
3. Edit the dashboard, correct the variable expression in the variable configuration, save, and check the panels again.

Before importing a vendor JSON again, make the same check on the file: search its `templating` section for the variable queries and run each one in the Prometheus page.

## Diagnostic Steps

1. Read the panel error. `missing unit character in duration` with `$__range` or another Grafana built-in variable in the query is Cause 1. `不支持的图表类型` is Cause 2.

2. For an imported panel without data, run its expression in vmui or the Prometheus UI with the variables replaced by real values. Expected: data is returned. Then:
   - `$` variables in the label selectors that the platform dashboard does not define: Cause 3.
   - A variable expression that fails on its own with a parse error: Cause 8.

3. An application custom panel that fails after an external JSON import, with `should has selector namespace=` in the `monitordashboards` response (browser developer tools, **Network**): Cause 5.

4. No Envoy Gateway dashboard. Expected output when the dashboards have not been added: no lines.

   ```bash
   kubectl -n cpaas-system get monitordashboard | grep -i envoygateway
   ```

5. **HTTPRoute status** and **Rule Status** empty while other panels have data: `kubectl get httproute -A` returns `No resources found` (Cause 7).
