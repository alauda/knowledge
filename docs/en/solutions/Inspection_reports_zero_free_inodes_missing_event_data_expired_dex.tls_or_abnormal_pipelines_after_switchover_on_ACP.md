---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Inspection reports zero free inodes, missing event data, expired dex.tls, or abnormal pipelines after switchover on ACP

## Issue

The platform inspection report marks a node, the log pipeline, a certificate, or both pipeline rows as failed, but the cluster still serves logs, metrics, and logins. Typical report text:

- `节点内剩余inode数为0个，低于预警阈值（5000个）` (remaining inodes on the node are 0, below the warning threshold of 5000), or the installation self-test warns about inodes while the nodes show 99% free inodes.
- A node has not sent `event` data (often `节点未发送 event 类型数据`, node has not sent event-type data), or `audit` data, for 15 minutes. Or the `日志链路组件状态` (log pipeline component status) row names `razor` with `日志未发送` (logs not sent), and the nodes it names are missing from the node list of the application log query page.
- `dex.tls` is reported expired, or another certificate has fewer than 30 days left or is named as `packageserver-service-cert` or `redis-operator-service-cert`, and a direct read of the Secret does not match.
- Inserting `audits` data into Elasticsearch is reported slow on a cluster that does not run `lanaya`.
- After a primary/standby switchover of the global cluster, both the monitoring pipeline row and the log pipeline row are abnormal (`监控组件(global/alert)健康状态不正常` and `监控组件(global/monitor)健康状态不正常`, monitoring component health abnormal), and the platform health page shows `平台监控功能故障，可能会影响集群 (global) 的功能健康检查结果的准确性，请尽快修复。` (platform monitoring is faulty, which may affect the accuracy of the health check results of cluster global), while the AppReleases and pods are all normal.

Monitoring rows caused by query timeouts or slow scrapes are in [Inspection reports the monitoring component abnormal or a slow collection time while monitoring works on ACP](Inspection_reports_the_monitoring_component_abnormal_or_a_slow_collection_time_while_monitoring_works_on_ACP.md).

## Root Cause

### Cause 1: the inode count is 0 because /boot/efi (or another file system without inodes) is counted

`df -i /boot/efi` is the empty pool, while `df -i /` and `df -i /var` have free inodes. The row is computed by the indicator `node.disk.inode.free` in the ConfigMap `indicators-standard-node` in `cpaas-system`, which reads `node_filesystem_files_free` with `device!~"rootfs|tmpfs"` and no mount-point filter, so the 0 of `/boot/efi` becomes the node's value. This is a known defect, and it does not mean the node cannot create files. The installation self-test has the same shape: it scans every device without excluding file system types, so file systems that have no inode counts report 0 remaining and fall below 5000. A later version is expected to exclude them; until then the warning can be ignored or the indicator corrected. A root or `/var` file system whose `df -i` is really exhausted is a real problem and not this cause.

### Cause 2: the node produced no event, audit, or log data for 15 minutes

The rule fires when no data of that type was sent from the node for 15 consecutive minutes. It means nothing of that type was produced on the node during the window, not that collection failed, and the same line can appear on every run. A "logs not sent" row naming `razor` came from nodes where system logs were visible and application logs were not, because nothing on those nodes wrote application logs; a node appears in the application log node list only after it has produced application logs. The log pipeline item checks the health of `nevermore`, `kafka`, and `lanaya`; a delay in those components is the other thing to rule out.

### Cause 3: dex.tls is reported expired after a virtual machine restart while its dates are valid

`openssl` on `cpaas-system/dex.tls` shows a validity period that still contains the current time. The report started after the virtual machine hosting the platform was restarted, earlier inspections had not flagged it, and later inspections returned to normal without a certificate replacement. If the dates really are in the past, this cause does not apply.

### Cause 4: an audits-to-Elasticsearch latency row on a cluster without lanaya

