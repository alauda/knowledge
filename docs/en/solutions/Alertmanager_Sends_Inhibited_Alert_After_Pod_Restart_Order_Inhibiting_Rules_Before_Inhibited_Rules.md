---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Alertmanager occasionally sends a notification for an alert that should have been suppressed by an inhibition rule. The unwanted notification appears within a short window (seconds to minutes) after one of the Alertmanager pods is restarted — during a rolling upgrade of the monitoring stack, a node drain, a crash-loop recovery, or a manual `kubectl delete pod` for debugging.

Typical symptoms:

- Two-pod Alertmanager StatefulSet runs in HA. One pod restarts; immediately after, a paging channel (Slack, PagerDuty, email) receives an alert whose inhibitor is clearly firing at the same moment.
- After another few minutes the duplicate stops — Alertmanager "catches up" and future notifications for the same alert are correctly suppressed.
- Only user-defined `PrometheusRule` objects are affected; a handful of operator-bundled rules look correct.

## Root Cause

This is a known race condition in the Alertmanager code path around the decision-time ordering between inhibiting alerts and the alerts they inhibit. The upstream tracking issues are:

- Problem report: <https://github.com/prometheus/alertmanager/issues/4064>
- Proposed solutions (still open): <https://github.com/prometheus/alertmanager/issues/4813>

The race in short: when a newly started Alertmanager pod is the one that first receives and fans out an alert group, it evaluates its active-inhibitor set in parallel with accepting the incoming alert batch. If the inhibitor has not yet been fully ingested from the other pod's gossip, the decision for the inhibited alert is "not inhibited" — and the notification goes out. A second or two later the inhibitor arrives and the state is correct from that point forward.

The race is triggered by the short window in which one Alertmanager pod has just started while the other is still the sole holder of the active-inhibitor state. A full fix requires an upstream Alertmanager change; no patched release is available on ACP at the time of writing. The practical mitigation is to reduce the likelihood of the race by ensuring that, when Prometheus evaluates its rule groups, **inhibiting rules are fired to Alertmanager before the rules they inhibit**. Because Prometheus evaluates rules within a group in declaration order, this is a pure ordering problem in the authoring of `PrometheusRule` objects.

The mitigation applies only to rules under your control:

