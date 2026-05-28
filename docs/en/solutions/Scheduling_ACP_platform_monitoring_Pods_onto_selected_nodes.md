---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Scheduling ACP platform monitoring Pods onto selected nodes

## Issue

On Alauda Container Platform, the platform monitoring stack (Prometheus, Alertmanager, Thanos and `prometheus-operator`, plus the bundled `kube-state-metrics`, `node-exporter`, `prometheus-adapter`, `blackbox-exporter` and `oauth2-proxy` workloads) is delivered by the `prometheus` ModulePlugin (main chart `chart-kube-prometheus`, captured at chart version `v4.3.1` alongside `chart-prometheus-operator v4.3.0` and `chart-cpaas-monitor v4.3.0` in the ACP install package observed here) and runs under the `cpaas-system` namespace; the StatefulSet replica observable at runtime is `prometheus-kube-prometheus-0-0`. Operators who want to pin these workloads to a specific subset of nodes — for example, dedicated infra nodes carrying a custom label such as `my-prometheus-node=true` and a matching taint — sometimes follow upstream guidance that edits a `cluster-monitoring-config` ConfigMap; that ConfigMap is not the configuration surface on ACP, and trying to apply it produces no effect. When the underlying nodeSelector / tolerations are misaligned, the monitoring Pods stay `Pending` and `kubectl describe pod` reports the standard scheduler events: `FailedScheduling 0/X nodes are available: ... had untolerated taint ...` and/or `didn't match Pod's node affinity/selector`.

## Root Cause

The monitoring stack on ACP is plugin-managed: the `prometheus` ModulePlugin reconciles the Prometheus / Alertmanager / Thanos / `prometheus-operator` workloads into `cpaas-system` from the chart `chart-kube-prometheus`, and its own Helm values are the configuration surface for stack-wide knobs such as scheduling. There is no `cluster-monitoring-config` ConfigMap on the platform and no equivalent monitoring-stack ConfigMap surface at all, so a remedy that edits keys inside such a ConfigMap has nothing to attach to and is silently inert. The scheduling primitives themselves (`nodeSelector`, `tolerations`, node `taints`, node labels) are vanilla Kubernetes and behave identically here — the kube-scheduler's matching logic and the `FailedScheduling ... had untolerated taint` event text are upstream-standard — so once the configuration surface is in the right place, the same matching rules apply.

## Resolution

Drive scheduling through the `prometheus` ModulePlugin's configuration, not through any ConfigMap. The operator-side surface exposed by the plugin is `spec.config.components.nodeSelector` — an array of label entries of shape `{key, value}` — and `spec.config.components.tolerations` — an array of toleration entries of shape `{key, value, effect}` where `effect` is one of `NoSchedule`, `PreferNoSchedule`, `NoExecute`. These are a single global pair shared across the whole monitoring stack and are set on the plugin's `ClusterPluginInstance` / `ModuleConfig`; they are not per-component overrides and there is no equivalent ConfigMap. The standard shape for a dedicated-infra setup looks like:

```yaml
spec:
  config:
    components:
      nodeSelector:
        - key: my-prometheus-node
          value: "true"
      tolerations:
        - key: my-prometheus-node
          value: "true"
          effect: NoSchedule
```

Apply the change by editing the `ClusterPluginInstance` for the `prometheus` plugin (or the `ModuleConfig`, depending on which surface the cluster manages the plugin through) and wait for the ModulePlugin to reconcile the monitoring workloads. The plugin's user-supplied toleration entry surfaces only `key`, `value` and `effect` — there is no explicit `operator` knob on this Helm values shape, so the rendered Pod toleration follows the upstream default (`operator: Equal`) and matches by `value:`. Because the toleration carries a `value:`, the taint on the target nodes must also carry that `value:` — a taint of shape `my-prometheus-node=true:NoSchedule` requires the toleration form shown above. Note also that the user-supplied tolerations are typically *merged with* a small baseline set of default tolerations that the plugin's Helm template pre-injects for the standard platform node roles (e.g. master / control-plane / cpaas-system / infra), rather than replacing them — so a `kubectl describe pod` against a reconciled monitoring Pod will show more tolerations than the single entry configured here. The same global pair governs every workload the plugin owns, so there is no need (and no supported path) to set scheduling per individual component such as Prometheus vs. Alertmanager vs. Thanos.

## Diagnostic Steps

Confirm the monitoring stack's namespace and namespace-scoped state first; events and Pod listings for the platform monitoring workloads live under `cpaas-system`, not under any upstream-style monitoring namespace:

```bash
kubectl get pods -n cpaas-system -o wide
kubectl get events -n cpaas-system --sort-by=.lastTimestamp
```

If any monitoring Pod is `Pending`, read its scheduler verdict and compare the Pod's effective `nodeSelector` and `tolerations` against the candidate nodes' labels and taints — this is the standard Pod-scheduling diagnostic and is unchanged on the platform:

```bash
kubectl describe pod -n cpaas-system <pending-pod>
kubectl get nodes -l my-prometheus-node=true
kubectl describe node <candidate-node> | grep -E 'Taints|Labels'
```

The Pod's effective `nodeSelector` must select at least one node whose label set carries every required key/value pair, and its `tolerations` must cover every taint that node has — including the taint's `value:` when present, since a `value:`-bearing taint demands a toleration with `operator: Equal` and the same `value:`. Node labels are applied with the standard verb:

```bash
kubectl label node <node> my-prometheus-node=true --overwrite
```

If the labels and taints align with the plugin's configured `nodeSelector` / `tolerations` and the Pods still do not schedule, re-read `spec.config.components.nodeSelector` / `spec.config.components.tolerations` on the `ClusterPluginInstance` (or `ModuleConfig`) — the configuration must live there, not in any ConfigMap — and verify that the ModulePlugin has reconciled the change down to the workload Pod specs before re-evaluating the scheduler events.
