---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Configuring Prometheus remoteWrite and queueConfig on ACP

## Overview

Alauda Container Platform does not ship a Cluster Monitoring Operator, and there is no `cluster-monitoring-config` configmap on the platform; on this ACP install profile, remote-write tuning is configured on the upstream `Prometheus` custom resource (`prometheuses.monitoring.coreos.com/v1`) managed by the prometheus-operator, delivered through the `prometheus-operator` OperatorBundle (alpha channel) and reconciled in practice by the `prometheus` ModulePlugin via its `chart-kube-prometheus` release.

This reference documents the shape of `Prometheus.spec.remoteWrite[]` and its two sub-blocks (`queueConfig`, `metadataConfig`) as defined by the bundled CRD, plus the runtime configuration inspection endpoint exposed inside any Prometheus pod.

## Issue

Upstream guidance that targets the `cluster-monitoring-config` configmap does not apply on ACP: there is no Cluster Monitoring Operator and no sibling configmap whose `config.yaml` key the operator would render into the Prometheus configuration. On the current alpha channel of the `prometheus-operator` bundle, remote-write tuning is performed directly on the `Prometheus` CR managed by the prometheus-operator, or through the chart values that the `prometheus` ModulePlugin's `chart-kube-prometheus` release reconciles into that CR; editing a configmap modelled on the upstream KB has no effect because no controller consumes it.

## Resolution

Remote-write endpoints live as a list under `Prometheus.spec.remoteWrite[]`. Each list entry describes one remote-write target and carries its own queue tuning, metadata tuning, authentication, TLS, and relabel rules — entries are independent and may point at different remote stores with different tuning profiles.

Per remote-write entry, queue tuning is grouped under `queueConfig`, which exposes ten fields. Duration-typed fields (`batchSendDeadline`, `minBackoff`, `maxBackoff`, `sampleAgeLimit`) are strings constrained by the upstream duration pattern that accepts compositions of `y / w / d / h / m / s / ms` units (e.g. `5s`, `30s`, `2m`, `1d12h`) or a literal `0`; fractional seconds such as `0.5s` are not accepted. The remaining fields are integers or booleans:

| Field | Type | Purpose |
| --- | --- | --- |
| `capacity` | int | Per-shard in-memory queue capacity |
| `minShards` | int | Lower bound on shard count |
| `maxShards` | int | Upper bound on shard count |
| `maxSamplesPerSend` | int | Samples batched into a single request |
| `batchSendDeadline` | duration | Maximum wait before flushing a partial batch |
| `minBackoff` | duration | Initial backoff between retries |
| `maxBackoff` | duration | Backoff ceiling |
| `maxRetries` | int | Per-request retry budget |
| `retryOnRateLimit` | bool | Whether to retry on HTTP 429 |
| `sampleAgeLimit` | duration | Drop samples older than this before sending |

Metadata replication is configured through a separate sub-block `metadataConfig` on the same remote-write entry. It carries three fields — `send` (bool), `sendInterval` (duration string), `maxSamplesPerSend` (int) — and the integer `maxSamplesPerSend` here is distinct from the field of the same name inside `queueConfig` despite the naming collision.

Field names inside `queueConfig` are camelCase on the Kubernetes CR side (`maxSamplesPerSend`, `batchSendDeadline`, `minBackoff`, ...); the upstream Prometheus raw configuration file uses snake_case for the same tunables (`max_samples_per_send`, `batch_send_deadline`, `min_backoff`, ...). The prometheus-operator is responsible for the case conversion, and a case mismatch in the CR fails CRD admission instead of being silently ignored.

The following manifest illustrates a single remote-write entry with both tuning blocks populated. On a ModulePlugin-managed install the chart already reconciles a `Prometheus` CR in `cpaas-system`; edit that existing CR (for example with `kubectl edit prometheus -n cpaas-system <cr-name>`) rather than applying a sibling manifest, otherwise a second, chart-orphaned `Prometheus` CR is created alongside the chart-managed one:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: <prometheus-cr-name>
  namespace: cpaas-system
spec:
  remoteWrite:
    - url: https://remote-write.example.invalid/api/v1/write
      queueConfig:
        capacity: 10000
        minShards: 1
        maxShards: 50
        maxSamplesPerSend: 2000
        batchSendDeadline: 5s
        minBackoff: 30ms
        maxBackoff: 5s
        maxRetries: 10
        retryOnRateLimit: true
        sampleAgeLimit: 0s
      metadataConfig:
        send: true
        sendInterval: 1m
        maxSamplesPerSend: 500
```

## Diagnostic Steps

The effective Prometheus runtime configuration — including the rendered `remote_write` block — is served at `http://localhost:9090/api/v1/status/config` inside any Prometheus pod. The HTTP API itself is upstream-unchanged; only the pod naming and namespace differ from upstream documentation. The prometheus-operator names each pod after its owning Prometheus CR with a StatefulSet replica suffix, and the instance lives in whichever namespace the ModulePlugin placed it, typically `cpaas-system`.

The `prometheus` container image is distroless and does not ship `wget` or `curl`, so the inspection endpoint is reached by port-forwarding to the prometheus statefulset pod and curling from the client side:

```bash
kubectl -n cpaas-system port-forward statefulset/prometheus-<cr-name> 9090:9090 &
curl -s http://localhost:9090/api/v1/status/config
```

Before reaching for the inspection endpoint, confirm that the prometheus-operator CRD is actually present on the cluster — until the `prometheus-operator` bundle's CSV is installed, only the scrape-target CRDs (`PodMonitor`, `Probe`, `PrometheusRule`, `ServiceMonitor`) are available and any `spec.remoteWrite` edit has no host CR to land on:

```bash
kubectl get crd prometheuses.monitoring.coreos.com
kubectl get packagemanifest -n cpaas-system prometheus-operator \
 -o jsonpath='{.status.channels[?(@.name=="alpha")].currentCSV}'
```
