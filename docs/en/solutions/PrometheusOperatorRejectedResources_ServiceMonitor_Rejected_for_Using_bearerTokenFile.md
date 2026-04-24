---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On a cluster that ships the Cert Utils Operator (or any third-party operator that provides its own metrics scrape definition), the `PrometheusOperatorRejectedResources` alert begins firing after the operator is installed. The Prometheus Operator pod logs entries similar to:

```text
level=warn caller=resource_selector.go:174 component=prometheusoperator
  msg="skipping servicemonitor"
  error="it accesses file system via bearer token file which Prometheus specification prohibits"
  servicemonitor=cert-utils-operator/cert-utils-operator-controller-manager-metrics-monitor
  namespace=<user-workload-monitoring-ns> prometheus=user-workload
```

The `ServiceMonitor` is never admitted into the generated scrape config, no targets are created for that operator, and its metrics are therefore missing from the user-workload Prometheus.

## Root Cause

In ACP `observability/monitor`, the user-workload Prometheus is configured with `arbitraryFSAccessThroughSMs.deny: true` on the `Prometheus` custom resource. That flag is a deliberate security boundary: any `ServiceMonitor` that uses a `bearerTokenFile` or a `tlsConfig.caFile` pointing at the host filesystem is rejected during rendering, because accepting it would let a tenant-owned `ServiceMonitor` arrive with a path like `/var/run/secrets/kubernetes.io/serviceaccount/token` and smuggle that file into the Prometheus scrape config.

The Cert Utils Operator (and several other third-party operators) ship a `ServiceMonitor` that predates this tightening and still authenticates via `bearerTokenFile`:

```yaml
# rejected by the user-workload Prometheus
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cert-utils-operator-controller-manager-metrics-monitor
spec:
  endpoints:
    - bearerTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
```

The modern, accepted alternative is `authorization.credentials` backed by a `Secret` reference (`bearerTokenSecret`), which the operator pulls at render time through the Kubernetes API rather than reading a file from disk.

## Resolution

Fix the upstream `ServiceMonitor` to use a Secret reference, or — while waiting for that fix to ship — silence the alert and work around the rejection.

### 1. Correct fix: migrate the ServiceMonitor to authorization.credentials

Replace the `bearerTokenFile` endpoint with a reference to a `Secret` that holds the token. The service account token secret is the natural source:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cert-utils-operator-controller-manager-metrics-monitor
  namespace: cert-utils-operator
spec:
  endpoints:
    - port: https
      scheme: https
      authorization:
        credentials:
          name: cert-utils-operator-metrics-token
          key: token
      tlsConfig:
        insecureSkipVerify: true    # or supply a CA via ca.secret
```

Create the backing Secret (a service-account-token type Secret linked to the operator's metrics-reader service account):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cert-utils-operator-metrics-token
  namespace: cert-utils-operator
  annotations:
    kubernetes.io/service-account.name: cert-utils-operator-controller-manager-metrics-reader
type: kubernetes.io/service-account-token
```

The Prometheus Operator can now resolve the bearer token without accessing the filesystem; the `arbitraryFSAccessThroughSMs.deny` guard is satisfied and the target becomes visible. This is the permanent fix and should be sent upstream to the operator so the next release no longer trips the alert.

### 2. If you cannot edit the upstream ServiceMonitor

Two holding patterns are available:

- **Silence the alert.** Create an Alertmanager silence scoped to `alertname=PrometheusOperatorRejectedResources` and the specific `servicemonitor` label, with a finite expiry and a note pointing at the upstream fix tracker. Silencing stops the paging noise without hiding the underlying rejection — the warning log line is still there.
- **Host the fixed ServiceMonitor alongside the operator.** Deploy a second, correctly-configured `ServiceMonitor` that scrapes the same Service (different `metadata.name`, same `selector`). The broken one is ignored; the new one is accepted. Remove it when the operator ships the fix.

Do not disable `arbitraryFSAccessThroughSMs.deny` on the user-workload Prometheus. Lowering that guard cluster-wide to admit one misconfigured `ServiceMonitor` exposes every tenant namespace to the same file-smuggling risk the flag is there to prevent.

## Diagnostic Steps

1. Confirm the alert is firing for the user-workload Prometheus and not the platform one:

   ```bash
   kubectl -n <monitoring-ns> get prometheus \
     -o custom-columns=NAME:.metadata.name,FSDENY:.spec.arbitraryFSAccessThroughSMs.deny
   ```

   The alert fires on Prometheus instances with `FSDENY=true`.

2. List Prometheus Operator pod logs and extract the offending ServiceMonitor names:

   ```bash
   kubectl -n <user-workload-monitoring-ns> logs deploy/prometheus-operator \
     | grep 'bearer token file' \
     | awk '{for (i=1;i<=NF;i++) if ($i ~ /servicemonitor=/) print $i}' \
     | sort -u
   ```

3. For each rejected ServiceMonitor, inspect the offending endpoint:

   ```bash
   kubectl -n <sm-ns> get servicemonitor <name> -o json \
     | jq '.spec.endpoints[] | {port,bearerTokenFile,tlsConfig}'
   ```

4. After applying the fix (either migrated `ServiceMonitor` or a parallel one), re-check that the target appears in Prometheus:

   ```bash
   kubectl -n <monitoring-ns> exec deploy/prometheus -- \
     wget -qO- 'http://localhost:9090/api/v1/targets' \
     | grep -A2 cert-utils-operator
   ```

   The target's `health` should flip from absent to `up`. The alert clears on its next evaluation cycle.
