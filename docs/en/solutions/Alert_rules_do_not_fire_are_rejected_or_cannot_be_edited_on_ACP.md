---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Alert rules do not fire, are rejected, or cannot be edited on ACP

## Issue

The metric or the log line is there, but the real-time alert page stays empty, or creating the alert policy is rejected, or a change to a built-in policy does not last. Typical symptoms:

- A log keyword alert chart goes from "no data" to `0` after the first matching line, and the policy does not fire.
- Creating the alert policy fails with `parse error: expected type instant vector in aggregation expression, got range vector`.
- A custom metric rule never appears on the real-time page, and the `VMRule` fails validation with an annotation template parsing error and an undefined variable.
- Rules exported from a Prometheus cluster do not load on a VictoriaMetrics cluster.
- A built-in (platform) alert policy is edited or deleted, and the change is reverted. The question is whether built-in policies can be modified, deleted, or extended.

On Alauda Container Platform, platform rules are `AlertRule` objects (`ait.alauda.io/v1`) shipped by the `cpaas-monitor` module plugin (chart `chart-cpaas-monitor`). The `warlock` controller reconciles each `AlertRule` into a `PrometheusRule`, a `VMRule` on VictoriaMetrics clusters, and the Alertmanager configuration.

## Root Cause

### Cause 1: the first keyword match only creates the workload_log_keyword_count series

A log keyword alert evaluates a rate over `workload_log_keyword_count`. Before the keyword has ever matched, there is no series at all; the value is not `0`. The first match only creates the series. A later match in a following window produces the increase that can satisfy `>= 1`. This is expected, not a missed evaluation.

### Cause 2: a range vector is passed straight into an aggregation

The mutating webhook `prometheusrules.mutating.alauda.io` rejects the object with `parse error: expected type instant vector in aggregation expression, got range vector`. The expression passes a range vector such as `metric[5m]` directly into `sum`, `avg`, `max`, `min`, or `count`, which require an instant vector.

### Cause 3: an annotation template references an undefined variable

The expression is true in vmui, but even a test rule such as CPU above 1 percent produces no real-time alert, and the controller log reports an annotation template parsing error with an undefined variable. The annotation template is evaluated when the `VMRule` is admitted, so the whole rule stays inactive. Plugin status and metric queries can both look healthy.

### Cause 4: built-in alert rules cannot be deleted, and direct edits are reverted

The rules the platform ships cannot be deleted, and direct modifications can be reverted by the platform: the `warlock` controller re-renders the generated `PrometheusRule` and `VMRule` objects from the `AlertRule`, and a module upgrade of `cpaas-monitor` can restore the chart copy of the `AlertRule` itself. Changing or extending a built-in policy in place is therefore not a supported way to get a lasting rule. Adding a label from metrics into a built-in alert expression is not an in-product configuration (stated for v4.2.4).

An existing alert policy also refuses a change of compute component, and a template policy accepts only one compute component, because the rule set is bound to that resource type.

Some conditions have no built-in rule at all: there is no alert for maintenance or license expiry, and on 4.0 `cpaas-cluster-rules` covers controller and scheduler health but no default policy covers the APIServer restart count or etcd read/write latency, although the dashboard already has metrics such as `etcd_disk_wal_fsync_duration_seconds_bucket`, `etcd_server_proposals_pending`, `etcd_server_proposals_failed_total`, and `grpc_server_handled_total{grpc_code!="OK"}`. These need a custom policy.

### Cause 5: VictoriaMetrics evaluates VMRule, not PrometheusRule

On a VictoriaMetrics cluster (for example ACP 4.3.2), the evaluator reads `VMRule` objects, not `PrometheusRule`, and a `VMRule` needs the `victoriametrics` label before `vmalert` selects it. A `PrometheusRule` exported from a Prometheus cluster (for example 3.10) is therefore not evaluated.

## Resolution

### Cause 1: the first keyword match only creates the workload_log_keyword_count series

Do not lower the threshold and do not restart Alertmanager. Emit the keyword again after the series exists, and evaluate this shape (replace the matchers):

```promql
round(sum(rate(workload_log_keyword_count{cluster_name="<cluster>",kind=~"(?i:(Deployment))",name="<workload>",namespace="<namespace>",query="<keyword>"}[300s])) * 300) >= 1
```

The notification does not contain the log line; it carries `query`, `cluster`, `namespace`, `name`, and `kind`. Retrieve the line from the log query pages or APIs. If the keyword never appears in the log query, the problem is log collection, not this rule.

