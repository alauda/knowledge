---
products: 
  - Alauda Container Platform
kind:
  - Solution
id: KB260500006
---

# Prometheus PodMonitor Metrics Discovery by Pod Annotations

## Overview

In Kubernetes environments, many applications and middleware components expose Prometheus scrape metadata through Pod annotations, for example:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/path: "/metrics"
  prometheus.io/port: "8080"
```

With native Prometheus `kubernetes_sd_configs` and `relabel_configs`, these annotations can be used directly to discover and scrape metrics targets.

In a Prometheus Operator based deployment, Prometheus does not automatically inherit the native annotation-based scrape behavior. Instead, scrape targets are managed through CRDs such as `ServiceMonitor` and `PodMonitor`.

If you want to continue using Pod annotations to declare metrics endpoints while managing scraping through `PodMonitor`, you must explicitly handle these annotations in `PodMonitor.spec.podMetricsEndpoints[].relabelings`.

This guide provides a production-oriented pattern for using `PodMonitor` to:

- Select candidate Pods by Pod labels.
- Decide whether to scrape a Pod by Pod annotations.
- Dynamically set the metrics path from Pod annotations.
- Dynamically set the target port from Pod annotations.
- Optionally configure Basic Authentication.
- Align annotation-based scrape metadata with the Prometheus Operator model.

## Environment Information

Applicable Versions: 4.3.x

## Prerequisites

Before you create the `PodMonitor`, make sure the following requirements are met.

### Prometheus Can Select the PodMonitor

The Prometheus custom resource must be configured to select this `PodMonitor`.

Prometheus Operator uses the following fields from the Prometheus custom resource:

- `spec.podMonitorSelector`
- `spec.podMonitorNamespaceSelector`

The `PodMonitor` must match both selectors. Otherwise, Prometheus Operator will not generate scrape configuration for it.

Example:

```yaml
metadata:
  labels:
    prometheus: kube-prometheus
```

The label above must match the `podMonitorSelector` configured in the target Prometheus custom resource.

### Pods Have Matchable Labels

`PodMonitor.spec.selector` selects Pods by labels. Each target Pod must have labels that match the selector.

Example target Pod labels:

```yaml
labels:
  service_name: elasticsearch
```

### Pods Have Prometheus Annotations

Each target Pod should include Prometheus scrape annotations.

Example:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/path: "/metrics"
  prometheus.io/port: "8080"
```

Recommendations:

- Always use string values for annotations.
- Use `prometheus.io/scrape: "true"` only for Pods that should be scraped.
- Use an explicit metrics path, even if the application uses `/metrics`.
- Keep the annotated port consistent with the actual metrics listener port.

### Pods Declare the Metrics Container Port

The target Pod should declare the metrics port in the container spec.

Example:

```yaml
ports:
  - name: metrics
    containerPort: 8080
    protocol: TCP
```

Notes:

- `PodMonitor.spec.podMetricsEndpoints[].port` should use the port name defined in the Pod spec.
- Kubernetes port names must be 15 characters or less.
- Even if the application listens on a port and can be accessed by `curl`, Prometheus Operator target generation is more reliable when the container port is explicitly declared in the Pod spec.

### Basic Auth Secret Is Available, If Required

If the metrics endpoint requires Basic Authentication, create a Secret that can be referenced by the `PodMonitor`.

Example:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: metrics-basic-auth
  namespace: cpaas-system
type: Opaque
stringData:
  username: admin
  password: 123456
```

Notes:

- The Secret referenced by a `PodMonitor` is normally expected to be in the same namespace as the `PodMonitor`.
- Do not assume that a `PodMonitor` can directly reference a Secret from another namespace.
- In production, do not store plaintext credentials in Git. Use a secure secret management process.

## Production PodMonitor Example

The following example selects Pods that have the `service_name` label and scrapes only Pods with `prometheus.io/scrape: "true"`.

It also supports overriding the metrics path and port through Pod annotations.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: cpaas-elasticsearch-podmonitor
  namespace: cpaas-system
  labels:
    prometheus: kube-prometheus
spec:
  namespaceSelector:
    any: true
  selector:
    matchExpressions:
      - key: service_name
        operator: Exists
  podMetricsEndpoints:
    - port: es-http
      path: /_prometheus/metrics
      interval: 30s
      basicAuth:
        username:
          name: acp-config-secret
          key: ES_USERNAME
        password:
          name: acp-config-secret
          key: ES_PASSWORD
      relabelings:
        - action: keep
          sourceLabels:
            - __meta_kubernetes_pod_annotation_prometheus_io_scrape
          regex: "true"

        - action: replace
          sourceLabels:
            - __meta_kubernetes_pod_annotation_prometheus_io_path
          targetLabel: __metrics_path__
          regex: (.+)

        - action: replace
          sourceLabels:
            - __address__
            - __meta_kubernetes_pod_annotation_prometheus_io_port
          regex: ([^:]+)(?::\d+)?;(\d+)
          replacement: $1:$2
          targetLabel: __address__

        - action: replace
          sourceLabels:
            - __meta_kubernetes_namespace
          targetLabel: kubernetes_namespace

        - action: replace
          sourceLabels:
            - __meta_kubernetes_pod_name
          targetLabel: kubernetes_pod_name
```