The cluster has no `lanaya` workload, so the row has nothing real to measure; it is a false alarm. Where the monitoring page or log search was really broken at the same time, the cause was elsewhere (for example a VictoriaMetrics OOM or Kafka lag).

### Cause 5: a certificate row does not match the Secret it names

The row says a certificate expires within 30 days, or names `packageserver-service-cert`, `redis-operator-service-cert`, or a short-lived `ca.crt`, while the Secret shows a much longer lifetime. Some certificates in these rows are renewed automatically by the platform 15 days before expiry, so the row needs no action. Replacing `dex.tls` or deleting a Certificate is wrong when the file is not the object the row measured.

### Cause 6: warlock was not restarted after a primary/standby switchover

The platform health page lists `vmselect-cluster` as `故障` (faulty) with 3/3 replicas and a reason such as `Service health metric is false (Error: health metric with zero value: cpaas_module_health{container="warlock", ... module="monitor", namespace="cpaas-system", ... service="warlock", ...} => 0 ...)`, while `courier` and `courier-api` are healthy. The `cpaas_module_health` value exported by `warlock` is stuck at 0 because `warlock` was not restarted after the switchover. In the switchover procedure this restart follows the restart of VictoriaMetrics and `cluster-transformer` on both global clusters, and it applies to every business cluster that sends monitoring data to the global VictoriaMetrics.

## Resolution

### Cause 1: the inode count is 0 because /boot/efi (or another file system without inodes) is counted

Only when `df -i /` has free inodes and `/boot/efi` (or another file system with no inode count) is the 0. Edit the indicator on every cluster that shows the row.

```bash
df -i / /var /boot/efi
kubectl -n cpaas-system get configmap indicators-standard-node -o yaml | grep -n -A3 'node.disk.inode.free'
```

> **Warning:** Excluding the wrong mount hides a real inode alert. Precondition: `df -i /` shows free inodes, and you saved the ConfigMap. Rollback: `kubectl apply -f /tmp/inode-configmap.before.yaml`. Exclude only `/boot/efi`; do not disable the whole inode item.

```bash
kubectl -n cpaas-system get configmap indicators-standard-node -o yaml > /tmp/inode-configmap.before.yaml
kubectl -n cpaas-system edit configmap indicators-standard-node
```

In `node.disk.inode.free`, append `mountpoint!~\"/boot/efi\"` to the label set of `node_filesystem_files_free` when the expression has no `mountpoint` matcher. If it already has a positive `mountpoint=~` list containing `/boot/efi`, remove `/boot/efi` from that list instead. After the edit the query reads (quotes escaped as inside the ConfigMap; keep the other labels, such as the `vmcluster` value, as they are):

```text
node_filesystem_files_free{vmcluster=\"region\",node_name=~\"{{.name}}\",device!~\"rootfs|tmpfs\",mountpoint!~\"/boot/efi\"}
```

The collector picks the change up in about 15 minutes. To apply it sooner, restart `courier`:

> **Warning:** Restarting `courier` drops in-flight inspection queries until the new pod is Ready. Precondition: the ConfigMap edit is saved. Rollback: none needed; the Deployment recreates the pod.

```bash
kubectl -n cpaas-system rollout restart deploy/courier
```

If the only goal is to stop the warning, the threshold can be changed in the inspection configuration; a lower threshold also hides a real exhaustion.

### Cause 2: the node produced no event, audit, or log data for 15 minutes

No object has to change. Treat the line as an ignorable prompt when the node is `Ready` and the 15-minute gap is the only finding. To stop it, disable the `日志链路组件状态` (log pipeline component status) item in the inspection configuration (`运维中心 → 巡检 → 巡检配置`, Operations Center → Inspection → Inspection Configuration) and watch `nevermore`, `kafka`, and `lanaya` through real-time alerts instead. Keep the item enabled if you want a real log pipeline failure to show up in the inspection; it covers more than the event sentence.

### Cause 3: dex.tls is reported expired after a virtual machine restart while its dates are valid

