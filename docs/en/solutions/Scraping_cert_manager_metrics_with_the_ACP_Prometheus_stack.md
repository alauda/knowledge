---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.3.x
id: KB260500154
---

# Scraping cert-manager metrics with the ACP Prometheus stack

## Issue

On Alauda Container Platform v4.3.13 with cert-manager controller image `registry.alauda.cn:60080/3rdparty/cert-manager-controller:v1.17.18-v4.3.1`, certificate lifecycle data (in particular the per-`Certificate` expiration timestamp) is exposed by the controller as Prometheus metrics, but the cluster's monitoring stack (`prometheus-operator:v0.91.0`, Prometheus CR `cpaas-system/kube-prometheus-0`) does not scrape that endpoint out of the box. Until a scrape configuration is added, queries such as `certmanager_certificate_expiration_timestamp_seconds` return no series and dashboards or alerts that depend on certificate expiry stay empty.

## Root Cause

The cert-manager controller publishes its Prometheus metrics on a dedicated service port — port `9402/TCP`, named `tcp-prometheus-servicemonitor` — on the cert-manager Service in the `cert-manager` namespace; the controller pods that back that port carry the labels `app.kubernetes.io/component=controller` and `app.kubernetes.io/name=cert-manager`. The metric family `certmanager_certificate_expiration_timestamp_seconds` lives on this endpoint and carries labels including `namespace`, `name`, `issuer_kind`, and `issuer_name`, so it can be filtered per Certificate object. Nothing on the cluster scrapes that endpoint until a scrape configuration explicitly selects it.

## Resolution

Create a `ServiceMonitor` (`monitoring.coreos.com/v1`) in the `cert-manager` namespace whose selector matches the cert-manager controller Service labels and whose port name points at the metrics port. The cluster Prometheus picks up the new `ServiceMonitor` and adds a scrape job that targets the metrics endpoint:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cert-manager
  namespace: cert-manager
  labels:
    app.kubernetes.io/component: controller
    app.kubernetes.io/name: cert-manager
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: controller
      app.kubernetes.io/name: cert-manager
  endpoints:
    - port: tcp-prometheus-servicemonitor
      interval: 60s
      scheme: http
```

Apply the manifest:

```bash
kubectl apply -f cert-manager-servicemonitor.yaml
```

Once Prometheus reloads its configuration, the metric family `certmanager_certificate_expiration_timestamp_seconds` becomes queryable and individual certificates can be selected by their `namespace`, `name`, `issuer_kind`, and `issuer_name` label values for dashboards or alert expressions.

## Diagnostic Steps

Confirm the metrics endpoint shape before creating the `ServiceMonitor` — the port name and number must match what the selector and `endpoints[].port` will reference:

```bash
kubectl -n cert-manager get svc cert-manager \
  -o jsonpath='{.spec.ports[?(@.name=="tcp-prometheus-servicemonitor")]}'
```

The output reports port number `9402` and protocol `TCP`. Inspect the pod labels that back the Service to confirm the controller selector resolves to a running replica:

```bash
kubectl -n cert-manager get pod \
  -l app.kubernetes.io/component=controller,app.kubernetes.io/name=cert-manager
```

After applying the `ServiceMonitor`, verify the scrape took effect by querying the metric directly from Prometheus. Series should be returned (one per `Certificate` object), each carrying `namespace`, `name`, `issuer_kind`, and `issuer_name` labels:

```bash
kubectl -n cpaas-system exec statefulset/prometheus-kube-prometheus-0 -c prometheus -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=certmanager_certificate_expiration_timestamp_seconds'
```

If the query returns zero series, recheck that the `ServiceMonitor` lives in the `cert-manager` namespace, that its `selector.matchLabels` are exactly `app.kubernetes.io/component=controller` and `app.kubernetes.io/name=cert-manager`, and that `endpoints[].port` is the string `tcp-prometheus-servicemonitor` (the port *name*, not `9402`) — these are the fields the scrape config is derived from.