## Field Explanation

### PodMonitor Metadata

```yaml
metadata:
  name: cpaas-elasticsearch-podmonitor
  namespace: cpaas-system
  labels:
    prometheus: kube-prometheus
```

- `metadata.namespace` is the namespace where the `PodMonitor` object is created.
- `metadata.labels` must match the Prometheus CR `spec.podMonitorSelector`.
- If the label does not match, Prometheus Operator will ignore this `PodMonitor`.

### Namespace Selector

```yaml
namespaceSelector:
  any: true
```

This allows the `PodMonitor` to select Pods from any namespace.

Production recommendation:

- Use `any: true` only when cross-namespace scraping is required.
- For stricter isolation, prefer `matchNames`.

Example:

```yaml
namespaceSelector:
  matchNames:
    - cpaas-system
```

### Pod Selector

```yaml
selector:
  matchExpressions:
    - key: service_name
      operator: Exists
```

This selects candidate Pods by label.

Important:

- This only selects candidate Pods.
- The final decision to scrape is made by the relabeling rule that checks `prometheus.io/scrape`.

### Pod Metrics Endpoint

```yaml
podMetricsEndpoints:
  - port: es-http
    path: /_prometheus/metrics
    interval: 30s
```

- `port` should match a named container port in the target Pod.
- `path` is the default scrape path.
- `interval` defines the scrape interval.

If the Pod has `prometheus.io/path`, the relabeling rule overrides the default path by setting `__metrics_path__`.

If the Pod has `prometheus.io/port`, the relabeling rule overrides the port part of `__address__`.

## Relabeling Rules

### Keep Only Pods with `prometheus.io/scrape=true`

```yaml
- action: keep
  sourceLabels:
    - __meta_kubernetes_pod_annotation_prometheus_io_scrape
  regex: "true"
```

Only Pods with the following annotation are kept:

```yaml
prometheus.io/scrape: "true"
```

All other Pods are dropped.

### Override Metrics Path from Annotation

```yaml
- action: replace
  sourceLabels:
    - __meta_kubernetes_pod_annotation_prometheus_io_path
  targetLabel: __metrics_path__
  regex: (.+)
```

If the Pod has this annotation:

```yaml
prometheus.io/path: "/metrics"
```

Prometheus uses the annotation value as the scrape path.

If the annotation is missing or empty, the default `path` configured in `podMetricsEndpoints` is used.

### Override Target Port from Annotation

```yaml
- action: replace
  sourceLabels:
    - __address__
    - __meta_kubernetes_pod_annotation_prometheus_io_port
  regex: ([^:]+)(?::\d+)?;(\d+)
  replacement: $1:$2
  targetLabel: __address__
```

If the Pod has this annotation:

```yaml
prometheus.io/port: "8080"
```

Prometheus replaces the port part of `__address__` with `8080`.

Important:

- The annotation port must be numeric.
- The Pod should still declare a named container port so that the `PodMonitor` can generate a target reliably.
- `podMetricsEndpoints[].port` is still required by the Prometheus Operator schema and should reference a valid named container port.

### Add Kubernetes Namespace Label

```yaml
- action: replace
  sourceLabels:
    - __meta_kubernetes_namespace
  targetLabel: kubernetes_namespace
```

This adds the Pod namespace as a metric label.

### Add Kubernetes Pod Name Label

```yaml
- action: replace
  sourceLabels:
    - __meta_kubernetes_pod_name
  targetLabel: kubernetes_pod_name
```

This adds the Pod name as a metric label.

## Example Target Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: example-app
  namespace: cpaas-system
  labels:
    service_name: example-app
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/path: "/metrics"
    prometheus.io/port: "8080"