### Cause 2: a range vector is passed straight into an aggregation

Wrap the range in `rate()` or `increase()` before aggregating, or drop the range selector if the metric is already an instant vector. Rejected:

```promql
sum by (namespace) (container_cpu_usage_seconds_total[5m])
```

Accepted:

```promql
sum by (namespace) (rate(container_cpu_usage_seconds_total[5m]))
```

Run the expression in vmui before creating the policy. vmui is at `<platform-address>/clusters/<cluster-name>/vmselect/vmui/`; after login, remove a trailing `prometheus/` from the server URL in vmui and save, or the query page uses the wrong API.

### Cause 3: an annotation template references an undefined variable

1. Find the rule and the evaluator Pods:

   ```bash
   kubectl get vmrule -A
   kubectl get vmrule -n <namespace> <name> -o yaml
   kubectl get pods -n cpaas-system | grep -E 'vmalert|vmoperator|victoria'
   ```

2. Search the operator or `vmalert` Pod log for `template` and `undefined`.
3. In the custom annotation, remove or correct the unknown variable. Only labels, annotations, and built-in alert fields (`.labels.*`, `.annotations.*`, `.status`, `.startsAt`, `.endsAt`) can be referenced.
4. Save, confirm that the `VMRule` no longer reports a validation error, and check the real-time page again.

### Cause 4: built-in alert rules cannot be deleted, and direct edits are reverted

1. Do not edit or delete built-in rules. To alert on something else, or with a different threshold, create a custom alert policy (from the alert policy page, or as a separate `AlertRule`) next to the built-in ones, and copy the built-in expression into it if useful.
2. To stop a built-in rule from notifying, silence its alert policy from the console (**Set Silence**) instead of editing its `expr`.
3. For a different compute component, create a new policy; existing policies and template policies stay bound to their component.
4. Inventory rules from `PrometheusRule`, not only from `AlertRule`; `kubectl get alertrules.ait.alauda.io -A` misses policies that exist only as rendered objects:

   ```bash
   kubectl get prometheusrules.monitoring.coreos.com -A
   kubectl get prometheusrules.monitoring.coreos.com -n <namespace> <name> -o yaml
   kubectl get vmrule -A
   ```

Wrapped metric names such as `cpaas_advanced_kube_workload_status_replicas_available` (available replicas of a workload) and `cpaas_advanced_kube_pod_container_status_ready` (`0` not ready, `1` ready) are recording rules. Read their native expression from the recording rule in the `PrometheusRule` instead of guessing.

### Cause 5: VictoriaMetrics evaluates VMRule, not PrometheusRule

1. Export the old rules and look at an existing `VMRule` on the target cluster:

   ```bash
   kubectl get prometheusrule -A -o yaml > /tmp/prometheusrule-export.yaml
   kubectl get vmrule -A
   kubectl get vmrule -n cpaas-system -o jsonpath='{.items[0].apiVersion}{"\n"}'
   ```

2. Convert each group to a `VMRule`, copy `apiVersion` from the existing `VMRule`, and set the `victoriametrics` label as it appears on the existing `VMRule` objects.
3. Apply, then run every expression in vmui and confirm it returns data. An expression that worked on Prometheus can be empty on VictoriaMetrics if a metric or label name changed.

## Diagnostic Steps

1. Find the object. Use the `prometheusrules.monitoring.coreos.com` list, and `vmrule` on a VictoriaMetrics cluster.

2. A create or update that returns the range-vector parse error: Cause 2. Expected after the fix: the policy is created.

3. The object exists, vmui shows the expression is true, and the real-time page is empty: read the `VMRule` and the operator log for an annotation template error (Cause 3).

4. For a log keyword policy, query `workload_log_keyword_count` with the same matchers. No series: the keyword has not matched yet, or logs are not collected. One series that just appeared with the chart at `0`: Cause 1. Wait for a second match.

5. Rules carried over from a Prometheus cluster: compare `kubectl get prometheusrule -A` with `kubectl get vmrule -A`. A rule that exists only as a `PrometheusRule`, or a `VMRule` without the `victoriametrics` label, is Cause 5.

6. A firing rule whose notification never arrives is not a rule problem; see [Alert notifications are not delivered because courier-api or apollo cannot reach the receiver on ACP](Alert_notifications_are_not_delivered_because_courier-api_or_apollo_cannot_reach_the_receiver_on_ACP.md).
