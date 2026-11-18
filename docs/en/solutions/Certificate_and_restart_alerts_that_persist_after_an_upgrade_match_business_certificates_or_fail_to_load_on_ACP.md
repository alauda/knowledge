---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Certificate and restart alerts that persist after an upgrade, match business certificates, or fail to load on ACP

## Issue

After a platform upgrade, or around certificate monitoring in general, alerts do not behave as expected:

- Kubernetes certificate alerts keep firing after an upgrade for certificate files with hundreds of negative days of validity, or for certificate Secrets that were already deleted.
- The global cluster keeps reporting `sentry-serving-cert` below `10.00d` for a workload cluster whose machines are powered off.
- Certificate expiry warnings fire 30 days and 10 days ahead (`平台组件证书的到期时间即将到期(小于10天)`), more often than the site wants.
- During a cluster upgrade, restart alerts name business containers that did not restart.
- Platform certificate alerts fire for business (workload) certificates, and the question is whether replacing VictoriaMetrics with Prometheus avoids that.
- The rule `平台组件证书已到期 <= 0d 且持续 1 分钟` (platform component certificate expired) is firing, and its chart shows only `加载失败，请 刷新` (failed to load, please refresh), so nobody can tell which certificate expired.

## Root Cause

### Cause 1: cluster-enhancer keeps data for certificates that no longer exist after an upgrade

The certificate expiry data shows negative validity for files that are no longer in use, for example `/var/lib/kubelet/pki/kubelet.crt` at about `-952.1 d` on several nodes and `/etc/kubernetes/super-admin.conf` at `-16.86 d`, while current certificates such as `kubelet-client-current.pem` and `apiserver-loopback-client` are positive. Deleted certificate Secrets still appear in the real-time alerts. After the upgrade, `cluster-enhancer-controller` and `cluster-enhancer-apiserver` were out of sync and kept data for certificates and Secrets that no longer exist.

When the VictoriaMetrics UI returns no `certificate_expires_time` series for the deleted object and the alert still shows it, the stale state is in `courier` instead; that variant is Cause 3 of [Monitoring pages stay empty because courier-api or apollo holds a stale cluster cache on ACP](Monitoring_pages_stay_empty_because_courier-api_or_apollo_holds_a_stale_cluster_cache_on_ACP.md).

### Cause 2: sentry-serving-cert below 10.00d is reported for a powered-off workload cluster

The global cluster reports `sentry-serving-cert` below `10.00d` for a workload cluster whose nodes are all shut down, and the cluster must be kept. On v4.1.2, with full VictoriaMetrics on both sides, restarting `courier` and `courier-api` on the global cluster cleared it. Why a powered-off cluster was still reported is not known.

### Cause 3: the expiry warning thresholds do not match the site's requirement

The certificate policy warns 30 days and 10 days before expiry. That frequency is a configuration choice, not a fault. Sites that want fewer warnings silence the 30-day rule and move the 10-day threshold (for example to 3 days, a site requirement and not a product default).

### Cause 4: kube-state-metrics restarts split the restart-count series and fake an increase

The rule `计算组件下容器组最近5分钟的重启次数 > 0 且持续 1 分钟` (Pod restarts in the last 5 minutes > 0, level `提示` info) fires several times within minutes during a cluster upgrade. It queries `cpaas_advanced_kube_pod_container_status_restarts_total` with an expression of this shape:

```promql
sum by (kind, name, namespace, pod) (round((increase(cpaas_advanced_kube_pod_container_status_restarts_total{kind=~"Deployment",name=~"<workload>",namespace=~"<namespace>"}[5m]) + abs(increase(cpaas_advanced_kube_pod_container_status_restarts_total{...}[5m]))) / 2))
```

When kube-state-metrics restarts, the same container gets two series that differ only in `instance` (two kube-state-metrics endpoints on port `8080`), with the same `uid` and value `1`; the first ends where the second begins. `increase(...[5m])` counts the new series' `1` as an increase from 0 and fires, although `restartCount` did not change. The expression has not been changed for this.

### Cause 5: the certificate alert expression includes business certificates, whatever the backend

The platform certificate alert expression matches workload certificates as well, which produces platform alerts for business certificates. The expression, not the VictoriaMetrics backend, selects them, so switching to Prometheus monitors the same certificates.

### Cause 6: the certificate-expired rule chart fails to load because the vmselect query times out

In a cluster-level policy `证书告警策略` (certificate alert policy), the rule `平台组件证书已到期 <= 0d 且持续 1 分钟` (level `灾难` disaster) is firing, while the 30-day and 10-day rules in the same policy are normal. The rule's expression covers every certificate in the cluster, and its query exceeds the `vmselect` query time limits, so the chart shows `加载失败，请 刷新`. A similar 4.1 symptom is Cause 3 of [Certificates tab missing, platform domain certificate not listed, or certificate alert shows no data on ACP](Certificates_tab_missing_platform_domain_certificate_not_listed_or_certificate_alert_shows_no_data_on_ACP.md).

## Resolution

### Cause 1: cluster-enhancer keeps data for certificates that no longer exist after an upgrade

1. Confirm that the files with negative validity are not the certificates the node uses; a certificate that really expired needs renewal, not a restart:

   ```bash
   openssl x509 -noout -enddate -in /var/lib/kubelet/pki/kubelet-client-current.pem
   ls -l /var/lib/kubelet/pki/
   kubectl get secret -n <namespace> <secret-name-from-alert>
   ```

2. Run the alert expression in the VictoriaMetrics UI. A `certificate_expires_time` series still returned for the deleted object is this cause.

