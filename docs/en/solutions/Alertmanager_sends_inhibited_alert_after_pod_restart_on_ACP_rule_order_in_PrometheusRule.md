---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Alertmanager sends inhibited alert after pod restart on ACP — rule order in PrometheusRule

## Issue

On Alauda Container Platform (install package `v4.3.4`, kube-prometheus chart `v4.3.3`, container image `registry.alauda.cn:60080/3rdparty/prometheus/alertmanager:v0.32.1-v4.3.4`), Alertmanager runs as the StatefulSet pod `cpaas-system/alertmanager-kube-prometheus-0` driven by the `Alertmanager` CR `cpaas-system/kube-prometheus`. The default ACP deployment ships with `spec.replicas=1`; multi-replica HA is not the out-of-the-box configuration and must be opted into by scaling the CR to `replicas>=2`.

When Alertmanager runs with multiple replicas (HA) and one of the pods is restarted, the inhibition feature can fail to suppress an alert that should have been muted by a matching inhibiting alert. The inhibited alert is then forwarded to receivers as a spurious notification, even though the inhibiting condition is firing at the same time.

## Root Cause

The misbehavior is a race condition inside the Alertmanager binary. The ACP image `registry.alauda.cn:60080/3rdparty/prometheus/alertmanager:v0.32.1-v4.3.4` carries the vanilla upstream Prometheus Alertmanager `v0.32.1` with no ACP-specific patches, so the race lives in the same code path that drives the inhibition decision around a guard `if` statement and is unchanged on ACP.

Because the bug is in the upstream Alertmanager binary itself, a permanent fix is not available from inside the ACP install — the practical mitigation is to make the inhibiting alert reach Alertmanager strictly before the inhibited alert on every evaluation cycle, so the inhibition state is already in place when the inhibited alert arrives.

The Prometheus side of the system makes that mitigation feasible. The ACP Prometheus image `registry.alauda.cn:60080/3rdparty/prometheus/prometheus:v3.11.3-v4.3.4` is the vanilla upstream Prometheus `v3.11.3` binary, whose rule-group evaluator iterates each group's `spec.groups[].rules[]` array in textual (insertion) order. The single ACP `Prometheus` CR `cpaas-system/kube-prometheus-0` has a `ruleSelector` that matches `PrometheusRule` objects carrying the `prometheus: kube-prometheus` label (the chart default); rules without that label are not loaded by this Prometheus instance, so the in-group ordering semantic applies to every selected rule but a user-authored `PrometheusRule` must carry that label to participate.

## Resolution

Within each rule group that contains both an inhibiting alert and the alert it is meant to inhibit, place the inhibiting alert entry first in the group's `spec.groups[].rules[]` list. The upstream Prometheus rule evaluator processes the entries in textual order, so the inhibiting alert is sent to Alertmanager before the inhibited alert on every evaluation tick, and the inhibition state is established before the inhibited alert is delivered.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: example-inhibition-rules
  namespace: cpaas-system
  labels:
    prometheus: kube-prometheus
spec:
  groups:
    - name: example-group
      rules:
        - alert: InhibitingRule
          expr: <expression that selects the suppressing condition>
          labels:
            severity: critical
        - alert: InhibitedRule
          expr: <expression for the alert that should be suppressed>
          labels:
            severity: warning
```

The in-group ordering workaround is per group: when inhibiting and inhibited alerts are spread across multiple `spec.groups[]` entries (in the same `PrometheusRule` or across different `PrometheusRule` objects), every group that contains an inhibited rule must also contain its own inhibiting rule earlier in the same group's `rules[]` list. There is no cross-group ordering guarantee — Prometheus evaluates each group independently — so an inhibiting rule that lives only in group A does not protect an inhibited rule that lives in group B.

The workaround only applies to `PrometheusRule` objects the cluster admin can edit freely. User-defined `PrometheusRule` objects created directly under the `monitoring.coreos.com/v1` CRD have no controller `ownerReference`, so the rule-order edit persists across reconciliations.

`PrometheusRule` objects shipped and reconciled by an operator carry a controller `ownerReference` and are not safe to re-order in place. On ACP the `cpaas-cluster-rules` `PrometheusRule` in `cpaas-system` is owned by an `ait.alauda.io/v1 AlertRule` controller (`controller=true`, `blockOwnerDeletion=true`), and the `kubevirt-hyperconverged-prometheus-rule` in `kubevirt` is rendered by the HCO operator (`Deployment hco-operator`, label `app.kubernetes.io/managed-by=hco-operator`). Manual edits to either are reverted by the owning operator at the next reconcile, so the rule-order workaround does not survive on operator-managed rules and the fix must instead come from the owning operator.

## Diagnostic Steps

List every `PrometheusRule` in the cluster as the entry point for inspecting in-group ordering. On ACP `kubectl get prometheusrule -A` returns the full inventory across the namespaces where rules live (for example `argocd`, `cpaas-system`, `kubevirt`), and the same listing command/output shape is used to pick which objects to read in full:

```bash
kubectl get prometheusrule -A
kubectl get prometheusrule -A -o yaml
```

For every group that contains an inhibited rule, confirm that the matching inhibiting rule appears earlier in the same group's `rules[]` list — the array is preserved in textual order by the apiserver and consumed in that order by the Prometheus rule-group evaluator:

```bash
kubectl -n <namespace> get prometheusrule <name> -o yaml
```

Before editing a `PrometheusRule` to apply the ordering workaround, check whether the object carries a controller `ownerReference`. Objects owned by a reconciling controller (for example `ait.alauda.io/v1 AlertRule` for `cpaas-system/cpaas-cluster-rules`, or `apps/v1 Deployment hco-operator` for `kubevirt/kubevirt-hyperconverged-prometheus-rule`) have their manual edits reverted at the next reconcile and must be changed via the owning operator rather than directly:

```bash
kubectl -n <namespace> get prometheusrule <name> \
  -o jsonpath='{.metadata.ownerReferences}{"\n"}'
```
