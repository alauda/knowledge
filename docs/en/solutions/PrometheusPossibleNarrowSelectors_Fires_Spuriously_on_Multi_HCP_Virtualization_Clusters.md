---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# PrometheusPossibleNarrowSelectors Fires Spuriously on Multi-HCP Virtualization Clusters
## Issue

The `PrometheusPossibleNarrowSelectors` alert fires repeatedly on a cluster that:

- Hosts the Virtualization stack (KubeVirt-based VMs running through ACP's `virtualization` capability), and
- Hosts multiple Hosted Control Plane tenant clusters via the **Hosted Control Plane** extension.

The alert fires even though the cluster carries:

- Only the default monitoring stack (`observability/monitor`), with no custom `PrometheusRule` objects added by the operator.
- No custom label selectors on `ServiceMonitor` / `PodMonitor` objects beyond what the default install ships.
- A working metrics pipeline — scrapes are succeeding, queries return correct data, dashboards are healthy. The alert is purely noise.

The noise causes operational friction: pages get filed, on-call rotations fatigue, and the underlying signal (a `ServiceMonitor` that *legitimately* has too narrow a selector) gets lost in the volume of false positives.

## Root Cause

`PrometheusPossibleNarrowSelectors` is a recommended-rule alert shipped with the Prometheus Operator. It compares the label selector on each `ServiceMonitor` / `PodMonitor` against the labels of the matched `Endpoints`, and fires when the selector matches a *suspiciously small* fraction of what the operator considers candidate targets — the heuristic is meant to catch typos like a `selector.app: webapp` matching only one Pod when the user clearly intended to match a Deployment-scoped set.

The heuristic, however, has known false-positive cases:

- **Multi-tenant control planes scraped by the parent cluster's monitoring**: in a Hosted Control Plane topology, each hosted cluster's control-plane Pods (etcd, kube-apiserver, kube-controller-manager, kube-scheduler) run in a dedicated namespace on the **management** cluster. The default monitoring stack on the management cluster discovers those Pods through `ServiceMonitor` / `PodMonitor` objects whose selectors necessarily target a single hosted-cluster's namespace and labels. From the heuristic's point of view this looks "narrow" — one selector matches a small set of endpoints — even though that is exactly the correct shape for per-tenant scraping.
- **VM-related side-monitors shipped by Virtualization**: KubeVirt's VM lifecycle controllers expose a small number of metrics endpoints; the corresponding `ServiceMonitor` selectors are also narrow by design.

The alert rule does not currently distinguish "narrow because the selector is broken" from "narrow because the topology requires tenant-scoped or per-VM selectors". On a single-tenant, no-VM cluster the heuristic is fine; on a cluster running multiple HCPs, every hosted cluster contributes one or more apparent narrow-selector violations, and the alert fires continuously.

The upstream Prometheus Operator project is aware of the false-positive shape; the fix path is in the rule definition (either widening the heuristic, or excluding tenant-control-plane and VM-controller selectors from the calculation). Until that lands, the cluster operator has to silence the noise without losing the true-positive case.

## Resolution

### Preferred: silence the alert at the rule level for known-narrow-by-design selectors, on ACP's monitoring surface

ACP's monitoring is delivered through `observability/monitor` (Prometheus, Alertmanager, the Operator). The standard mitigation is to neutralize the false positives at the rule layer while preserving the alert for selectors that are *not* expected to be narrow.

Two complementary mitigations — apply both:

#### 1. Suppress at Alertmanager for the well-known noisy `ServiceMonitor` namespaces

Inhibit the alert specifically for the namespaces that are known-narrow by design:

- The Hosted Control Plane tenant namespaces (named per the HCP convention used in the cluster — typically `clusters-<name>` or `<name>-hcp` depending on the version).
- The VM controller namespaces shipped by `virtualization`.

In the Alertmanager config (managed by `observability/monitor`), add a route that drops `PrometheusPossibleNarrowSelectors` when its labels indicate it came from one of those namespaces. Example route, in the standard `alertmanager.yaml` shape:

```yaml
route:
  routes:
    - matchers:
        - alertname = "PrometheusPossibleNarrowSelectors"
        - namespace =~ "(clusters-.*|.*-hcp|virtualization-.*|kubevirt.*)"
      receiver: "blackhole"
      continue: false
receivers:
  - name: "blackhole"
```

Adjust the namespace regex to match the actual tenant-namespace naming on the cluster. The `blackhole` receiver is the conventional name for "no-op" — define it once with no notifier configured.

This drops the false positives without dropping the true positives: a `PrometheusPossibleNarrowSelectors` raised against a workload-team namespace (where a narrow selector almost certainly *is* a typo) still fires.

#### 2. Exclude known-narrow-by-design selectors from the rule itself

If the Alertmanager-level inhibit is not granular enough — for example because the alert metadata does not carry a clean `namespace` label across all the noisy paths — the second option is to override the alert's expression. The default rule queries the per-`ServiceMonitor` ratio of matched endpoints to total candidate endpoints; the override adds a `unless` clause to exclude `ServiceMonitor`s whose namespace prefix is one of the known tenant or VM-controller patterns.

Concretely, ship a `PrometheusRule` that overrides the recommended one with the same name. The Operator gives precedence to the user-supplied rule:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: prometheus-operator-narrow-selectors-override
  namespace: <monitoring-namespace>
  labels:
    role: alert-rules
spec:
  groups:
    - name: prometheus-operator.narrow-selectors
      rules:
        - alert: PrometheusPossibleNarrowSelectors
          expr: |
            (
              <original-expression-for-the-rule>
            )
            unless on (namespace) (
              kube_namespace_labels{namespace=~"(clusters-.*|.*-hcp|virtualization-.*|kubevirt.*)"}
            )
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "ServiceMonitor selector matches a suspiciously small target set"
```

Replace `<original-expression-for-the-rule>` with the upstream rule body — `kubectl get prometheusrule -A` to find it on the cluster, then copy the expression and wrap it as above. This keeps the alert active for selectors outside the multi-tenant and VM-controller namespaces, so a real narrow-selector bug in a workload `ServiceMonitor` will still page.

#### 3. Track the upstream fix

Both mitigations above are bridges. Once the Prometheus Operator releases a fix for the alert rule's false-positive shape (i.e. excluding tenant-control-plane and VM-controller selectors at the rule level upstream), remove the local override so the cluster goes back to the operator-shipped rule body. Until then, the silence is correct: the alert is providing no information that is actionable on this topology.

### Fallback: hosted clusters running on a non-ACP managed Prometheus

If the management cluster's monitoring stack is a self-assembled OSS Prometheus / Prometheus Operator deployment outside ACP's `observability/monitor` surface, the same two mitigations apply against the same CRDs (`PrometheusRule`, `Alertmanager` config), with identical YAML; the only difference is the namespace where the operator and Alertmanager live.

## Diagnostic Steps

Confirm the alert is firing and inspect its labels:

```bash
kubectl -n <monitoring-namespace> port-forward svc/alertmanager 9093:9093 &
curl -s http://127.0.0.1:9093/api/v2/alerts | \
  jq '.[] | select(.labels.alertname=="PrometheusPossibleNarrowSelectors")
       | {labels: .labels, startsAt: .startsAt}'
```

The output enumerates every active firing of the rule, with the `namespace`, `service`, and `endpoint` labels that identify *which* `ServiceMonitor` triggered it. Note which namespaces dominate the list — those are the candidates for the inhibit list.

Cross-check by listing all `ServiceMonitor` / `PodMonitor` objects in the dominating namespaces:

```bash
kubectl get servicemonitor,podmonitor -A \
  -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,SELECTOR:.spec.selector.matchLabels \
  | grep -E '<dominating-namespace-regex>'
```

These should be the per-tenant / per-VM-controller monitors expected on the topology. If a monitor in this list is *not* one you expect, do not silence it — the alert is correctly flagging an unintended narrow selector.

Confirm the monitoring stack itself is healthy (so the alert is genuinely false-positive rather than masking a different problem):

```bash
kubectl -n <monitoring-namespace> get pods
kubectl -n <monitoring-namespace> logs prometheus-k8s-0 --all-containers --tail=200 | \
  grep -iE 'error|reload'
kubectl -n <user-workload-monitoring-namespace> logs prometheus-user-workload-0 \
  --all-containers --tail=200 | grep -iE 'error|reload'
```

Transient TLS/handshake noise from `kube-rbac-proxy` containers ("connection reset by peer" during cert rotations) is normal background; persistent reload failures or cert-validation errors are not, and need to be addressed before mitigating this alert.

After the inhibit / override is applied, watch the alert volume drop:

```bash
curl -s http://127.0.0.1:9093/api/v2/alerts | \
  jq '[.[] | select(.labels.alertname=="PrometheusPossibleNarrowSelectors")] | length'
```

The expected end-state is a small steady-state count corresponding to genuine workload-namespace narrow selectors only — typically zero on a healthy cluster.
