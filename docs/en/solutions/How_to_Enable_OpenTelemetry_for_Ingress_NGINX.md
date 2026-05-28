---
kind:
   - How To
products:
  - Alauda Container Platform
ProductsVersion:
   - 4.3.x and later
tags:
  - LB
id: KB260500063
---

# How to Enable OpenTelemetry for Ingress NGINX

## Overview

This document describes how to enable OpenTelemetry tracing for Ingress NGINX on Alauda Container Platform (ACP) 4.3.x and later.

Ingress NGINX is managed by the `IngressNginx` custom resource. OpenTelemetry must be configured through the `IngressNginx` resource. Do not manually edit the generated controller ConfigMap, because it is reconciled from the `IngressNginx` resource by the operator.

The Ingress NGINX controller image delivered with ACP 4.3.x and later includes the NGINX OpenTelemetry module. After OpenTelemetry is enabled, the Ingress NGINX controller renders the OpenTelemetry settings into the generated ConfigMap, reloads NGINX, and loads the `otel_ngx_module.so` module.

## Prerequisites

1. ACP 4.3.x or later.
2. The ingress-nginx operator has been installed.
3. At least one `IngressNginx` resource has been created.
4. For production tracing, an OpenTelemetry Collector or another OTLP gRPC endpoint must be reachable from the Ingress NGINX controller Pods.
5. `kubectl` has been configured to access the cluster.

## Chapter 1. Enable OpenTelemetry

### Step 1: Find the IngressNginx resource

Use the following command to list all Ingress NGINX instances:

```bash
kubectl get ingressnginxes.ingress-nginx.alauda.io -A
```

Example output:

```text
NAMESPACE                NAME       AGE
ingress-nginx-operator   demo-all   145m
```

Set the namespace and name according to your environment:

```bash
export INGRESS_NGINX_NAMESPACE="ingress-nginx-operator"
export INGRESS_NGINX_NAME="demo-all"
```

### Step 2: Patch the IngressNginx resource

Patch `spec.controller.config` to enable OpenTelemetry and configure the OTLP collector endpoint:

```bash
kubectl patch ingressnginxes.ingress-nginx.alauda.io "${INGRESS_NGINX_NAME}" \
  -n "${INGRESS_NGINX_NAMESPACE}" \
  --type merge \
  -p '{
    "spec": {
      "controller": {
        "config": {
          "enable-opentelemetry": "true",
          "otlp-collector-host": "otel-collector.observability.svc.cluster.local",
          "otlp-collector-port": "4317",
          "otel-service-name": "ingress-nginx",
          "otel-sampler": "AlwaysOn",
          "otel-sampler-ratio": "1.0",
          "otel-sampler-parent-based": "false",
          "opentelemetry-operation-name": "HTTP $request_method $uri"
        }
      }
    }
  }'
```

Replace `otel-collector.observability.svc.cluster.local` and `4317` with the OTLP gRPC endpoint used in your environment.

#### Fields description

- `enable-opentelemetry`: Enables OpenTelemetry in the Ingress NGINX controller configuration.
- `otlp-collector-host`: The OTLP gRPC collector host. Use only the host name or IP address, without `http://` or `https://`.
- `otlp-collector-port`: The OTLP gRPC collector port. The default OTLP gRPC port is `4317`.
- `otel-service-name`: The service name written into generated spans.
- `otel-sampler`: The sampler used by the OpenTelemetry module. Common values are `AlwaysOn`, `AlwaysOff`, and `TraceIdRatioBased`.
- `otel-sampler-ratio`: Sampling ratio used by ratio-based sampling.
- `otel-sampler-parent-based`: Whether to make the sampling decision based on the parent span.
- `opentelemetry-operation-name`: The operation name template used for spans.

:::note
The generated ConfigMap is owned by the `IngressNginx` resource. It is expected to change after the patch, but it must not be edited directly.
:::

### Step 3: Confirm the generated ConfigMap

The operator renders `spec.controller.config` into the controller ConfigMap. Use the following command to confirm the rendered keys:

```bash
kubectl get configmap -n "${INGRESS_NGINX_NAMESPACE}" \
  "${INGRESS_NGINX_NAME}-ingress-nginx-controller" \
  -o yaml
```

The ConfigMap should contain the OpenTelemetry keys:

```yaml
data:
  enable-opentelemetry: "true"
  otlp-collector-host: otel-collector.observability.svc.cluster.local
  otlp-collector-port: "4317"
  otel-service-name: ingress-nginx
```

## Chapter 2. Verify OpenTelemetry

### Step 1: Check the IngressNginx status

Confirm that the `IngressNginx` resource has been reconciled successfully:

```bash
kubectl get ingressnginxes.ingress-nginx.alauda.io "${INGRESS_NGINX_NAME}" \
  -n "${INGRESS_NGINX_NAMESPACE}" \
  -o jsonpath='{.status.conditions[?(@.type=="Deployed")].reason}{" "}{.status.conditions[?(@.type=="Deployed")].status}{"\n"}'
```

Expected output:

```text
UpgradeSuccessful True
```

### Step 2: Check that NGINX loads the OpenTelemetry module

Get one Ingress NGINX controller Pod:

```bash
export INGRESS_NGINX_POD="$(
  kubectl get pods -n "${INGRESS_NGINX_NAMESPACE}" \
    -l app.kubernetes.io/name=ingress-nginx,app.kubernetes.io/instance="${INGRESS_NGINX_NAME}",app.kubernetes.io/component=controller \
    -o jsonpath='{.items[0].metadata.name}'
)"
```

Check the generated NGINX configuration:

```bash
kubectl exec -n "${INGRESS_NGINX_NAMESPACE}" "${INGRESS_NGINX_POD}" -- \
  sh -c 'grep -n "otel_ngx_module\|opentelemetry_config\|opentelemetry on" /etc/nginx/nginx.conf'
```

Expected output contains entries similar to the following:

```text
load_module /etc/nginx/modules/otel_ngx_module.so;
opentelemetry_config /etc/ingress-controller/telemetry/opentelemetry.toml;
opentelemetry on;
```

## Chapter 3. Disable OpenTelemetry

To disable OpenTelemetry, patch the `IngressNginx` resource again:

```bash
kubectl patch ingressnginxes.ingress-nginx.alauda.io "${INGRESS_NGINX_NAME}" \
  -n "${INGRESS_NGINX_NAMESPACE}" \
  --type merge \
  -p '{
    "spec": {
      "controller": {
        "config": {
          "enable-opentelemetry": "false"
        }
      }
    }
  }'
```

After the operator reconciles the resource, NGINX reloads with OpenTelemetry disabled.
