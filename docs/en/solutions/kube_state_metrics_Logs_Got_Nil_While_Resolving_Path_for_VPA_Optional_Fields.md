---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After installing the Vertical Pod Autoscaler (VPA) operator on Alauda Container Platform and creating one or more `VerticalPodAutoscaler` resources without specifying the optional `minAllowed` / `maxAllowed` fields, the cluster monitoring stack starts showing two related symptoms:

- `kube-state-metrics` (KSM) repeatedly logs nil-path errors for the VPA custom resource state metrics, multiple times per minute, per VPA object:

  ```text
  E0730 06:30:55.062178 1 registry_factory.go:685]
    "kube_customresource_verticalpodautoscaler_spec_resourcepolicy_container_policies_minallowed_cpu"
    err="[spec,resourcePolicy,containerPolicies]: got nil while resolving path"
  E0730 06:30:55.062223 1 registry_factory.go:685]
    "kube_customresource_verticalpodautoscaler_spec_resourcepolicy_container_policies_minallowed_memory"
    err="[spec,resourcePolicy,containerPolicies]: got nil while resolving path"
  ```

- The platform Prometheus stack triggers `PrometheusDuplicateTimestamps` warnings in the monitoring namespace, scoped to the same custom-resource-state metrics.

The VPA itself works correctly — the `Recommendations` keep updating and pods are vertically autoscaled — but the noisy logs and Prometheus alerts make the monitoring channel unusable.

## Root Cause

KSM's custom-resource-state (CRS) configuration for VPA declares metric paths that descend into `spec.resourcePolicy.containerPolicies[*].minAllowed.cpu`, etc. The VPA CRD lets the operator omit `resourcePolicy` and `containerPolicies` entirely (they are optional) — when omitted, the path resolver hits `nil` partway down and emits the "got nil while resolving path" error per metric per VPA per scrape. Each scrape also re-emits the same metric series with no labels, which Prometheus then sees as duplicate timestamps.

The error is purely a missing-field-tolerance bug in KSM's CRS path traversal; the VPA spec is valid. Fixing the KSM config (or replacing the path with a guarded variant) silences both symptoms without changing how VPA operates.

## Resolution

Two paths — one tactical (silence the noise quickly), one strategic (give KSM a tolerant CRS spec).

### Tactical: scope the KSM CRS metric so it only emits for VPAs that fill the optional fields

Edit the `ConfigMap` that holds KSM's custom-resource-state config (the exact name varies; look for one referenced by the KSM Deployment as `--custom-resource-state-config-file`):

```bash
kubectl -n <monitoring-ns> get deploy kube-state-metrics -o yaml \
  | grep -A2 custom-resource-state-config-file
```

In that ConfigMap, locate the VPA metric definition and gate it with a `path-must-exist` style check. The schema differs slightly between KSM versions; the substantive change is to make the entire `containerPolicies[*]` traversal conditional on the parent objects being non-nil. For KSM `v2.x`:

```yaml
metrics:
- name: verticalpodautoscaler_spec_resourcepolicy_container_policies_minallowed_cpu
  help: Minimum CPU allowed
  each:
    type: Gauge
    gauge:
      path: [spec, resourcePolicy, containerPolicies]
      valueFrom: [minAllowed, cpu]
      labelsFromPath:
        container: [containerName]
  # KSM v2.10+: tolerate missing intermediate fields
  errorLogV: 5     # demote nil-path messages out of the default warn level
```

`errorLogV: 5` (or whatever the deployed KSM version expects) drops the per-scrape error to a verbose level that no longer pollutes the default log stream nor inflates the duplicate-timestamp alert.

### Strategic: rewrite the metric definitions to be optional-aware

If your KSM image is recent enough to support nested-optional CRS (`type: Gauge` with `valueFrom` operating on a possibly-empty path returning no metric), replace the brittle entries with the optional-aware shape:

```yaml
metrics:
- name: verticalpodautoscaler_spec_resourcepolicy_container_policies_minallowed_cpu
  help: Minimum CPU allowed
  each:
    type: Gauge
    gauge:
      path: [spec, resourcePolicy, containerPolicies]
      valueFrom: [minAllowed, cpu]
      labelsFromPath:
        container: [containerName]
      nilIsZero: false      # do not emit a series when the path is nil
```

Roll out by re-applying the ConfigMap and bouncing the KSM Deployment:

```bash
kubectl -n <monitoring-ns> rollout restart deploy/kube-state-metrics
```

The errors should stop within one scrape cycle.

### Cosmetic alternative: declare the optional fields on every VPA

If you cannot edit the KSM CRS config (managed monitoring stack), add `resourcePolicy.containerPolicies[*].minAllowed` / `maxAllowed` to every VPA you author, even if you only fill them with the autoscaler's own defaults. The path is then never nil and KSM stops complaining. This trades operator effort for ConfigMap edits.

## Diagnostic Steps

1. Confirm the symptom is the optional-field bug and not a misshapen VPA:

   ```bash
   kubectl -n <monitoring-ns> logs deploy/kube-state-metrics \
     | grep "got nil while resolving path" | head
   ```

   The error text matching `[spec,resourcePolicy,containerPolicies]` confirms the cause.

2. Cross-reference with the VPA objects that are missing the field:

   ```bash
   kubectl get vpa -A -o json | jq -r '
     .items[]
     | select(.spec.resourcePolicy.containerPolicies // null == null)
     | "\(.metadata.namespace)/\(.metadata.name)"'
   ```

   Every entry returned is a contributor to the noise.

3. After applying the KSM ConfigMap change and restarting KSM, watch the duplicate-timestamps alert clear:

   ```bash
   kubectl -n <monitoring-ns> exec deploy/alertmanager -- \
     amtool alert query alertname=PrometheusDuplicateTimestamps
   ```

4. If the alert does not clear, check that the new ConfigMap really mounted into the KSM pod:

   ```bash
   kubectl -n <monitoring-ns> exec deploy/kube-state-metrics \
     -- cat /etc/custom-resource-state/config.yaml | head -30
   ```

   A stale mount (Deployment annotations not bumped on ConfigMap change) keeps KSM running on the old config.
