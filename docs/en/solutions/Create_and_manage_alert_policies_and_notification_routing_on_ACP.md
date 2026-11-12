---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.16"
  - "4.0"
  - "4.3"
---

# Create and manage alert policies and notification routing on ACP

## Issue

Common questions when setting up alerting on Alauda Container Platform:

- How do I get an alert to the operations staff when a resource is abnormal or reaches a threshold?
- Can one alert policy apply to all clusters?
- How do I create alert policies for many namespaces in batch?
- Every alert rule uses `cpaas-admin-notification`; can I change the notification policy of all of them at once?
- How do I raise a threshold, for example make the node zombie-process alert fire only above 7?
- How do I alert on my own metric, such as JVM heap usage above 92% for 3 minutes?
- How often are alert rules evaluated?
- Is there a disk usage alert for master nodes?
- How do I list the existing alert policies and their notification channels, or get a table of the built-in alerts?
- Can a failed backup raise an alert?

A rule that does not fire or is rejected is covered in [Alert rules do not fire, are rejected, or cannot be edited on ACP](Alert_rules_do_not_fire_are_rejected_or_cannot_be_edited_on_ACP.md). A notification that is configured and does not arrive is covered in [Alert notifications are not delivered because courier-api or apollo cannot reach the receiver on ACP](Alert_notifications_are_not_delivered_because_courier-api_or_apollo_cannot_reach_the_receiver_on_ACP.md).

## Root Cause

### Cause 1: notifying people needs a template, a notification policy, and an alert policy that references it

Alerts reach people only when three pieces exist and are connected: a notification template (what the message says), a notification policy (who receives it and by which method, through notification contact groups), and an alert policy whose **Notification Policy** field references that notification policy. Built-in policies already reference one (for example `cpaas-admin-notification`); a new policy needs one selected.

### Cause 2: alert policies are per cluster

An alert policy belongs to one cluster, so a single policy cannot apply to all clusters. To avoid repeating the setup, create an alert template once and create the policy from it in each cluster.

### Cause 3: there is no batch creation of alert policies

The platform has no built-in function to create alert policies in batch, for example one per namespace. The options are creating each policy from an alert template, or creating the underlying `PrometheusRule` resources directly (creating an alert policy creates a `PrometheusRule`), with the target fields replaced in each copy.

### Cause 4: the notification policy on alert policies cannot be changed in bulk

There is no bulk change of the notification policy bound to alert policies. The default rules come with `cpaas-admin-notification` by design, and each policy has to be changed individually.

### Cause 5: a threshold is part of the rule's trigger condition

A threshold, for example of the node zombie-process rule, is changed by editing the rule's **Trigger Condition** (operator, value, and duration) inside the alert policy. The built-in node rule "Number of zombie processes on the node" in `cpaas-node-rules` can be changed to `> 7` for 1 minute this way, and the rule stays enabled.

### Cause 6: a custom metric alert is a custom alert rule in a resource alert policy

A custom metric such as JVM heap usage is alerted on with a rule of type **Custom Alert** (`自定义告警`) inside a resource alert policy (`资源类告警`) whose resource type is compute component (`计算组件`). On ACP 3.12 the rule takes a metric name (up to 64 characters), a PromQL expression (up to 512 characters), an optional unit and legend, a trigger condition (operator, threshold with up to 17 integer digits and 4 decimal places, and duration), and a level. After several compute components are selected, some built-in metric alerts are not supported; configuring per component supports all alert metrics.

### Cause 7: metrics are scraped every 60 seconds and rules evaluated every 30 seconds by default

By default metrics are scraped every 60 seconds and alert rules are evaluated every 30 seconds. The rule's duration (for example 1 minute) is counted on top of those.

### Cause 8: node disk usage is covered by the built-in node policy

The default node policy includes the rule `节点磁盘空间使用率 > 80% 且持续 1 分钟` (node disk space usage above 80% for 1 minute), type metric alert, level critical, enabled by default, together with the node CPU, memory, health, NodeExporter, and OOM rules. The platform inspection also has a node disk usage item, but it reflects only the moment the inspection runs.

### Cause 9: alert policies are PrometheusRules, notification policies are notifications.ait.alauda.io

