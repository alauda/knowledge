---
kind:
  - Solution
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB260100017
sourceSHA: dc36ae0f91bb8b47520e0b9f2e330ad8a0c22b9bf1d3651565e680462769b6f1
---

# 如何通过 HPA 基于自定义 HTTP 指标自动扩展应用程序

## 介绍

本指南提供了一个逐步教程，介绍如何在 Kubernetes 中基于自定义 HTTP 指标实现应用程序的自动扩展。该解决方案包括：

- 开发一个演示应用程序，暴露 HTTP 请求计数的 Prometheus 指标。
- 将应用程序容器化并部署到 Kubernetes。
- 配置 Prometheus 以抓取指标。
- 设置 Prometheus Adapter 以向 Kubernetes 暴露自定义指标。
- 创建使用自定义 HTTP 指标进行扩展决策的水平 Pod 自动扩展器 (HPA)。
- 通过负载测试验证自动扩展行为。

## 先决条件

- 安装了 Prometheus 和 Prometheus Adapter 的 Kubernetes 集群。
- 配置了 `kubectl` 命令行工具以访问集群。
- Go（如果在本地构建应用程序）。
- 容器运行时（如果在本地构建应用程序）。

## 架构概述

```text
┌─────────────────┐     指标     ┌─────────────────┐
│   Go 应用程序   │────────────────▶│   Prometheus    │
│   (端口 8080)   │◀────────────────│     服务器      │
└─────────────────┘     抓取      └─────────────────┘
         │                                   │
         │ Pod 指标                           │ 自定义指标
         ▼                                   ▼
┌─────────────────┐                 ┌─────────────────┐
│   Kubernetes    │                 │   Prometheus    │
│   HPA 控制器   │◀────────────────│     Adapter     │
└─────────────────┘    自定义       └─────────────────┘
         │            指标 API
         │ 扩展
         ▼
┌─────────────────┐
│   部署          │
│   (自动扩展)    │
└─────────────────┘
```

## 逐步实施

### 第 1 步：获取演示应用程序

