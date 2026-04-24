---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After installing or upgrading the Loki operator (the OSS project that backs ACP `observability/log` and the extension **Logging Service** — see `kb/ACP_CAPABILITIES.md`), the `PrometheusOperatorRejectedResources` alert starts firing for the Loki metrics monitor. The Prometheus Operator logs entries similar to:

```text
level=warn caller=operator.go:1917 component=prometheusoperator
  msg="skipping servicemonitor"
  error="failed to get CA: unable to get secret
         \"loki-operator-controller-manager-metrics-token\":
         secrets \"loki-operator-controller-manager-metrics-token\" not found"
  servicemonitor=<loki-ns>/loki-operator-metrics-monitor
```

Listing secrets in the Loki operator namespace confirms the expected token secret is absent:

```bash
kubectl -n <loki-operator-ns> get secret \
  loki-operator-controller-manager-metrics-token
# Error from server (NotFound): secrets "loki-operator-controller-manager-metrics-token" not found
```

The ServiceMonitor exists, the namespace is correctly labelled for monitoring scrape, and the metrics endpoint is reachable — only the token secret that the ServiceMonitor needs to authenticate is missing. No Loki operator metrics reach Prometheus until the secret is restored.

## Root Cause

The Loki operator's install bundle ships a `Secret` of type `kubernetes.io/service-account-token` that is annotated to bind to the operator's metrics-reader `ServiceAccount`. That secret is required by the accompanying `ServiceMonitor`, which references `loki-operator-controller-manager-metrics-token` as the CA / token source.

Under some install and upgrade paths — typically when the operator is installed, uninstalled, and reinstalled without removing its CRD instances, or when an upgrade reconciles bundles in a way that drops the secret — the service-account-token secret is not re-created. The ServiceAccount itself, the ClusterRole, the ClusterRoleBinding, and the ServiceMonitor are all present; only the token secret is missing. Because the upstream `Secret` object uses the modern "annotated token" flavour (not a token auto-provisioned by the controller manager), Kubernetes does not re-create it spontaneously.

## Resolution

Two paths are available. The first is a surgical recreate of the missing secret; the second is a full reinstall of the operator while preserving its custom resources.

### Option 1 — Recreate the token secret directly

Apply the secret manifest with the original annotations and labels so subsequent reconciliations leave it alone:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: loki-operator-controller-manager-metrics-token
  namespace: <loki-operator-ns>        # the namespace where Loki operator is installed
  annotations:
    kubernetes.io/service-account.name: loki-operator-controller-manager-metrics-reader
  labels:
    app.kubernetes.io/instance: loki-operator-0.1.0
    app.kubernetes.io/managed-by: operator-lifecycle-manager
    app.kubernetes.io/name: loki-operator
    app.kubernetes.io/part-of: cluster-logging
    app.kubernetes.io/version: "0.1.0"
type: kubernetes.io/service-account-token
```

```bash
kubectl apply -f loki-operator-metrics-token.yaml

# confirm the token was minted
kubectl -n <loki-operator-ns> get secret \
  loki-operator-controller-manager-metrics-token \
  -o jsonpath='{.data.token}' | base64 -d | head -c 40 ; echo
```

Make sure:
- The service account referenced in `kubernetes.io/service-account.name` actually exists (`kubectl -n <loki-operator-ns> get sa loki-operator-controller-manager-metrics-reader`). If it does not, the controller will not populate the token.
- The labels match the install bundle so OLM-like reconciliation does not treat the secret as foreign and delete it.

Once the controller manager populates the token, the Prometheus Operator re-reconciles the ServiceMonitor and the target becomes scrapable. The alert clears on the next evaluation.

### Option 2 — Reinstall the operator, preserving CRs

If multiple supporting objects are missing (not just the token secret) a clean reinstall often restores them all:

1. Uninstall the Loki operator.
2. When prompted, keep the `LokiStack` (and any other) custom resources — do not cascade-delete them.
3. Reinstall the same version of the operator. The install bundle re-creates the metrics token secret alongside the other resources.

The user-facing log data and indices are owned by the `LokiStack` CR, not by the operator workload, so preserving the CR during the reinstall keeps the backing storage intact.

This failure mode has reappeared at later upgrades in some environments. If that happens, the secret manifest above can be kept as a permanent add-on alongside the operator install so every upgrade cycle has a known-good token ready. The OSS fix in the upstream operator repository eventually lands in newer releases of the Logging Service; staying current removes the workaround.

## Diagnostic Steps

1. Confirm the missing secret is the actual cause of the rejected ServiceMonitor:

   ```bash
   kubectl -n <user-workload-monitoring-ns> logs deploy/prometheus-operator \
     | grep -i 'loki-operator-controller-manager-metrics-token'
   ```

2. List the secrets that do exist in the Loki operator namespace to rule out a name drift:

   ```bash
   kubectl -n <loki-operator-ns> get secrets \
     | grep -Ei 'loki|metrics|controller-manager'
   ```

3. Verify the referenced ServiceAccount exists (the token cannot populate without it):

   ```bash
   kubectl -n <loki-operator-ns> get sa \
     loki-operator-controller-manager-metrics-reader
   ```

4. After applying the recreated secret or reinstalling, watch the ServiceMonitor become accepted:

   ```bash
   kubectl -n <user-workload-monitoring-ns> logs deploy/prometheus-operator \
     --since=5m | grep -Ei 'loki-operator.*(skipping|accepted|reconcil)'
   ```

5. Port-forward the Loki operator metrics service and confirm the endpoint is reachable using the new token before trusting the Prometheus target list:

   ```bash
   TOKEN=$(kubectl -n <loki-operator-ns> get secret \
     loki-operator-controller-manager-metrics-token \
     -o jsonpath='{.data.token}' | base64 -d)

   kubectl -n <loki-operator-ns> port-forward svc/loki-operator-controller-manager-metrics-service 8443:8443 &
   curl -sk -H "Authorization: Bearer $TOKEN" https://localhost:8443/metrics | head
   ```

The same pattern applies to other OSS operators whose install bundles ship an annotated service-account-token: if the secret is lost, recreate it with the exact annotation and labels the bundle expects, then let the normal controller flow re-mint the token.
