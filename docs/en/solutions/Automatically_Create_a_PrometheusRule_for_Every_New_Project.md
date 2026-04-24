---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Cluster operators are tired of repeating themselves: every time a new tenant project is provisioned, somebody has to remember to land a baseline `PrometheusRule` in that namespace so the tenant's user-workload monitoring picks it up. Without that rule, alerts the platform team has standardised on (for example, "this project's example app is reporting an error condition") simply do not exist for the new namespace, and the tenant's view is silent until the operator notices and fixes it. The desired state is: a project is created, the standard `PrometheusRule` lands automatically, and no operator has to be in the loop.

## Root Cause

This is not a bug; it is a missing piece of namespace-bootstrap automation. The `PrometheusRule` CRD is namespaced — rules in namespace A do not evaluate against series scoped to namespace B unless the user-workload Prometheus is configured to flatten them, and even then the recommended pattern is one rule object per project so the tenant owns and can edit their copy. The work the platform team is doing by hand at project-creation time is exactly the work that a project-bootstrap mechanism is designed to eliminate.

ACP exposes two complementary surfaces that solve this:

- **observability/monitor** — the in-platform Prometheus + Alertmanager + (Thanos) stack that consumes `PrometheusRule` objects from any namespace it is configured to watch.
- **security/project** — project lifecycle, including the resources that get materialised when a new project is created (quota, role bindings, network policies… and arbitrary additional objects).

The shape of the solution is therefore: *teach the project-creation flow to materialise a `PrometheusRule` along with the rest of the project's bootstrap resources*.

## Resolution

### Preferred: add the PrometheusRule to ACP's project bootstrap

The project surface in ACP allows the set of resources created at project creation time to be extended. Whether that extension is configured through a project template object, an admission-time policy, or a dedicated bootstrap CR depends on the cluster's project mode — the underlying mechanism is the same: a list of object templates that the project controller renders into the new namespace at creation time, with the namespace name substituted in.

The object to add to that list is a `PrometheusRule`. A minimal example:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: example-alert
  # The project controller substitutes the new namespace here at materialisation time.
  namespace: ${PROJECT_NAME}
  labels:
    # Label so the user-workload Prometheus selector in this cluster picks it up;
    # adjust to whatever ruleSelector the observability stack is configured with.
    app.kubernetes.io/managed-by: cpaas-platform
spec:
  groups:
    - name: example
      rules:
        - alert: VersionAlert
          for: 1m
          expr: version{job="prometheus-example-app"} == 0
          labels:
            severity: warning
          annotations:
            message: This is an example alert.
```

Two important details:

- **Namespace substitution.** The `${PROJECT_NAME}` placeholder follows the project-template convention used by the project controller; whatever placeholder the cluster's project-bootstrap mechanism uses goes in `metadata.namespace`. The rule object lands in the new namespace, not in the project-template's own namespace.
- **Label / selector compatibility.** The user-workload Prometheus has a `ruleSelector` (and a `ruleNamespaceSelector`) that decides which `PrometheusRule` objects it picks up. The labels on the templated rule must match that selector or the rule will be created but never evaluated. Confirm the selector with:

  ```bash
  kubectl -n cpaas-monitoring get prometheus -o yaml \
    | yq '.items[].spec.ruleSelector,.items[].spec.ruleNamespaceSelector'
  ```

  and adjust the templated rule's labels to match.

Add the `PrometheusRule` to whatever bootstrap surface ACP project provisioning is configured with (commonly: extend the project template object referenced by the project controller, or attach the rule as an extra resource on the project CR). After that change, every project created via the standard flow lands the rule immediately. Existing projects are not back-filled; if they need the rule too, apply it to them out-of-band one time.

### Cross-project (multi-namespace) alerts

If the goal is *one* rule that spans many existing namespaces rather than per-project rules, define the alert as an aggregation across labels (`sum by (namespace) (...)`) and place a single `PrometheusRule` in a platform-owned namespace whose labels match the user-workload Prometheus's `ruleSelector`. That single rule then evaluates the same expression across every namespace in scope. This is a different shape from the per-project bootstrap above and is the right answer when the alert *cannot* be expressed as "this rule, in every namespace independently" (for example, when comparing across namespaces is the point).

### Fallback: vanilla Prometheus Operator without the project bootstrap

When the cluster has no project-bootstrap surface to extend (a self-managed Prometheus Operator running directly on standard Kubernetes, no ACP project layer), the equivalent is one of:

- A small admission webhook (or an ACP-style `OPA` / `Kyverno` policy with a `generate` rule) that watches `Namespace` create events and renders a `PrometheusRule` object into the new namespace.
- A GitOps job (Argo CD `ApplicationSet` keyed off the cluster's namespace list) that materialises a `PrometheusRule` per namespace from a single template.

Either approach reaches the same end state — every new namespace acquires the standard `PrometheusRule` automatically — without depending on a project-creation mechanism that the cluster does not have.

## Diagnostic Steps

Confirm the rule was created in a freshly bootstrapped project:

```bash
kubectl create namespace test-project-123        # or via the project flow
kubectl -n test-project-123 get prometheusrule
# NAME            AGE
# example-alert   9s
```

If the `PrometheusRule` appears but the alert never evaluates, the rule was not picked up by the user-workload Prometheus. Check:

```bash
# Is the rule selector matching the rule's labels?
kubectl -n cpaas-monitoring get prometheus -o yaml \
  | yq '.items[].spec.ruleSelector,.items[].spec.ruleNamespaceSelector'

kubectl -n test-project-123 get prometheusrule example-alert -o yaml \
  | yq '.metadata.labels'
```

If the labels do not match, fix the templated rule (or fix the Prometheus's selector) so the two agree. After the change, the Prometheus Operator reconciles the rule into the Prometheus configuration and the alert begins evaluating within seconds.

If the `PrometheusRule` does *not* appear in a new project at all, the bootstrap surface did not materialise it. Look at the project controller's logs for a warning about a failed render or a missing CRD — a common first failure is that the cluster's user-workload monitoring is disabled and the `PrometheusRule` CRD itself is not installed in the API server, in which case the bootstrap render fails silently and the rule is dropped.

Verify the alert can fire by exercising the underlying expression:

```bash
# Send a quick query to the user-workload Prometheus through the platform's query proxy.
kubectl -n cpaas-monitoring exec -it deploy/prometheus-user-workload -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=ALERTS{alertname="VersionAlert"}'
```

A response with `status: success` and an entry in `data.result` means the alert is being evaluated and is in the state the expression describes (firing or pending). An empty `data.result` simply means the underlying series has not crossed the threshold yet — that is the normal state.

For new projects going forward, the bootstrap is a one-time configuration task; the only follow-up work is the next time the standard rule itself changes (in which case the templated definition gets updated, and existing projects are either back-filled with a one-shot `kubectl apply` loop or left to update on their own schedule).