No replacement and no delete. After confirming the dates (Diagnostic Steps), wait for the next inspection. If the dates are past, follow [Replace the platform access certificate in dex.tls on ACP](Replace_the_platform_access_certificate_in_dex.tls_on_ACP.md) instead of waiting.

### Cause 4: an audits-to-Elasticsearch latency row on a cluster without lanaya

No change. Confirm that `lanaya` is absent and close the row as a false alarm.

### Cause 5: a certificate row does not match the Secret it names

Read the named Secret first (Diagnostic Steps). When it is still well inside its dates, the row does not match the file. For a certificate the platform renews automatically 15 days before expiry, check after that point that the dates moved forward. Renew only when `openssl` shows that named certificate inside the warning window, and only for that object: see [Platform certificate expiry alert for a cert-manager serving certificate that renews by itself on ACP](Platform_certificate_expiry_alert_for_a_cert_manager_serving_certificate_that_renews_by_itself_on_ACP.md), [Operator service certificates such as packageserver-service-cert about to expire or not renewed on ACP](Operator_service_certificates_such_as_packageserver-service-cert_about_to_expire_or_not_renewed_on_ACP.md), or [Expired platform component certificate Secret such as hco-webhook-service-cert not reissued on ACP](Expired_platform_component_certificate_Secret_such_as_hco-webhook-service-cert_not_reissued_on_ACP.md).

### Cause 6: warlock was not restarted after a primary/standby switchover

Only when a switchover happened, both pipeline rows went abnormal after it, and the pods and AppReleases are healthy.

> **Warning:** Restarting `warlock` interrupts what it serves until the new pod is Ready. Precondition: the switchover is complete and VictoriaMetrics (`alertmanager`, `vmselect`, `vminsert`) and `cluster-transformer` were already restarted on the primary and standby global clusters. Rollback: none needed; the Deployment recreates the pod.

Run on each affected cluster, including every business cluster that sends monitoring data to the global VictoriaMetrics:

```bash
kubectl -n cpaas-system get pods -l service_name=warlock
kubectl delete po -n cpaas-system -l service_name=warlock
kubectl -n cpaas-system get pods -l service_name=warlock
```

If the earlier switchover steps were skipped, first run `kubectl delete po -n cpaas-system -l 'service_name in (alertmanager,vmselect,vminsert)'` and `kubectl delete po -n cpaas-system -l service_name=cluster-transformer` on both global clusters. Re-run the inspection, and make the `warlock` restart part of the switchover procedure.

## Diagnostic Steps

1. Inode row: compare mounts before editing anything. `/boot/efi` at 0 with `/` healthy is Cause 1. To list every mount that reports no inodes at all: `df -i -T | awk 'NR==1 || $3==0'`. `/` or `/var` at 0 is a real exhaustion, not this article.
2. Event or logs-not-sent row: "15 minutes" and the data type, repeating on every run, is Cause 2. On the log query page, switch to system logs for the named node; system logs present and no application pods on the node confirms it. If system logs are also missing, check the pipeline:

   ```bash
   kubectl get pods -A -o wide | grep -E 'nevermore|lanaya|razor|kafka' | grep -v Running
   ```

3. Certificate rows:

   ```bash
   kubectl -n cpaas-system get secret dex.tls -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -dates -subject
   kubectl -n <namespace> get secret <cert-secret> -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -dates
   ```

   Valid `dex.tls` dates after a VM restart is Cause 3. For a key named `ca.crt`, decode `.data['ca.crt']` the same way. A long lifetime against a "less than 30 days" row is Cause 5. A date that has passed is a real expiry.
4. Audits latency: `kubectl get pods -A | grep lanaya` returning nothing is Cause 4.
5. Both pipeline rows abnormal right after a switchover, `kubectl get ars -A` and the pods healthy, and the health page reason `health metric with zero value: cpaas_module_health{container="warlock", ...} => 0`, is Cause 6.
