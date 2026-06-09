---
kind:
   - How To
products:
  - Alauda Container Platform
ProductsVersion:
   - 4.3.x and later
tags:
  - LB
id: KB260600054
---

# How to Disable the Metrics Port for Ingress NGINX

## Overview

This document describes how to disable the Prometheus metrics port for Ingress NGINX on Alauda Container Platform (ACP) 4.3.x and later.

Ingress NGINX is managed by the `IngressNginx` custom resource. Configure metrics through the `IngressNginx` resource. Do not manually edit the generated Deployment, Service, or ServiceMonitor, because these resources are reconciled by the ingress-nginx operator.

The required configuration is:

```yaml
spec:
  controller:
    metrics:
      enabled: false
```

This setting is sufficient to disable the metrics configuration rendered by the operator. After reconciliation, the controller no longer receives the `--enable-metrics=true` argument, the metrics container port is removed from the generated workload, and metrics-related resources such as the metrics Service and ServiceMonitor are not rendered.

:::note
The metrics port is different from the Ingress NGINX health check endpoint used by liveness and readiness probes.
:::

## Prerequisites

1. ACP 4.3.x or later.
2. The ingress-nginx operator has been installed.
3. At least one `IngressNginx` resource has been created.
4. `kubectl` has been configured to access the cluster.

## Procedure

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

### Step 2: Disable metrics

Patch `spec.controller.metrics.enabled` to `false`:

```bash
kubectl patch ingressnginxes.ingress-nginx.alauda.io "${INGRESS_NGINX_NAME}" \
  -n "${INGRESS_NGINX_NAMESPACE}" \
  --type merge \
  -p '{
    "spec": {
      "controller": {
        "metrics": {
          "enabled": false
        }
      }
    }
  }'
```

Wait for the operator to reconcile the `IngressNginx` resource.

### Step 3: Verify the controller argument

Check the generated controller Deployment:

```bash
kubectl get deployment -n "${INGRESS_NGINX_NAMESPACE}" \
  "${INGRESS_NGINX_NAME}-ingress-nginx-controller" \
  -o jsonpath='{.spec.template.spec.containers[0].args}' | tr ' ' '\n' | grep -- '--enable-metrics=true'
```

Expected result: the command prints no output.
