---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After deploying the upstream NVIDIA GPU Operator on Alauda Container Platform with the device plugin intentionally disabled — for example because GPU partitioning is being driven by an alternative slicer such as Dynamic Accelerator Slicer (DAS) on top of MIG — the alert `GPUOperatorNodeDeploymentFailed` starts firing within 30 minutes:

```text
ALERTNAME                       SEVERITY  OBJECT REFERENCE                  DESCRIPTION
GPUOperatorNodeDeploymentFailed warning   nvidia-node-status-exporter-xxx   GPU Operator could not expose GPUs
                                                                            for more than 30min in the node
```

The cluster is otherwise healthy: GPU partitions are being created, workloads using them succeed, and `nvidia-smi` from a debug pod sees the cards. Only the alert is wrong.

## Root Cause

The `ClusterPolicy` is set to disable the device plugin:

```yaml
spec:
  devicePlugin:
    enabled: false
  nodeStatusExporter:
    enabled: true
  mig:
    strategy: mixed
  migManager:
    enabled: true
```

`nvidia-node-status-exporter` continues to scrape the metric `gpu_operator_node_device_plugin_devices_total`. With the device plugin off, the metric correctly reports `0`. The alerting rule `GPUOperatorNodeDeploymentFailed` is written against `value == 0 for 30m` — it does not check whether the operator was configured to keep the device plugin off in the first place. The exporter therefore reports the configured-off state as a deployment failure.

DAS / Instaslice are not implicated: they require MIG as a prerequisite but do not influence the GPU Operator's alerting. The bug lives entirely inside the GPU Operator's alert rule.

## Resolution

Two options are available until the upstream operator gates the alert on `devicePlugin.enabled`.

### Silence the alert in the platform monitoring stack

If the operator's alert rule is being delivered into the cluster's Prometheus-Alertmanager pipeline, add a silence keyed on the alertname and the operator namespace:

```yaml
matchers:
- name: alertname
  value: GPUOperatorNodeDeploymentFailed
  isRegex: false
- name: namespace
  value: nvidia-gpu-operator
  isRegex: false
startsAt: <now>
endsAt:   <future>
comment: Device plugin disabled by design (DAS / external partitioning)
createdBy: <operator>
```

Submit the silence through the monitoring stack's Alertmanager API or its supported web UI. Set a long expiration and review it whenever the device plugin's `enabled` field is touched in the `ClusterPolicy`.

### Suppress the alert in the deployed PrometheusRule

Edit the PrometheusRule the GPU Operator installs and add an `unless` clause that excludes nodes where the device plugin is intentionally off. The exact rule name varies by operator version; locate it with:

```bash
kubectl -n nvidia-gpu-operator get prometheusrules -o name
```

Then patch the matching rule's expression so it ignores nodes that match a label or annotation you set on the `ClusterPolicy` reconciler. A simple shape:

```yaml
groups:
- name: gpu-operator
  rules:
  - alert: GPUOperatorNodeDeploymentFailed
    expr: |
      gpu_operator_node_device_plugin_devices_total == 0
      unless on(namespace) gpu_operator_device_plugin_disabled_by_policy == 1
    for: 30m
```

`gpu_operator_device_plugin_disabled_by_policy` does not exist out of the box — emit it from a small ConfigMap-driven recording rule keyed off the `ClusterPolicy` `spec.devicePlugin.enabled` value, or simply hard-code the affected namespaces in the `unless` clause if the operator is only deployed once per cluster.

Track the upstream issue (`NVIDIA/gpu-operator` issue #2237) so the local override can be removed once the alert rule itself respects `devicePlugin.enabled`.

## Diagnostic Steps

1. Confirm the device plugin is actually off:

   ```bash
   kubectl get clusterpolicy -A -o jsonpath='{.items[*].spec.devicePlugin.enabled}'
   kubectl -n nvidia-gpu-operator get pods -l app=nvidia-device-plugin-daemonset
   ```

   The first command should return `false`; the second should return zero pods.

2. Confirm GPU work is still flowing — the alert is genuinely a false positive only if workloads using GPU resources are succeeding via MIG/DAS:

   ```bash
   kubectl debug node/<gpu-node> -- chroot /host nvidia-smi
   kubectl get pods -A -o json | jq -r '
     .items[] | select(
       .status.containerStatuses[]?.state.running and
       (.spec.containers[]?.resources.limits | (keys[]? // "") | startswith("nvidia.com/"))
     ) | "\(.metadata.namespace)/\(.metadata.name)"'
   ```

   If GPU-requesting pods are running across the affected nodes, the alert is firing on a misconfigured rule, not on a real outage.

3. Inspect the alert rule itself:

   ```bash
   kubectl -n nvidia-gpu-operator get prometheusrule -o yaml \
     | grep -A4 GPUOperatorNodeDeploymentFailed
   ```

   If the expression checks the `gpu_operator_node_device_plugin_devices_total` metric without an exception for the disabled-by-policy case, this article applies.

4. Verify the silence or rule patch took effect by watching Alertmanager:

   ```bash
   kubectl -n <monitoring-ns> exec deploy/alertmanager -- \
     amtool alert query alertname=GPUOperatorNodeDeploymentFailed
   ```

   The alert should drop off the active list (silenced) or never appear (rule patched).