请参考开源代码库以获取完整的 Go 应用程序实现：
GitHub 仓库：[http-metrics-exporter](https://github.com/zhhray/http-metrics-exporter)
该应用程序包括：

- 在 `/metrics` 端点暴露指标的 HTTP 服务器。
- HTTP 请求计数的 Prometheus 指标。

### 第 2 步：构建并推送应用程序镜像

请参考 GitHub 仓库中的 Dockerfile 以获取容器化详细信息：

Dockerfile 位置：[Dockerfile](https://github.com/zhhray/http-metrics-exporter/blob/main/Dockerfile)

构建并推送容器镜像：

```bash
git clone https://github.com/zhhray/http-metrics-exporter.git
cd http-metrics-exporter
# 在本地构建应用程序
make build-linux

# 构建容器镜像
make docker-build

# 将容器镜像推送到目标注册表
# 您可以根据需要修改 Makefile 中的 DOCKER_REGISTRY
make docker-push
```

### 第 3 步：在 ACP 控制台上准备命名空间

- 导航到 \[Projects] 页面，点击 `Create Project` 按钮。
- 提供以下信息：
  - 名称：`demo`
  - 集群：选择将安装演示应用程序的集群。
- 点击 `Create Project` 按钮以创建项目。
- 导航到 \[Projects] -> \[Namespace] 页面，点击 `Create Namespace` 按钮。
- 提供以下信息：
  - 集群：选择将安装演示应用程序的集群。
  - 命名空间：`demo-ns`
- 点击 `Create` 按钮以创建命名空间。

### 第 4 步：Kubernetes 部署

所有 Kubernetes 部署清单均可在 GitHub 仓库中找到：

部署资源：[deploy resources](https://github.com/zhhray/http-metrics-exporter/tree/main/deploy)

关键资源包括：

- `resources.yaml`：部署和服务配置
- `servicemonitor.yaml`：Prometheus ServiceMonitor 配置
- `hpa.yaml`：水平 Pod 自动扩展器配置
- `load-test-scaling.sh`：负载测试脚本

将应用程序资源部署到 Kubernetes：

```bash
kubectl apply -f deploy/resources.yaml
# 输出：
service/metrics-app created
deployment.apps/metrics-app created
```

部署 Prometheus ServiceMonitor 配置：

```bash
kubectl apply -f deploy/servicemonitor.yaml
# 输出：
servicemonitor.monitoring.coreos.com/metrics-app-monitor created
```

配置 Prometheus Adapter 配置：

```bash
kubectl edit configmap cpaas-monitor-prometheus-adapter -n cpaas-system
# 在 configmap 中添加以下行：
- seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
  seriesFilters: []
  resources:
    overrides:
      namespace: {resource: "namespace"}
      pod: {resource: "pod"}
  name:
    matches: "http_requests_total"
    as: "http_requests_per_second"
  metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)'
 
# 重启 prometheus-adapter 以重新加载配置
kubectl rollout restart deployment cpaas-monitor-prometheus-adapter -n cpaas-system
# 输出：
deployment.apps/cpaas-monitor-prometheus-adapter restarted

# 检查指标
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/demo-ns/pods/*/http_requests_per_second" | jq .
{
  "kind": "MetricValueList",
  "apiVersion": "custom.metrics.k8s.io/v1beta1",
  "metadata": {},
  "items": [
      {
      "describedObject": {
          "kind": "Pod",
          "namespace": "demo-ns",
          "name": "metrics-app-79d749bbd-bvdw7",
          "apiVersion": "/v1"
      },
      "metricName": "http_requests_per_second",
      "timestamp": "2026-01-20T10:27:46Z",
      "value": "295m",
      "selector": null
      },
      {
      "describedObject": {
          "kind": "Pod",
          "namespace": "demo-ns",
          "name": "metrics-app-79d749bbd-j8vkd",
          "apiVersion": "/v1"
      },
      "metricName": "http_requests_per_second",
      "timestamp": "2026-01-20T10:27:46Z",
      "value": "304m",
      "selector": null
      }
  ]
}
```

部署水平 Pod 自动扩展器配置：

```bash
kubectl apply -f deploy/hpa.yaml
# 输出：
horizontalpodautoscaler.autoscaling/metrics-app-hpa created
```

### 第 5 步：负载测试和验证

将 `deploy/load-test-scaling.sh` 复制到运行 metrics-app 的 k8s 集群的主节点。

该脚本将向 metrics-app 端点发送请求，触发 HPA 根据定义的指标进行扩展或缩减。

执行负载测试脚本：

```bash
chmod 755 load-test-scaling.sh
./load-test-scaling.sh
# 输出：
=== 有效的负载测试脚本 ===

1. 当前状态：
NAME              REFERENCE                TARGETS   MINPODS   MAXPODS   REPLICAS   AGE
metrics-app-hpa   Deployment/metrics-app   295m/5    1         10        1          17h

2. 创建负载测试 Pod...
pod/load-test-pod created
3. 等待负载测试 Pod 启动...
pod/load-test-pod condition met
4. 监控 HPA 变化（5 分钟）...
时间戳 | 期望副本 | 当前副本 | 当前指标 | 状态
-----------------------------------------------------------------------
11:48:44 | 1               | 1               | .30            | ⏸️ 稳定
11:48:55 | 1               | 1               | 39.38          | ⏸️ 稳定
11:49:05 | 1               | 1               | 39.38          | ⏸️ 稳定
11:49:15 | 3               | 1               | 97.19          | ⬆️ 扩展中
11:49:26 | 3               | 1               | 151.96         | ⬆️ 扩展中
11:49:36 | 3               | 3               | 151.96         | ⏸️ 稳定
11:49:47 | 6               | 3               | 180.46         | ⬆️ 扩展中
11:49:57 | 6               | 3               | 84.36          | ⬆️ 扩展中
11:50:08 | 6               | 6               | 90.73          | ⏸️ 稳定
11:50:18 | 10              | 6               | 61.33          | ⬆️ 扩展中
11:50:29 | 10              | 6               | 58.10          | ⬆️ 扩展中
11:50:39 | 10              | 10              | 56.58          | ⏸️ 稳定
11:50:49 | 10              | 10              | 44.74          | ⏸️ 稳定
11:51:00 | 10              | 10              | 34.19          | ⏸️ 稳定
11:51:10 | 10              | 10              | 31.17          | ⏸️ 稳定
11:51:20 | 10              | 10              | 33.69          | ⏸️ 稳定
11:51:31 | 10              | 10              | 33.84          | ⏸️ 稳定
11:51:41 | 10              | 10              | 31.80          | ⏸️ 稳定
11:51:52 | 10              | 10              | 32.83          | ⏸️ 稳定
11:52:02 | 10              | 10              | 32.26          | ⏸️ 稳定
11:52:12 | 10              | 10              | 31.62          | ⏸️ 稳定
11:52:23 | 10              | 10              | 31.94          | ⏸️ 稳定
11:52:33 | 10              | 10              | 28.20          | ⏸️ 稳定
11:52:44 | 10              | 10              | 27.83          | ⏸️ 稳定
11:52:54 | 10              | 10              | 30.93          | ⏸️ 稳定
11:53:05 | 10              | 10              | 30.47          | ⏸️ 稳定
11:53:15 | 10              | 10              | 30.32          | ⏸️ 稳定
11:53:25 | 10              | 10              | 29.80          | ⏸️ 稳定
11:53:36 | 10              | 10              | 29.42          | ⏸️ 稳定
11:53:46 | 10              | 10              | 28.87          | ⏸️ 稳定

5. 清理负载测试 Pod...
pod "load-test-pod" 强制删除

最终状态：
NAME              REFERENCE                TARGETS    MINPODS   MAXPODS   REPLICAS   AGE
metrics-app-hpa   Deployment/metrics-app   29217m/5   1         10        10         17h
```

负载测试成功验证了 HPA 实现的正确性。系统根据 HTTP 请求速率自动扩展，确保在流量高峰期间的资源利用率最优。自定义指标管道（应用程序 → Prometheus → Prometheus Adapter → HPA）按设计运行，为基于 HTTP 的应用程序提供了强大的自动扩展解决方案。

在负载测试完成并删除 load-test-pod 后，HTTP 请求速率显著下降。根据 HPA 的缩减配置，部署会随着时间的推移自动缩减到最低的 1 个 Pod。