Alert policies are stored as `prometheusrules` in each cluster, and each references its notification policies in the annotation `alert.cpaas.io/notifications`. Notification policies are `notifications.ait.alauda.io` resources on the `global` cluster; their YAML lists the bound contact groups and methods. The product documentation has no ready-made table of built-in alerts, but one can be generated from the rule labels.

### Cause 10: backup task failures cannot be alerted on

Application backup results are not exposed as Prometheus metrics (there is no `ServiceMonitor` for them), so no alert rule can watch them. etcd backup monitoring is different and can be configured through Prometheus.

## Resolution

### Cause 1: notifying people needs a template, a notification policy, and an alert policy that references it

1. **Platform Management** > **Operations Center** > **Notification**. On **Notification Templates**, create a template of type **Alert Message**, or reuse one.
2. On **Notification Contact Groups**, create the group of receivers.
3. On **Notification Policies**, click **Create Notification Policy** and select the contact group, the methods, and the template.
4. **Operations Center** > **Alerts** > **Alert Policies**, select the cluster, and click **Create Alert Policy**, or open an existing policy with **Actions** > **Update**.
5. Under **Policy Configuration**, select the notification policy in **Notification Policy**, set **Alert Sending Interval**, and save.

### Cause 2: alert policies are per cluster

1. **Operations Center** > **Alerts** > **Alert Templates** > **Create Alert Template**. Choose the resource type (for example cluster) and add the rules once.
2. In each target cluster under **Alert Policies**, open the dropdown next to **Create Alert Policy** and choose **Create Alert Policy from Template**.
3. Select the template and fill in the name and display name. For a cluster template the resource is set to the current cluster. Click **Create**.

### Cause 3: there is no batch creation of alert policies

For a few targets, use templates (Cause 2). For many namespaces, create one policy in the console, export its `PrometheusRule`, and generate copies:

```bash
kubectl get prometheusrules.monitoring.coreos.com -n <namespace> <policy-name> -o yaml > /tmp/policy-template.yaml
grep -n -E 'name:|alert.cpaas.io/namespace|namespace=~|alert_involved_object_namespace|resourceVersion|uid:|creationTimestamp' /tmp/policy-template.yaml
```

The namespace appears in the annotation `alert.cpaas.io/namespace`, in the `namespace=~"..."` matchers of every `expr`, and in the `alert_involved_object_namespace` label of every rule. In each copy, remove `uid`, `resourceVersion`, `creationTimestamp`, and `managedFields`, give it a unique `metadata.name`, and replace the namespace in all three places. Validate, then apply:

```bash
kubectl apply --dry-run=server -f /tmp/policy-<target-namespace>.yaml
kubectl apply -f /tmp/policy-<target-namespace>.yaml
```

Open one generated policy in the console and check that its rules and notification policy display correctly before creating the rest.

### Cause 4: the notification policy on alert policies cannot be changed in bulk

Change it on each alert policy: **Alert Policies** > **Actions** > **Update** > **Notification Policy**. To see which policies reference a notification policy first:

```bash
kubectl get prometheusrules.monitoring.coreos.com -A -o yaml | grep -n 'alert.cpaas.io/notifications'
```

### Cause 5: a threshold is part of the rule's trigger condition

1. **Platform Management**, select the cluster, **Operations Center** > **Alerts** > **Alert Policies**.
2. Open the policy (for example `cpaas-node-rules`) and click edit on the rule.
3. In **Edit Alert Rule**, change the value (and, if needed, the operator and duration) in **Trigger Condition**, then save the rule and the policy.

Built-in rules can be restored from the platform's own copy, for example by an upgrade, so re-check custom thresholds on built-in policies after an upgrade.

### Cause 6: a custom metric alert is a custom alert rule in a resource alert policy

1. **Alert Policies** > **Create Alert Policy**. Alert type resource alert, resource type compute component, component type Deployment. Optionally choose namespaces and resource names; with none selected, any matches, up to 30 can be selected, and new namespaces are included automatically.
2. Under the alert rules, click **Add Alert Rule** and set the alert type to **Custom Alert**.
3. Enter the metric name and the expression. Scope the expression to the workload and test it in the metrics UI first. In a project or namespace view the expression must carry the namespace label, or the preview stays empty:

   ```promql
   max by (pod) (jvm_memory_used_bytes{area="heap",namespace="<namespace>",pod=~"<workload>-.*"} / jvm_memory_max_bytes{area="heap",namespace="<namespace>",pod=~"<workload>-.*"})
   ```

