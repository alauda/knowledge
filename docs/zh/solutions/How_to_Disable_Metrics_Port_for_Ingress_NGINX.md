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
sourceSHA: 8e9fa7bac5e8a99208cb0280f0fb1b50023be81e885539a064fbccdb34c51c05
---

# 如何禁用 Ingress NGINX 的指标端口

## 概述

本文档描述了如何在 Alauda Container Platform (ACP) 4.3.x 及更高版本上禁用 Ingress NGINX 的 Prometheus 指标端口。

Ingress NGINX 由 `IngressNginx` 自定义资源管理。通过 `IngressNginx` 资源配置指标。请勿手动编辑生成的 Deployment、Service 或 ServiceMonitor，因为这些资源由 ingress-nginx operator 进行协调。

所需的配置如下：

```yaml
spec:
  controller:
    metrics:
      enabled: false
```

此设置足以禁用 operator 渲染的指标配置。经过协调后，控制器不再接收 `--enable-metrics=true` 参数，指标容器端口从生成的工作负载中移除，指标相关资源如指标 Service 和 ServiceMonitor 不会被渲染。

:::note
指标端口与 Ingress NGINX 健康检查端点不同，后者用于存活性和就绪性探针。
:::

## 先决条件

1. ACP 4.3.x 或更高版本。
2. 已安装 ingress-nginx operator。
3. 至少创建了一个 `IngressNginx` 资源。
4. `kubectl` 已配置为访问集群。

## 操作步骤

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

### 步骤 2：禁用指标

将 `spec.controller.metrics.enabled` 打补丁为 `false`：

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

等待 operator 协调 `IngressNginx` 资源。

### 步骤 3：验证控制器参数

检查生成的控制器 Deployment：

```bash
kubectl get deployment -n "${INGRESS_NGINX_NAMESPACE}" \
  "${INGRESS_NGINX_NAME}-ingress-nginx-controller" \
  -o jsonpath='{.spec.template.spec.containers[0].args}' | tr ' ' '\n' | grep -- '--enable-metrics=true'
```

预期结果：该命令不输出任何内容。
