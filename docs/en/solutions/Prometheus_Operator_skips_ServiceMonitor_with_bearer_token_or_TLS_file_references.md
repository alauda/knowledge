---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Prometheus stops scraping metrics from a platform namespace. The Prometheus Operator pod in the observability namespace repeatedly logs one of the following warnings:

```text
level=warn caller=operator.go:1753 component=prometheusoperator
msg="skipping servicemonitor"
error="it accesses file system via bearer token file which Prometheus specification prohibits"
servicemonitor=compliance/metrics namespace=user-workload-monitoring prometheus=user-workload
```

or:

```text
level=warn caller=resource_selector.go:126 component=prometheus-controller
msg="skipping servicemonitor"
error="it accesses file system via tls config which Prometheus specification prohibits"
servicemonitor=compliance/metrics namespace=user-workload-monitoring prometheus=user-workload
```

The target that the `ServiceMonitor` covers never appears in the Prometheus `/targets` page, so its metrics are simply missing from the time-series database.

## Root Cause

Upstream Prometheus Operator enforces a security boundary on `ServiceMonitor` / `PodMonitor` objects that reference files on disk — specifically `bearerTokenFile` and any `tlsConfig` field that names a file path (`caFile`, `certFile`, `keyFile`). Allowing an arbitrary tenant to point a scrape job at `/etc/...` inside the Prometheus pod would let that tenant exfiltrate credentials mounted into the pod, so the operator refuses to materialise those fields into the scrape configuration unless the containing namespace is explicitly trusted as part of the platform.

On ACP the observability stack classifies a small set of namespaces as trusted platform namespaces; `ServiceMonitor` objects with file-based bearer tokens or TLS material are only materialised into the scrape config when they live in one of those namespaces. Any namespace that is not on the trusted list — including one that was added after the observability component was installed — will have its `ServiceMonitor` rejected with the warning above.

## Resolution

The portable, recommended fix is to rewrite the `ServiceMonitor` so that it does not reference files on disk at all — this works for every `ServiceMonitor`, whether it lives in a platform namespace or a tenant one. Only fall back to adjusting the trusted-namespace list when the workload is genuinely a platform component and must be scraped by the platform Prometheus.

For application workloads, rewrite the `ServiceMonitor` to reference `Secret`s instead of files. Two common rewrites:

- Replace `bearerTokenFile` with `bearerTokenSecret`, which points at a `Secret` in the same namespace as the `ServiceMonitor` and is handled safely by the operator.
- Replace file-based `tlsConfig` entries with `Secret` / `ConfigMap` references. `tlsConfig.ca`, `tlsConfig.cert` and `tlsConfig.keySecret` all accept `SecretKeySelector` / `ConfigMapKeySelector` and bypass the file-path restriction.

Example of a conforming `ServiceMonitor` fragment:

```yaml
spec:
  endpoints:
    - port: metrics
      bearerTokenSecret:
        name: my-scrape-token
        key: token
      tlsConfig:
        ca:
          secret:
            name: my-scrape-tls
            key: ca.crt
        cert:
          secret:
            name: my-scrape-tls
            key: tls.crt
        keySecret:
          name: my-scrape-tls
          key: tls.key
```

For a component that truly belongs to the platform (shipped with ACP, maintained by the platform team — compliance, logging, networking operators — rather than a tenant workload), add its namespace to the trusted-namespace list consumed by the platform Prometheus instance. The exact mechanism depends on which Prometheus Operator CR fronts the stack — typically the `Prometheus` CR's `serviceMonitorNamespaceSelector` or equivalent admission control. Update the observability configuration to include the new namespace rather than hand-labelling the namespace with any legacy label string.

After the `ServiceMonitor` is updated (or the trusted-namespace list is extended), Prometheus Operator re-evaluates the object on its next reconciliation. The warning stops and the target shows up in the scrape pool within a couple of scrape intervals.

## Diagnostic Steps

Pull the Prometheus Operator logs and grep for the specific `ServiceMonitor` that is being skipped — the log line names both the namespace and the object, so it is the authoritative source for which object is the problem:

```bash
kubectl -n cpaas-system logs \
  -l app.kubernetes.io/name=prometheus-operator \
  -c prometheus-operator --tail=200 \
  | grep -E 'skipping (servicemonitor|podmonitor)'
```

Verify whether the namespace in question is on the trusted-namespace list of the platform Prometheus. Inspect the `Prometheus` CR that drives the stack (usually `prometheus-k8s` in the observability namespace) and check the namespace selector:

```bash
kubectl -n cpaas-system get prometheus k8s -o jsonpath='{.spec.serviceMonitorNamespaceSelector}{"\n"}'
kubectl -n cpaas-system get prometheus k8s -o jsonpath='{.spec.probeNamespaceSelector}{"\n"}'
```

If the selector uses a `matchLabels` or `matchExpressions` entry, ensure the target namespace carries the matching label. If the stack instead maintains an explicit allow-list, extend that list through the observability configuration source-of-truth rather than editing the CR by hand.

Inspect the offending `ServiceMonitor` to confirm which file-based field is triggering the rejection:

```bash
kubectl -n <namespace> get servicemonitor <name> -o yaml \
  | grep -E 'bearerTokenFile|caFile|certFile|keyFile'
```

Any of those four fields will cause the operator to skip the object unless the namespace is labelled as platform-trusted. Remove them and migrate to `Secret`-backed equivalents before re-applying.
