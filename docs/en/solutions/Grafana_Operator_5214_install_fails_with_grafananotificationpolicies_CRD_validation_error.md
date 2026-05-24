---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Grafana Operator 5.21.4+ install fails with grafananotificationpolicies CRD validation error
## Issue

Installing or upgrading the Grafana Operator to version 5.21.4 (or any
later 5.x) on a cluster running Kubernetes 1.30 or earlier fails at the
CRD apply step with:

```text
CustomResourceDefinition.apiextensions.k8s.io
  "grafananotificationpolicies.grafana.integreatly.org" is invalid:
spec.validation.openAPIV3Schema.properties[spec].properties[route].x-kubernetes-validations[0].rule:
  Invalid value: "..."
  compilation failed: ERROR: input:1:5: undefined field 'continue'
```

The operator never reaches `Running`; the CRD is rejected and any
subsequent attempt to `kubectl apply` the operator manifests reports the
same error.

## Root Cause

The 5.21.4 operator release ships an updated `GrafanaNotificationPolicy`
CRD whose validation schema uses CEL (`x-kubernetes-validations`) rules
that reference the field `continue`. CEL is a CNCF expression language
embedded into Kubernetes, and `continue` is a CEL keyword; using it as a
field reference inside a CEL rule requires the CEL grammar that ships with
Kubernetes 1.31 and newer. On Kubernetes 1.30 and earlier the CEL
compiler rejects the rule with `undefined field 'continue'` because the
older grammar does not allow that identifier.

The CRD is therefore valid against newer Kubernetes API servers and
invalid against older ones. The operator manifests do not gate on the API
server version, so on an older cluster the install attempts to apply the
CRD and fails immediately. The upstream tracking issue captures the
incompatibility.

## Resolution

Pick the path that matches the cluster's Kubernetes version:

### Cluster on Kubernetes 1.31 or newer

The CRD is valid. The install fails for an unrelated reason — investigate
the actual rejection (typically RBAC, image pull, or a pre-existing CRD
collision) rather than treating it as the same issue.

### Cluster on Kubernetes 1.30 or earlier

Pin the Grafana Operator to a version below 5.21.4. The 5.21.3 release
and earlier do not include the offending CEL rule and install cleanly:

```bash
# Subscription-style operator install
kubectl edit subscription grafana-operator -n <ns>
```

Set `startingCSV` (or the equivalent version pin in your install
mechanism) to the 5.21.3 CSV and let the operator reconcile back. For a
plain Helm/kustomize install, point at the 5.21.3 chart or manifest
instead of `latest`.

After the older operator is running, hold off on upgrading to 5.21.4 or
later until the cluster has been moved to Kubernetes 1.31 or above. Plan
the upgrade in this order:

1. Upgrade the cluster to a Kubernetes version that supports the new CEL
   grammar.
2. Re-bump the Grafana Operator subscription to the latest 5.x.
3. Re-apply the CRDs; the validation now passes.

If pinning is not feasible (for example because the install pulls a
single floating tag that already moved to 5.21.4), strip the offending
CEL rule from the CRD before applying:

```bash
kubectl apply -f grafanaoperator-crds.yaml --dry-run=client -o yaml \
  | yq 'del(.spec.versions[].schema.openAPIV3Schema.properties.spec.properties.route.x-kubernetes-validations)' \
  | kubectl apply -f -
```

This bypasses the CEL check on `GrafanaNotificationPolicy.spec.route` —
runtime validation still works for everything else, but ensure your
GitOps pipeline does not re-apply the unmodified CRD on the next sync.

## Diagnostic Steps

1. Confirm the failure is the CEL-rule rejection and not a broader
   manifest problem:

   ```bash
   kubectl apply -f grafanaoperator-crds.yaml 2>&1 \
     | grep -i "undefined field 'continue'"
   ```

2. Confirm the cluster's Kubernetes minor version:

   ```bash
   kubectl version --short
   ```

   1.30 or below confirms the CEL grammar gap.

3. After pinning to 5.21.3, confirm the operator pod stays `Running` and
   the CRDs are present:

   ```bash
   kubectl get crd | grep grafana
   kubectl get pods -n <grafana-operator-ns>
   ```

4. After upgrading the cluster to 1.31+, attempt the bump to the latest
   operator version in a non-production environment first to confirm the
   CRD applies cleanly before rolling forward in production.