- **User-defined `PrometheusRule`**: can be rewritten — follow the ordering guidance below.
- **Operator-managed rules** (shipped by a platform component or a bundled operator): cannot be rewritten. Accept the possibility of an occasional duplicate notification on restart, or add a notification-side dedupe (Alertmanager's `group_by` / `repeat_interval`).

## Resolution

### Step 1 — find which `PrometheusRule` objects contain the affected inhibition

Identify the inhibitor alert name by looking at the Alertmanager config:

```bash
# Dump the active Alertmanager config:
kubectl -n <monitoring-ns> get secret alertmanager-<name>-generated -o=jsonpath='{.data.alertmanager\.yaml}' | \
  base64 -d | yq '.inhibit_rules'
```

Each entry has a `source_match` (the alert that inhibits) and a `target_match` (the alert being inhibited). For each such pair, find the `PrometheusRule` object that defines each alert:

```bash
# Find the rule that defines the inhibitor:
kubectl get prometheusrule -A -o=json | \
  jq -r --arg name "<inhibitor-alert-name>" \
    '.items[] | select(.spec.groups[].rules[]? | .alert == $name) |
     "\(.metadata.namespace)/\(.metadata.name) (group: \(.spec.groups[] | select(.rules[]?.alert == $name).name))"'

# And the rule that defines the inhibited alert:
kubectl get prometheusrule -A -o=json | \
  jq -r --arg name "<inhibited-alert-name>" \
    '.items[] | select(.spec.groups[].rules[]? | .alert == $name) |
     "\(.metadata.namespace)/\(.metadata.name) (group: \(.spec.groups[] | select(.rules[]?.alert == $name).name))"'
```

### Step 2 — place the inhibitor before the inhibited rule in the **same** group

Prometheus evaluates rules within one `group` sequentially, in declaration order, with no gap between rules. Across groups, evaluation can happen in parallel — so two alerts in different groups can be sent to Alertmanager out of order.

Two authoring patterns give the right behaviour:

**Pattern A — single group with the inhibitor first** (simplest, works inside a single PrometheusRule):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: example-alerts
  namespace: app-team
spec:
  groups:
    - name: app-alerts
      rules:
        # === Inhibitor must come first ===
        - alert: AppUnderMaintenance
          expr: app_maintenance_active == 1
          for: 1m
          labels:
            severity: info
            inhibit: "true"
          annotations:
            summary: "App is in maintenance window"
        # === Everything this inhibits comes after ===
        - alert: AppHighErrorRate
          expr: rate(app_errors_total[5m]) > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Error rate exceeded 5%"
        - alert: AppHighLatency
          expr: histogram_quantile(0.95, rate(app_request_duration_seconds_bucket[5m])) > 0.5
          for: 5m
          labels:
            severity: warning
```

**Pattern B — separate groups, short evaluation interval on the inhibitor** (when you cannot put everything in one group):

```yaml
spec:
  groups:
    - name: inhibitors          # runs independently
      interval: 15s             # fires frequently so the inhibitor is usually fresh
      rules:
        - alert: AppUnderMaintenance
          expr: app_maintenance_active == 1
          for: 1m
          labels: {severity: info, inhibit: "true"}
    - name: app-alerts
      interval: 30s
      rules:
        - alert: AppHighErrorRate
          expr: rate(app_errors_total[5m]) > 0.05
          for: 5m
          labels: {severity: warning}
```

Pattern A is stronger — within the group, Prometheus guarantees ordering. Pattern B relies on the shorter eval interval to win the race most of the time but does not eliminate it.

### Step 3 — reapply the `PrometheusRule` and verify the order

```bash
kubectl apply -f prometheus-rule.yaml

# Confirm by rendering the generated Prometheus rule file:
kubectl -n <monitoring-ns> exec prometheus-<name>-0 -c prometheus -- \
  cat /etc/prometheus/rules/<namespace>-<prometheusrule>.yaml | head -60
```

The rules appear in the order declared in the CR — inhibitor first.

### Step 4 — handle operator-managed rules with an ignore list

For alerts defined by a bundled operator that you cannot rewrite, configure Alertmanager to suppress the known noise-on-restart case on the notification side:

```yaml
# Alertmanager config (excerpt):
route:
  receiver: default
  group_by: [alertname, namespace]
  group_interval: 5m
  repeat_interval: 1h
  routes:
    # If AppHighErrorRate fires within 2 minutes of an Alertmanager restart,
    # delay the notification. The real inhibitor usually arrives by then.
    - matchers:
        - alertname =~ "AppHighErrorRate"
      group_wait: 2m
      receiver: default
```

The 2-minute `group_wait` gives the inhibitor a chance to settle before the notification fans out. This does not fix the race, only lengthens the window the race needs to win.

### Step 5 — monitor for further occurrence

Alertmanager exposes a metric that surfaces inhibition decisions; compare the decision count against an expected baseline to spot the race returning:

```bash
# In Prometheus / PromQL:
sum by (alertmanager) (rate(alertmanager_notifications_total{integration!=""}[10m]))
```

After the rule reordering, restarts should not spike notification counts on the affected alerts. If they still do, check: (1) that the alert is in the same rule group as its inhibitor, (2) that the `for:` of the inhibitor is not so long that the inhibitor fires later than the inhibited alert.

## Diagnostic Steps

Confirm that the symptom matches the race: correlate the notification timestamp with an Alertmanager pod restart event:

```bash
# Pod restart timestamps:
kubectl -n <monitoring-ns> get pod -l app.kubernetes.io/name=alertmanager \
  -o=jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[?(@.name=="alertmanager")].state.running.startedAt}{"\n"}{end}'

# Notification firing time from Alertmanager access logs:
kubectl -n <monitoring-ns> logs alertmanager-<name>-0 -c alertmanager | grep <webhook-receiver>
```

A notification whose send timestamp lies within ~30s of a pod start is very likely the race. A notification 10 minutes later is almost certainly a different cause.

Inspect the ordering of a suspect `PrometheusRule` quickly:

```bash
kubectl get prometheusrule -A -o=custom-columns='NS:.metadata.namespace,NAME:.metadata.name,GROUPS:.spec.groups[*].name' | column -t
```

For any group where both the inhibitor and the inhibited alerts live, pull the full group and read the `rules[*].alert` list in order:

```bash
kubectl -n <ns> get prometheusrule <name> -o=yaml | \
  yq '.spec.groups[] | select(.name == "<group>") | {group: .name, alerts: [.rules[].alert]}'
```

If the inhibited alert appears before the inhibitor, reorder (Step 2) and reapply.

If, after reordering, the race still fires, the fix is either upstream Alertmanager (watch the linked GitHub issues) or a defensive `group_wait` on the notification route (Step 4).
