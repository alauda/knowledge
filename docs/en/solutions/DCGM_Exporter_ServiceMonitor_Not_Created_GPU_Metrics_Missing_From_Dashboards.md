---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# DCGM Exporter ServiceMonitor Not Created — GPU Metrics Missing From Dashboards
## Issue

After installing the NVIDIA GPU stack on ACP (Hami / NVIDIA GPU Device Plugin extensions, `docs/en/hardware_accelerator/`) and wiring up the DCGM exporter, the NVIDIA GPU dashboard is empty — none of the `DCGM_FI_*` metrics (`DCGM_FI_DEV_GPU_UTIL`, `DCGM_FI_DEV_FB_USED`, `DCGM_FI_DEV_POWER_USAGE`, etc.) are visible in Prometheus, and the GPU section of the monitoring console stays blank even though GPU pods are running and scheduling on GPU nodes.

## Root Cause

DCGM exposes per-GPU metrics over HTTP, but Prometheus only scrapes a target if a `ServiceMonitor` (or `PodMonitor`) tells the Prometheus Operator to include it in the generated scrape config. In the default configuration shipped by the NVIDIA GPU Operator / ClusterPolicy, the `dcgmExporter.serviceMonitor` stanza is disabled; no `ServiceMonitor` is rendered, the metrics Service has no subscriber, and the dashboard reads `no data`.

On ACP, the monitoring stack under `observability/monitor` uses the stock Prometheus Operator CRDs (`ServiceMonitor`, `PodMonitor`, `PrometheusRule`), so the fix is identical whether the cluster uses the Hami extension, the NVIDIA GPU Device Plugin extension, or a self-managed NVIDIA GPU Operator deployment.

## Resolution

Enable the DCGM exporter's ServiceMonitor in the operator's cluster policy (or the equivalent Helm values in Hami / pGPU deployments) so the Prometheus Operator renders the scrape job.

### 1. Flip the switch on the cluster policy

Edit the `ClusterPolicy` (or the values file that produced it) and set `dcgmExporter.serviceMonitor.enabled: true`:

```yaml
spec:
  dcgmExporter:
    serviceMonitor:
      enabled: true
      # optional but recommended — pin the interval and add ACP-friendly labels
      interval: 30s
      additionalLabels:
        release: prometheus
```

Apply with `kubectl apply -f clusterpolicy.yaml` or patch in place:

```bash
kubectl patch clusterpolicy cluster-policy \
  --type=merge \
  -p '{"spec":{"dcgmExporter":{"serviceMonitor":{"enabled":true}}}}'
```

### 2. Confirm the ServiceMonitor was created

After the operator reconciles, a `ServiceMonitor` named like `nvidia-dcgm-exporter` should exist in the GPU operator namespace:

```bash
kubectl -n <gpu-operator-ns> get servicemonitor \
  | grep -i dcgm
```

If the ServiceMonitor exists but Prometheus still does not scrape it, verify:

- The ServiceMonitor's `namespaceSelector` / `selector` labels match the DCGM Service that the operator publishes.
- The Prometheus that should scrape it has a `serviceMonitorSelector` (or `serviceMonitorNamespaceSelector`) that includes the GPU operator namespace. ACP `observability/monitor` rolls this up through its own selectors; add the `release: prometheus` (or equivalent) label as shown above if a selector filter is active.

### 3. Generic OSS fallback (Hami / self-managed deployment)

If the deployment is not an NVIDIA GPU Operator ClusterPolicy but a direct Helm install of `dcgm-exporter` (for example under Hami), enable the ServiceMonitor via the Helm chart values:

```yaml
# values.yaml for dcgm-exporter Helm chart
serviceMonitor:
  enabled: true
  interval: 30s
  additionalLabels:
    release: prometheus
```

Redeploy the chart and verify the ServiceMonitor exists as in step 2.

The NVIDIA GPU stack is a vendor-supported component; the configuration surface above mirrors the upstream chart, so values set on Hami / NVIDIA GPU Device Plugin maps cleanly to ACP `observability/monitor` without further adapters.

## Diagnostic Steps

1. Confirm metrics are missing on the target Prometheus. From inside the cluster:

   ```bash
   kubectl -n <monitoring-ns> exec -it deploy/prometheus -- \
     wget -qO- 'http://localhost:9090/api/v1/query?query=DCGM_FI_DEV_GPU_UTIL' \
     | head -c 400
   ```

   A response with `"result":[]` confirms the metric is not collected.

2. Inspect the `ClusterPolicy` (or equivalent values) for the serviceMonitor flag:

   ```bash
   kubectl get clusterpolicy -o json \
     | jq '.items[0].spec.dcgmExporter.serviceMonitor'
   ```

   `null` or `{"enabled": false}` is the broken state.

3. List the DCGM exporter workload, Service, and (if present) ServiceMonitor in its namespace:

   ```bash
   NS=<gpu-operator-ns>
   kubectl -n $NS get pods -l app=nvidia-dcgm-exporter
   kubectl -n $NS get svc  -l app=nvidia-dcgm-exporter
   kubectl -n $NS get servicemonitor -l app=nvidia-dcgm-exporter
   ```

4. Port-forward the DCGM Service and confirm the exporter itself is healthy:

   ```bash
   kubectl -n <gpu-operator-ns> port-forward svc/nvidia-dcgm-exporter 9400:9400
   curl -s localhost:9400/metrics | grep -E '^DCGM_FI_DEV_GPU_UTIL'
   ```

   Non-empty output means the exporter works and the only missing piece is Prometheus discovery — which is exactly what enabling the ServiceMonitor fixes.

5. After enabling the ServiceMonitor, check the Prometheus target page (or query `up{job=~".*dcgm.*"}`) and confirm the target transitions to `1`. Metrics should appear in the dashboard within one scrape interval.