spec:
  containers:
    - name: app
      image: example/app:latest
      ports:
        - name: metrics
          containerPort: 8080
          protocol: TCP
```

If the `PodMonitor` uses:

```yaml
podMetricsEndpoints:
  - port: metrics
```

Prometheus Operator can generate a target for the named port, and the relabeling rules can then apply the annotation-based scrape behavior.

## Basic Auth Configuration

If the metrics endpoint requires Basic Authentication, configure `basicAuth` in the endpoint.

```yaml
basicAuth:
  username:
    name: metrics-basic-auth
    key: username
  password:
    name: metrics-basic-auth
    key: password
```

Notes:

- The Secret must be accessible to the Prometheus Operator and Prometheus configuration generation process.
- The Secret is typically created in the same namespace as the `PodMonitor`.
- Use Kubernetes RBAC and secret management policies to protect credentials.

If Basic Authentication is not required, remove the `basicAuth` section.

## Validation

### Check That the PodMonitor Is Selected by Prometheus

Check the Prometheus custom resource and confirm that:

- `spec.podMonitorSelector` matches the labels of the `PodMonitor`.
- `spec.podMonitorNamespaceSelector` includes the namespace of the `PodMonitor`.

Example commands:

```bash
kubectl get prometheus -A
kubectl get podmonitor -n cpaas-system cpaas-elasticsearch-podmonitor --show-labels
```

### Check That Target Pods Match the PodMonitor Selector

```bash
kubectl get pod -A -l service_name --show-labels
```

Confirm that the target Pods have the expected labels.

### Check Pod Annotations

```bash
kubectl get pod <pod_name> -n <namespace> -o yaml
```

Confirm that the Pod has:

```yaml
prometheus.io/scrape: "true"
prometheus.io/path: "/metrics"
prometheus.io/port: "8080"
```

### Check Container Port Declaration

Confirm that the Pod declares a named container port that matches `podMetricsEndpoints[].port`.

Example:

```yaml
ports:
  - name: metrics
    containerPort: 8080
    protocol: TCP
```

### Check Prometheus Targets

Open the Prometheus UI and check:

```text
Status -> Targets
```

Expected result:

- The target appears under the generated PodMonitor scrape job.
- The target URL uses the expected path.
- The target address uses the expected port.
- The target state is `UP`.

## Troubleshooting

### PodMonitor Is Not Effective

Possible causes:

- The `PodMonitor` namespace is not selected by `spec.podMonitorNamespaceSelector`.
- The `PodMonitor` labels do not match `spec.podMonitorSelector`.
- The Prometheus Operator is not watching the namespace.

### Pod Is Not Discovered

Possible causes:

- The Pod labels do not match `PodMonitor.spec.selector`.
- The Pod is in a namespace not selected by `PodMonitor.spec.namespaceSelector`.
- The Pod does not declare the named container port referenced by `podMetricsEndpoints[].port`.

### Pod Is Discovered but Dropped

Possible cause:

- The Pod does not have `prometheus.io/scrape: "true"`.

The `keep` relabeling rule drops all Pods that do not match this annotation.

### Target Uses the Wrong Path

Possible causes:

- The Pod does not have `prometheus.io/path`.
- The annotation value is empty.
- The application exposes metrics on a different path.

If the annotation is missing, Prometheus uses the endpoint default `path`.

### Target Uses the Wrong Port

Possible causes:

- The Pod does not have `prometheus.io/port`.
- The annotation value is not numeric.
- The container does not declare the named port used by `podMetricsEndpoints[].port`.
- The application listens on a different port than the annotation value.

### Target Is Down with Authentication Error

Possible causes:

- The `basicAuth` Secret does not exist.
- The Secret is in the wrong namespace.
- The Secret keys are incorrect.
- The username or password is invalid.

## Production Recommendations

- Prefer `namespaceSelector.matchNames` over `namespaceSelector.any: true` unless cross-namespace discovery is required.
- Use strict Pod label selectors to avoid selecting too many candidate Pods.
- Require `prometheus.io/scrape: "true"` to explicitly opt in to scraping.
- Keep annotation values as strings.
- Declare named container ports in the Pod spec.
- Keep port names no longer than 15 characters.
- Store Basic Auth credentials in Kubernetes Secrets and manage them securely.
- Avoid committing plaintext credentials to Git.
- Validate targets in the Prometheus UI after applying the `PodMonitor`.
- Keep the default endpoint `path` and annotation `prometheus.io/path` consistent where possible.
