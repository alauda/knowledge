---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
---

# Node disk alert notification shows an empty mountpoint or no value on ACP

## Issue

The built-in node disk alert (policy `cpaas-node-rules`, indicator `node.disk.space.utilization`) fires for disk usage above the threshold, but the mountpoint inside the summary is blank:

```text
磁盘分区(挂载点 )的空间使用率超过80.00%
```

(disk partition (mountpoint ) space usage exceeds 80.00%), with a trigger value such as `80.20%`. A webhook forward of the same alert shows `no value` where the disk path should be. The `courier-api` log line `Try to record` for the alert lists labels such as `device: /dev/mapper/<vg>-<lv>`, `alert_resource: cpaas-node-rules`, and `alert_involved_object_kind: Node`, with no `mountpoint`, and status `Ready`, phase `Done`: the message was delivered, only the field is empty.

Related article: [Notification template cannot show metric labels such as job, instance, or the workload name on ACP](Notification_template_cannot_show_metric_labels_such_as_job_instance_or_the_workload_name_on_ACP.md).

## Root Cause

### Cause 1: the disk summary references mountpoint, and the alert series no longer has that label

The `node.disk.space.utilization` expression in the PrometheusRule `cpaas-system/cpaas-node-rules` has this shape:

```promql
max by (node_name,host_ip,node,ip,instance,device) (avg by(node_name,host_ip,node,ip,instance,device,mountpoint) (node_filesystem_used{node=~".*",device!~"rootfs|tmpfs|shm",mountpoint!~"/run/containerd/.*"}) / avg by(node_name,host_ip,node,ip,instance,device,mountpoint) (node_filesystem_size_bytes{...}))>0.5
```

The outer `max by (...)` aggregates by `device` and drops `mountpoint`, so the result series carry only `device`, `host_ip`, `instance`, `ip`, `node`, and `node_name`. The alert summary comes from the ConfigMap `indicators-standard-node-alerts` in `cpaas-system` on the `global` cluster. Under the indicator `node.disk.space.utilization`, its `summaryZH` is `磁盘分区(挂载点{{.labels.mountpoint}})的空间使用率{{.externalLabels.comparison}}{{.externalLabels.threshold}}`, and `summaryEN` references `{{.labels.mountpoint}}` as well. With the label absent, `{{ .externalLabels.summary }}` renders an empty mountpoint.

Other ConfigMaps with indicator definitions are not read for this summary, so editing them has no effect.

## Resolution

### Cause 1: the disk summary references mountpoint, and the alert series no longer has that label

1. Read the rule expression, the summary, and the live labels:

   ```bash
   kubectl get prometheusrule -n cpaas-system cpaas-node-rules -o yaml | grep node.disk.space.utilization -A 10
   kubectl get cm -n cpaas-system indicators-standard-node-alerts -o yaml | grep node.disk.space.utilization -C10
   ```

   Run the disk expression from the PrometheusRule in the metrics UI. Continue only if `mountpoint` is absent and `device` is present in the result.

2. On the `global` cluster, export the ConfigMap:

   ```bash
   kubectl get cm -n cpaas-system indicators-standard-node-alerts -o yaml > /tmp/indicators-standard-node-alerts.yaml
   ```

3. Under `node.disk.space.utilization`, replace `{{.labels.mountpoint}}` with `{{.labels.device}}` in `summaryZH`, and in `summaryEN` if it also references `mountpoint`.

   > **Warning:** This changes the summary text of all node disk alerts, and a wrong label name keeps printing a blank or `no value`. Do this only when the query result has `device` and not `mountpoint`. To roll back, run `kubectl apply -f /tmp/indicators-standard-node-alerts.yaml`. A platform upgrade can restore the shipped copy of this ConfigMap.

   ```bash
   kubectl edit cm -n cpaas-system indicators-standard-node-alerts
   ```

   The resulting `summaryZH`:

   ```text
   磁盘分区(挂载点{{.labels.device}})的空间使用率{{.externalLabels.comparison}}{{.externalLabels.threshold}}
   ```

4. Confirm on a business cluster that the indicator definition shows the new text:

   ```bash
   kubectl get cm -n cpaas-system indicators-standard-node-alerts -o yaml | grep -A3 node.disk.space.utilization
   ```

5. Wait for the next node disk alert, or test as below. The alert now shows the device, for example `磁盘分区(挂载点/dev/vda15)的空间使用率超过1.00%`, in firing and resolved notifications.

   To test immediately, lower the threshold of the disk rule in `cpaas-node-rules` temporarily.

   > **Warning:** A lower threshold fires a node disk alert for every node and filesystem above the new value, and each is sent to every notification policy bound to `cpaas-node-rules`. Do this only to verify the summary change, after writing down the current threshold and duration and warning the recipients. To roll back, set the threshold back (80% for 1 minute by default); the test alerts then resolve.

This shows the device instead of the mountpoint; it does not restore a mountpoint value. Only filesystems that the collection rules keep appear: a partition without a filesystem, or the parent disk itself, has no alert series.

## Diagnostic Steps

1. Run the disk expression from `cpaas-node-rules` in the metrics UI. Expected for this issue: the series have `device` and no `mountpoint`.

2. Read the summary in `indicators-standard-node-alerts`. Expected for this issue: it references `{{.labels.mountpoint}}`.

3. Find the `Try to record` line for the alert in the `courier-api` log. Phase `Done` confirms the notification was delivered and only the field is empty:

   ```bash
   kubectl logs -n cpaas-system deploy/courier-api --tail=500 | grep 'node.disk.space.utilization'
   ```