3. In the affected cluster, restart both cluster-enhancer components.

   > **Warning:** Restarting `cluster-enhancer-controller` and `cluster-enhancer-apiserver` drops their endpoints for one start; certificate monitoring for that cluster pauses and a metrics-availability alert can fire once. Precondition: the alerts name certificates or Secrets that no longer exist, and the series is still returned. Rollback is the replacement Pods becoming Ready.

   ```bash
   kubectl get pods -A | grep cluster-enhancer
   kubectl delete pod -n <namespace> <cluster-enhancer-controller-pod> <cluster-enhancer-apiserver-pod>
   ```

The Kubernetes certificate alerts, including the rows for deleted Secrets, return to normal.

### Cause 2: sentry-serving-cert below 10.00d is reported for a powered-off workload cluster

Keep the workload cluster, and on the global cluster restart `courier` and `courier-api`:

> **Warning:** Restarting both pauses notification sends and the active-alert scrape until the new Pods are Ready. Precondition: the row is `sentry-serving-cert` below `10.00d` for a workload cluster whose nodes are powered off, and you are on the global cluster. Rollback is the new Pods becoming Ready.

```bash
kubectl get pods -n cpaas-system | grep courier
kubectl delete pod -n cpaas-system <courier-pod> <courier-api-pod>
```

The row clears. If it returns, the cause is still open; do not delete the workload cluster for it.

### Cause 3: the expiry warning thresholds do not match the site's requirement

Find the certificate policy by its rule text, then, on that policy under **Operations Center > Alerts > Alert Policies**, silence the 30-day rule and change the nearer threshold to the value the site requires:

```bash
kubectl get alertrule -A | grep -i certificate
```

These changes reduce frequency only; they do not reduce query load.

### Cause 4: kube-state-metrics restarts split the restart-count series and fake an increase

1. Compare `restartCount` with the alert:

   ```bash
   kubectl get pod -n <namespace> <pod> -o jsonpath='{.status.containerStatuses[*].restartCount}{"\n"}'
   ```

2. Query the raw series in the VictoriaMetrics UI over the alert window:

   ```promql
   cpaas_advanced_kube_pod_container_status_restarts_total{namespace="<namespace>",pod="<pod>"}
   ```

   Two series with the same `uid` and value, one ending where the other starts, with different `instance` values, is this cause.

3. Treat a restart alert in that kube-state-metrics window as a false positive when `restartCount` did not increase. No change is needed on the workload.

### Cause 5: the certificate alert expression includes business certificates, whatever the backend

Do not replace VictoriaMetrics with Prometheus to fix this. Find which certificate the alert names:

```bash
kubectl get secret -A --field-selector type=kubernetes.io/tls | grep <name-from-alert>
```

A business certificate that is really near expiry is for its owner to renew. To stop the cluster-level policy from alerting on business certificates, disable it and rely on the general certificate policy from the `global` cluster, as in Cause 6. Built-in rules cannot be edited in place.

### Cause 6: the certificate-expired rule chart fails to load because the vmselect query times out

1. Read the current `vmselect` arguments and log on the cluster whose chart fails:

   ```bash
   kubectl get vmclusters -A
   kubectl get vmclusters -n cpaas-system <vmcluster> -o jsonpath='{.spec.vmselect.extraArgs}{"\n"}'
   kubectl logs -n cpaas-system vmselect-cluster-0 --tail=200 | grep -i -E 'timeout|deadline|maxQueryDuration|maxQueueDuration'
   ```

2. Raise `search.maxQueryDuration` and `search.maxQueueDuration` (VictoriaMetrics `vmselect` flags; upstream defaults 30 seconds and 10 seconds) under `spec.vmselect.extraArgs`.

   > **Warning:** The operator rolls the `vmselect-cluster` Pods; queries and the monitoring and alert pages stall until they are Ready. Longer limits also let heavy queries hold `vmselect` CPU and memory longer. Precondition: the chart shows `加载失败，请 刷新` and the query times out, and the object is exported to `/tmp/vmcluster.yaml`. Rollback: `kubectl apply -f /tmp/vmcluster.yaml`. A plugin reconcile or upgrade can write the plugin value back.

   ```bash
   kubectl get vmclusters -n cpaas-system <vmcluster> -o yaml > /tmp/vmcluster.yaml
   kubectl patch vmclusters -n cpaas-system <vmcluster> --type=merge \
     -p '{"spec":{"vmselect":{"extraArgs":{"search.maxQueryDuration":"<duration>","search.maxQueueDuration":"<duration>"}}}}'
   ```

3. Reload the rule chart and read which certificate is at or below 0 days. Renew a certificate that has really expired.

4. Disable the cluster-wide certificate policy from its action menu under **Operations Center > Alerts > Alert Policies**, and make sure the general certificate policy of the `global` cluster covers the platform certificates.

## Diagnostic Steps

1. After an upgrade, certificate alerts that name files with large negative validity or Secrets that do not exist: check the object and the series (Cause 1):

   ```bash
   kubectl get secret -n <namespace> <secret-name>
   kubectl get pods -A | grep cluster-enhancer
   ```

   Expected for Cause 1: the Secret is `NotFound` and the VictoriaMetrics UI still returns its series.

2. `sentry-serving-cert` below `10.00d` for a cluster whose nodes are all powered off: Cause 2.

3. 30-day and 10-day warnings that are too frequent for the site: Cause 3.

4. A restart alert during an upgrade with unchanged `restartCount` and two series that differ only in `instance`: Cause 4.

5. A certificate alert that names a business TLS Secret: Cause 5. A certificate rule chart with `加载失败，请 刷新`: Cause 6.
