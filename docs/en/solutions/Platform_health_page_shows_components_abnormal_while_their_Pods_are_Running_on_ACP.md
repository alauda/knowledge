---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
  - "4.4"
---

# Platform health page shows components abnormal while their Pods are Running on ACP

## Issue

The platform health page or the cluster status marks components as abnormal, but their Pods are `Running`:

- **Platform Health Status** marks the `global` cluster unhealthy with the banner `平台监控功能故障，可能会影响集群（global）的功能健康检查结果的准确性，请尽快修复` (platform monitoring failure may affect the accuracy of the health check results of the global cluster; please fix it). Most monitoring components (`courier`, `courier-api`, `kube-prometheus-exporter-*`, `vmagent-agent`, `vmalertmanager-alertmanager`, `vminsert-cluster`, `vmselect-cluster`, `vmstorage-cluster`) are shown faulty with connectivity `否` (no) although their replicas are complete. The page can also raise false Pod-restart alerts.
- The cluster status shows the `coredns` component unhealthy.

Related article: [Cluster plugins stay Deploying or AppReleases stall because sentry is OOM, hung, or CPU-bound on ACP](Cluster_plugins_stay_Deploying_or_AppReleases_stall_because_sentry_is_OOM_hung_or_CPU_bound_on_ACP.md).

## Root Cause

### Cause 1: monitoring data is backed up, so the health records are not refreshed

The health page reads `modulehealthrecords`, and the module health query uses the metric `cpaas_module_health`. When `vmstorage` is CPU-throttled, monitoring data backs up and has gaps, and the health check keeps reading historical fault data, so the `modulehealthrecord` status is not refreshed. In VMUI `cpaas_module_health` stays flat for hours. The marked Pods are `Running`, their Endpoints are populated, and direct requests to their Service IPs are answered. Recreating `courier` and `courier-api` does not refresh the page.

When the backlog is released all at once, a burst of alerts can fire; for example `courier-api` sends `workload.pod.restarted.count` notifications that a DingTalk robot rejects with `errcode 660026`, `"errmsg":"sending too many messages per minute"`. The alerts recover after some time, and the health page returns to normal hours later.

`vmstorage` CPU also rises when it merges parts, under heavy `vmselect` query or `vminsert` write load, and with high disk I/O wait (for example a volume on a slow SAN).

### Cause 2: a ResourcePatch with spec.delete true removed the Service used by the coredns health check

The cluster `modulehealth` object names a Service for the `coredns` health check. On the affected cluster, `kubectl get rpch` lists a ResourcePatch in phase `Active` for release `cpaas-system/kube-prometheus`, kind `Service`, namespace `kube-system`, target `kube-prometheus-exporter-coredns`, and its YAML (`operator.alauda.io/v1alpha1`, `ResourcePatch`) has `spec.delete: true`. That patch removed the Service, so the health check cannot collect the status. Restoring the configuration brings the monitoring target back and clears the unhealthy mark.

## Resolution

### Cause 1: monitoring data is backed up, so the health records are not refreshed

1. Confirm that the components are reachable and the data is stale:

   ```bash
   kubectl get modulehealthrecords -A
   kubectl get ep -A | grep -E 'vm|courier'
   kubectl top pod -A | grep -E 'vmstorage|vmagent'
   kubectl logs -n cpaas-system deploy/courier-api --since=2h | grep -E 'errcode|sending too many messages' | tail
   ```

   In VMUI, query `cpaas_module_health` over the last 24 hours. A flat series while the page is red, populated Endpoints, and answers from the marked Services match this cause.

2. Raise the `vmstorage` CPU limit and the `vmagent` memory limit.

   > **Warning:** Higher limits let these Pods consume more of the node. Do this only when `vmstorage` CPU is throttled and the marked components answer directly. Export the object that holds the limits first; applying the export is the rollback.

3. Watch the health page over the following days. If the `vmstorage` volume has poor I/O, plan to move it to faster storage.

### Cause 2: a ResourcePatch with spec.delete true removed the Service used by the coredns health check

1. Find the Service and the ResourcePatch:

   ```bash
   kubectl get modulehealth -A -o yaml
   kubectl get svc -n kube-system kube-prometheus-exporter-coredns
   kubectl get rpch -A
   kubectl get rpch -A -o yaml | grep -B10 -A10 'kube-prometheus-exporter-coredns'
   ```

2. Back up the ResourcePatch, then delete it or edit it so that it no longer deletes the Service.

   > **Warning:** This changes what the `kube-prometheus` release keeps in `kube-system`. Do it only when the `coredns` health mark is abnormal, the Service is missing, and this ResourcePatch has `spec.delete: true` against it. To roll back, apply the export, which deletes the Service again.

   ```bash
   kubectl get rpch <rpch-name> -o yaml > "$HOME/coredns-exporter-rpch.yaml"
   kubectl delete rpch <rpch-name>
   ```

3. Confirm that the Service exists again. If it is still missing, compare with a cluster whose `coredns` check is healthy and restore the same Service. The monitoring target comes back and the `coredns` mark clears.

## Diagnostic Steps

1. For a red health page, compare the page with the Pods and Endpoints, and query `cpaas_module_health` in VMUI. Expected for Cause 1: Pods `Running`, Endpoints populated, and a flat series.

2. For an unhealthy `coredns` mark:

   ```bash
   kubectl get svc -n kube-system kube-prometheus-exporter-coredns
   kubectl get rpch -A | grep -i coredns
   ```

   Expected for Cause 2: `NotFound` for the Service and an `Active` ResourcePatch with `spec.delete: true` targeting it.
