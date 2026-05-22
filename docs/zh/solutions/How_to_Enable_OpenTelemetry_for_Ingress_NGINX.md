---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x and later
id: KB260500063
sourceSHA: 28022ffbcbd9f40a406bdf43fe0282cdecad0ac5e617c0563fd97558c4127f07
---

# 如何为 Ingress NGINX 启用 OpenTelemetry

## 概述

本文档描述了如何在 Alauda Container Platform (ACP) 4.3.x 及更高版本上为 Ingress NGINX 启用 OpenTelemetry 跟踪。

Ingress NGINX 由 `IngressNginx` 自定义资源管理。必须通过 `IngressNginx` 资源配置 OpenTelemetry。请勿手动编辑生成的控制器 ConfigMap，因为它是由操作员从 `IngressNginx` 资源进行协调的。

随 ACP 4.3.x 及更高版本交付的 Ingress NGINX 控制器镜像包含 NGINX OpenTelemetry 模块。启用 OpenTelemetry 后，Ingress NGINX 控制器将 OpenTelemetry 设置渲染到生成的 ConfigMap 中，重新加载 NGINX，并加载 `otel_ngx_module.so` 模块。

## 先决条件

1. ACP 4.3.x 或更高版本。
2. 已安装 ingress-nginx 操作员。
3. 至少创建了一个 `IngressNginx` 资源。
4. 对于生产环境跟踪，Ingress NGINX 控制器 Pods 必须能够访问 OpenTelemetry Collector 或其他 OTLP gRPC 端点。
5. 已配置 `kubectl` 以访问集群。

## 第 1 章 启用 OpenTelemetry

### 步骤 1：查找 IngressNginx 资源

使用以下命令列出所有 Ingress NGINX 实例：

```bash
kubectl get ingressnginxes.ingress-nginx.alauda.io -A
```

示例输出：

```text
NAMESPACE                NAME       AGE
ingress-nginx-operator   demo-all   145m
```

根据您的环境设置命名空间和名称：

```bash
export INGRESS_NGINX_NAMESPACE="ingress-nginx-operator"
export INGRESS_NGINX_NAME="demo-all"
```

### 步骤 2：修补 IngressNginx 资源

修补 `spec.controller.config` 以启用 OpenTelemetry 并配置 OTLP 收集器端点：

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

将 `otel-collector.observability.svc.cluster.local` 和 `4317` 替换为您环境中使用的 OTLP gRPC 端点。

#### 字段描述

- `enable-opentelemetry`：在 Ingress NGINX 控制器配置中启用 OpenTelemetry。
- `otlp-collector-host`：OTLP gRPC 收集器主机。仅使用主机名或 IP 地址，不带 `http://` 或 `https://`。
- `otlp-collector-port`：OTLP gRPC 收集器端口。默认 OTLP gRPC 端口为 `4317`。
- `otel-service-name`：写入生成的跨度中的服务名称。
- `otel-sampler`：OpenTelemetry 模块使用的采样器。常见值为 `AlwaysOn`、`AlwaysOff` 和 `TraceIdRatioBased`。
- `otel-sampler-ratio`：基于比例的采样使用的采样比例。
- `otel-sampler-parent-based`：是否根据父跨度做出采样决策。
- `opentelemetry-operation-name`：用于跨度的操作名称模板。

:::note
生成的 ConfigMap 由 `IngressNginx` 资源拥有。预计在修补后会发生变化，但不得直接编辑。
:::

### 步骤 3：确认生成的 ConfigMap

操作员将 `spec.controller.config` 渲染到控制器 ConfigMap 中。使用以下命令确认渲染的键：

```bash
kubectl get configmap -n "${INGRESS_NGINX_NAMESPACE}" \
  "${INGRESS_NGINX_NAME}-ingress-nginx-controller" \
  -o yaml
```

ConfigMap 应包含 OpenTelemetry 键：

```yaml
data:
  enable-opentelemetry: "true"
  otlp-collector-host: otel-collector.observability.svc.cluster.local
  otlp-collector-port: "4317"
  otel-service-name: ingress-nginx
```

## 第 2 章 验证 OpenTelemetry

### 步骤 1：检查 IngressNginx 状态

确认 `IngressNginx` 资源已成功协调：

```bash
kubectl get ingressnginxes.ingress-nginx.alauda.io "${INGRESS_NGINX_NAME}" \
  -n "${INGRESS_NGINX_NAMESPACE}" \
  -o jsonpath='{.status.conditions[?(@.type=="Deployed")].reason}{" "}{.status.conditions[?(@.type=="Deployed")].status}{"\n"}'
```

预期输出：

```text
UpgradeSuccessful True
```

### 步骤 2：检查 NGINX 是否加载 OpenTelemetry 模块

获取一个 Ingress NGINX 控制器 Pod：

```bash
export INGRESS_NGINX_POD="$(
  kubectl get pods -n "${INGRESS_NGINX_NAMESPACE}" \
    -l app.kubernetes.io/name=ingress-nginx,app.kubernetes.io/instance="${INGRESS_NGINX_NAME}",app.kubernetes.io/component=controller \
    -o jsonpath='{.items[0].metadata.name}'
)"
```

检查生成的 NGINX 配置：

```bash
kubectl exec -n "${INGRESS_NGINX_NAMESPACE}" "${INGRESS_NGINX_POD}" -- \
  sh -c 'grep -n "otel_ngx_module\|opentelemetry_config\|opentelemetry on" /etc/nginx/nginx.conf'
```

预期输出应包含类似以下的条目：

```text
load_module /etc/nginx/modules/otel_ngx_module.so;
opentelemetry_config /etc/ingress-controller/telemetry/opentelemetry.toml;
opentelemetry on;
```

## 第 3 章 禁用 OpenTelemetry

要禁用 OpenTelemetry，再次修补 `IngressNginx` 资源：

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

在操作员协调资源后，NGINX 将重新加载并禁用 OpenTelemetry。
