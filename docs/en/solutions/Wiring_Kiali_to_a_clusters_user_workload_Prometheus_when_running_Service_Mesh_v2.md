---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Service Mesh v2 install does not deploy Kiali by default, and even after Kiali is installed it does not pull telemetry from the cluster's existing user-workload monitoring stack out of the box. Operators want a Kiali instance that reads Istio metrics from the same Prometheus the rest of the platform uses — so Kiali graphs match what Grafana already shows and there is no second copy of the same time-series data.

The end state: the workload's Envoy sidecars expose Istio metrics on `:15020/stats/prometheus`, the cluster's Prometheus scrapes that endpoint via a `ServiceMonitor`, and Kiali queries Prometheus through Thanos to render the topology and golden-signal panels.

## Root Cause

Kiali expects a single Prometheus URL it can talk to. Service Mesh v2 ships with no opinion on which Prometheus to use, leaving three pieces unwired:

- The Kiali CR has no `external_services.prometheus` configured, so by default it tries to discover a per-mesh Prometheus that doesn't exist on a cluster that uses a shared user-workload monitoring stack.
- The Envoy sidecars are not listed as scrape targets in the user-workload Prometheus — without a `ServiceMonitor` describing the Istio metrics endpoint, there are no time-series for Kiali to query.
- Kiali's ServiceAccount has no permission to read metrics from the platform's monitoring view, which is governed by the `cluster-monitoring-view` ClusterRole.

The fix wires all three: a ClusterRoleBinding granting Kiali metric read, a Kiali CR that points at the platform's Thanos Querier, and a ServiceMonitor in each application namespace that captures Envoy's metrics endpoint.

## Resolution

Bind Kiali's ServiceAccount to the cluster monitoring viewer role so the Prometheus query through Thanos is authorised:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kiali-monitoring-rbac
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-monitoring-view
subjects:
  - kind: ServiceAccount
    name: kiali-service-account
    namespace: istio-system
```

Deploy the Kiali CR pointing at the cluster's Thanos Querier endpoint. The Kiali pod authenticates with its own ServiceAccount token (`use_kiali_token: true`) and the binding above authorises the reads:

```yaml
apiVersion: kiali.io/v1alpha1
kind: Kiali
metadata:
  name: kiali
  namespace: istio-system
spec:
  version: default
  istio_namespace: istio-system
  deployment:
    logger:
      log_level: info
    view_only_mode: false
  external_services:
    prometheus:
      auth:
        type: bearer
        use_kiali_token: true
      thanos_proxy:
        enabled: true
      url: https://thanos-querier.monitoring.svc.cluster.local:9091
```

The `thanos_proxy.enabled: true` flag matters: without it Kiali sends Prometheus-native API calls to the Querier and several requests fail in subtle ways (label values endpoints behave differently, range queries can return empty for valid windows). Enabling the Thanos proxy mode tells Kiali to reshape its requests for the Querier's API.

For each application namespace whose workloads have an Envoy sidecar, drop a `ServiceMonitor` that scrapes the per-pod sidecar metrics endpoint:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: istio-sidecars
  namespace: <application-namespace>
spec:
  selector:
    matchExpressions:
      - key: istio-prometheus-ignore
        operator: DoesNotExist
  endpoints:
    - interval: 30s
      path: /stats/prometheus
      relabelings:
        - action: keep
          regex: istio-proxy
          sourceLabels:
            - __meta_kubernetes_pod_container_name
        - action: keep
          sourceLabels:
            - __meta_kubernetes_pod_annotationpresent_prometheus_io_scrape
        - action: replace
          regex: (\d+);(([A-Fa-f0-9]{1,4}::?){1,7}[A-Fa-f0-9]{1,4})
          replacement: '[$2]:$1'
          sourceLabels:
            - __meta_kubernetes_pod_annotation_prometheus_io_port
            - __meta_kubernetes_pod_ip
          targetLabel: __address__
        - action: replace
          regex: (\d+);((([0-9]+?)(\.|$)){4})
          replacement: $2:$1
          sourceLabels:
            - __meta_kubernetes_pod_annotation_prometheus_io_port
            - __meta_kubernetes_pod_ip
          targetLabel: __address__
        - action: labeldrop
          regex: __meta_kubernetes_pod_label_(.+)
        - action: replace
          sourceLabels:
            - __meta_kubernetes_namespace
          targetLabel: namespace
        - action: replace
          sourceLabels:
            - __meta_kubernetes_pod_name
          targetLabel: pod_name
```

The relabel chain is doing two things: (1) only scrape the `istio-proxy` container, (2) read the port from the pod's `prometheus.io/port` annotation so the scrape works whether the application uses IPv4 or IPv6 networking. Workloads that explicitly opt out via the `istio-prometheus-ignore` label are excluded.

Apply, wait one scrape interval (30 seconds in the example), and check that Prometheus has new targets for the namespace's istio-proxy containers. Within another scrape interval Kiali starts populating the namespace overview and traffic graph for any workload that is generating real requests.

## Diagnostic Steps

Confirm the user-workload Prometheus has the new scrape targets after applying the `ServiceMonitor`:

```bash
kubectl -n monitoring port-forward svc/thanos-querier 9091:9091 &
curl -s -k -G \
  --data-urlencode 'query=up{container="istio-proxy"}' \
  https://localhost:9091/api/v1/query | jq '.data.result[0]'
```

A non-empty result with `value[1] = "1"` for the relevant pods means the scrape is healthy.

If Kiali shows "Data is unavailable" on the topology view, walk the wiring backwards:

```bash
kubectl -n istio-system logs deploy/kiali --tail=200 | grep -i 'prometheus\|thanos'
```

The Kiali pod logs the URL it tried, the auth mode, and the response code. Common failure responses:

- `403 Forbidden` — the ClusterRoleBinding is missing or names the wrong namespace for the ServiceAccount.
- `404 Not Found` on `/api/v2/labels` — `thanos_proxy.enabled` is `false` in the Kiali CR.
- `connection refused` or DNS lookup failures — the `url` in the Kiali CR doesn't match the Thanos Querier service in this cluster.

Verify the Envoy sidecar is actually emitting metrics from inside an application pod:

```bash
kubectl -n <application-namespace> exec deploy/<workload> -c istio-proxy -- \
  curl -s localhost:15020/stats/prometheus | head -20
```

A long output with `istio_requests_total`, `istio_request_duration_milliseconds_bucket`, etc. confirms the sidecar side is healthy. If this is empty, the sidecar isn't reporting Istio telemetry — usually because the workload sees no traffic yet, or because the namespace label that triggers sidecar injection is missing.

After the topology view starts populating, send sustained traffic to the workload (load generator, smoke test) for one or two scrape intervals and the namespace edges will show end-to-end on the Kiali graph.