4. Set the trigger condition to `>=` `0.92` (use `>` if `>=` is not offered) with a duration of 3 minutes, and choose the level.
5. Bind the notification policy and save.

### Cause 7: metrics are scraped every 60 seconds and rules evaluated every 30 seconds by default

A condition becomes visible after the next scrape (up to 60 seconds), is noticed at the next evaluation (up to 30 seconds), and fires after the rule's duration has also passed. Read the live values before relying on them:

```bash
kubectl get vmagent -A -o jsonpath='{range .items[*]}{.metadata.name}{" scrapeInterval="}{.spec.scrapeInterval}{"\n"}{end}'
kubectl get vmalert -A -o jsonpath='{range .items[*]}{.metadata.name}{" evaluationInterval="}{.spec.evaluationInterval}{"\n"}{end}'
```

On a Prometheus cluster, read `spec.scrapeInterval` and `spec.evaluationInterval` from `kubectl get prometheus -A -o yaml`. An empty value means the component default.

### Cause 8: node disk usage is covered by the built-in node policy

Confirm that the disk rule is present and enabled:

```bash
kubectl get prometheusrules.monitoring.coreos.com -A | grep node-rules
kubectl get prometheusrules.monitoring.coreos.com -n cpaas-system cpaas-node-rules -o yaml | grep -n -A3 node.disk.space.utilization
```

For another threshold or scope, create a custom policy: **Create Alert Policy**, alert type resource alert, resource type node, resource name all nodes, then add a rule with the disk metric and the threshold. If a root disk above 90% is neither alerted nor reported by inspection, contact technical support.

### Cause 9: alert policies are PrometheusRules, notification policies are notifications.ait.alauda.io

On each cluster, list the alert policies and their notification policies:

```bash
kubectl get prometheusrules -A
kubectl get prometheusrules -n <namespace> <name> -o yaml | grep alert.cpaas.io/notifications
```

On the `global` cluster, list the notification policies and read their contact groups and methods:

```bash
kubectl get notifications.ait.alauda.io -A
kubectl get notifications.ait.alauda.io -n <namespace> <name> -o yaml | grep -i group -C 5
kubectl get notifications.ait.alauda.io -n <namespace> <name> -o yaml | grep -i methods -C 5
```

For a table of built-in alerts (policy, alert, indicator, severity, resource kind, expression; a missing label prints an empty column):

```bash
kubectl get prometheusrules -n cpaas-system -o json | jq -r '
  .items[] | .metadata.name as $p | .spec.groups[]?.rules[]?
  | select(.alert != null)
  | [$p, .alert, (.labels.alert_indicator // ""), (.labels.severity // ""), (.labels.alert_involved_object_kind // ""), (.expr | gsub("\n"; " "))]
  | @tsv'
```

Run it on each cluster type you need (`global` and a business cluster); the built-in set differs.

### Cause 10: backup task failures cannot be alerted on

No alert can be configured for a failed application backup. Check results directly from the `status` of the backup objects, or look for the backup files in the target directory:

```bash
kubectl get backups -A
```

If `backups` is ambiguous on the cluster, list the kinds with `kubectl api-resources | grep -i backup` and use the full name.

## Diagnostic Steps

1. The alert fires in alert history and nobody is told: the alert policy has no notification policy, or the notification policy has no contact group or template (Cause 1).

2. One policy for all clusters, batch creation, or a bulk change of the notification policy: not available as a single action (Causes 2, 3, 4).

3. A different threshold: Cause 5. A metric the platform does not ship: Cause 6.

4. "The alert came late": add the scrape interval, the evaluation interval, and the rule's duration (Cause 7) before suspecting the evaluator.

5. "Is there an alert for X?": search the existing policies first (Cause 9). Node disk usage is built in (Cause 8). Backup failures are not alertable (Cause 10).
