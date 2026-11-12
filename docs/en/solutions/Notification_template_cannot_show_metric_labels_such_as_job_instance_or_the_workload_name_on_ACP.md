---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.14"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Notification template cannot show metric labels such as job, instance, or the workload name on ACP

## Issue

When an alert notification template (email, robot, or webhook) is customized, one of the following comes up:

- A template that uses `{{ .labels.job }}`, `{{ .externalLabels.instance }}`, or another label seen on the metric in the Prometheus UI renders nothing.
- The alert message should contain the name of the workload, for example the StatefulSet or Deployment that triggered it, and it is not clear which variable holds it.
- An application alert policy that targets `.*` does not show the specific compute component name.
- Which fields does a standard alert notification carry, and which variables can a webhook template use?

Related article: [Node disk alert notification shows an empty mountpoint or no value on ACP](Node_disk_alert_notification_shows_an_empty_mountpoint_or_no_value_on_ACP.md).

## Root Cause

### Cause 1: templates can read only the labels of the fired alert and the platform variables

The template can use only:

- `.labels`: the labels on the fired alert. These are the alert-rule labels, for example `alert_cluster`, `alert_for`, `alert_indicator`, `alert_involved_object_kind`, `alert_involved_object_name`, `alert_involved_object_namespace`, `alert_kind`, `alert_name`, `alert_namespace`, `alert_project`, `alert_resource`, `alertgroup`, `alertname`, `severity`, and `vmcluster`, plus any series labels that the rule expression keeps after aggregation.
- `.externalLabels`: values provided by the platform: `comparison`, `currentValue`, `object`, `severity`, `status`, `summary`, and `threshold`.

Metric labels that are not on the fired alert cannot be added. For example, a test template that printed all labels of a `workload.pod.status.phase.not.running` alert on a Deployment showed only rule labels: `job`, `instance`, `endpoint`, and `service` from the Prometheus UI were not there. Custom variables cannot be defined: the display names and formats of the supported variables can be changed, but not the variables themselves. The metric name is available as `{{ .labels.alert_indicator }}` and the trigger value as `{{ .externalLabels.currentValue }}`. The supported list is in the "Reference Variables" section of the notification management documentation (**Observability** > **Monitoring** > **Operations Guide** > **Notification Management**).

The "More webhook advanced variables (Alpha)" option is the `webhook-template` feature gate. Enabling it does not add `job` or `instance`.

### Cause 2: the resource name is in alert_involved_object_name and the object in externalLabels.object

For resource-type alerts, the workload is carried in the rule labels. For example, an alert from `cpaas-statefulset-rules` on `workload.pod.container.cpu.utilization` shows the object as `cpaas-system/工作负载vmselect-cluster` (`工作负载` means workload), and its labels include `alert_involved_object_namespace`, `alert_involved_object_name`, `alert_involved_object_kind: StatefulSet`, `alert_project`, `namespace`, `pod`, `container`, and `alertname`. When the policy's resource object sets a namespace and a resource name, the notification includes them.

The notified user is not a template field: recipients, method, and template are chosen in the notification policy.

### Cause 3: a target of .* has no single component name

An application alert policy generated from a template that covers every Deployment in the namespace uses `.*` as the target. One policy then matches every Deployment, so the alert has no single component name to print in `alert_involved_object_name`.

## Resolution

### Cause 1: templates can read only the labels of the fired alert and the platform variables

1. To see exactly which keys an alert carries, add these two lines to a test template (for example a group robot template), trigger one alert, and read the message:

   ```text
   labels: {{ .labels }}
   externalLabels: {{ .externalLabels }}
   ```

2. Reference any key printed on the `labels:` line as `{{ .labels.<key> }}`, and any key on the `externalLabels:` line as `{{ .externalLabels.<key> }}`. A key that is not printed, such as `job`, cannot be used.

3. To show the advanced variable list, an administrator opens `<platform-address>/console-platform/feature-gate` and enables `webhook-template`.

   > **Warning:** Enabling `webhook-template` changes how webhook alert bodies are built and may change the format of webhook alerts that receivers already parse. Do this only when the basic variables are not enough and every webhook receiver has been confirmed to accept the new format. To roll back, disable the gate on the same page.

### Cause 2: the resource name is in alert_involved_object_name and the object in externalLabels.object

In the notification template (**Operations Center** > **Notification** > **Templates**), use:

- `{{ .labels.alert_involved_object_name }}` for the resource name, for example the StatefulSet name.
- `{{ .labels.alert_involved_object_namespace }}` for its namespace.
- `{{ .externalLabels.object }}` for the alert object as the platform displays it.

A webhook template that uses the default variables, created at **Operations Center** > **Notification** > **Create Notification Template**, message type **Alert Message**:

```text
{
  "status": "{{ .externalLabels.status }}",
  "severity": "{{ .externalLabels.severity }}",
  "cluster": "{{ .labels.alert_cluster }}",
  "object": "{{ .externalLabels.object }}",
  "resource_name": "{{ .labels.alert_involved_object_name }}",
  "policy": "{{ .labels.alert_resource }}",
  "summary": "{{ .externalLabels.summary }}",
  "current_value": "{{ .externalLabels.currentValue }}",
  {{- if eq .externalLabels.status "告警中" }}
  "alert_time": "{{ dateFormatWithZone .startsAt "2006-01-02 15:04:05" "Asia/Shanghai" }}"
  {{- else }}
  "alert_time": "{{ dateFormatWithZone .startsAt "2006-01-02 15:04:05" "Asia/Shanghai" }}",
  "recovery_time": "{{ dateFormatWithZone .endsAt "2006-01-02 15:04:05" "Asia/Shanghai" }}"
  {{- end}}
}
```

The keys on the left are what the receiver sees; rename them to the receiver's schema. `告警中` is the firing status value. The `if` branch keeps the body valid JSON in both states: the firing branch has no trailing comma, and the recovery branch adds the recovery time. Bind the template to the notification policy. A webhook body is rendered from the template only when the `webhook-template` gate is on; see [Webhook alert notifications rejected as InvalidJson or sent without the notification template on ACP](Webhook_alert_notifications_rejected_as_InvalidJson_or_sent_without_the_notification_template_on_ACP.md), which also covers quoting values that can contain double quotes.

A custom request header that a receiver requires is not a template variable; it is stored in a `NotificationSender` Secret. See [Webhook alert notifications fail with invalid header field value or miss a required custom header on ACP](Webhook_alert_notifications_fail_with_invalid_header_field_value_or_miss_a_required_custom_header_on_ACP.md).

### Cause 3: a target of .* has no single component name

To show one component's name, scope the policy to that component instead of `.*`. A policy that keeps the wildcard cannot print a single component name. Check what the policy targets:

```bash
kubectl get prometheusrule -n <namespace> <policy-name> -o yaml | grep alert_involved_object_name
```

## Diagnostic Steps

1. Print `{{ .labels }}` and `{{ .externalLabels }}` in a test template and trigger one alert. Expected: the key you want is either on one of the two lines (use it), or absent (Cause 1; it cannot be added).

2. For a workload name, check that `alert_involved_object_name` is on the `labels:` line (Cause 2).

3. If `alert_involved_object_name` is `.*` in the PrometheusRule, the policy is a wildcard (Cause 3).
