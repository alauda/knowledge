---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500824
sourceSHA: 02ee73d9d41ecebf2a9191cd9a47eefc6efab21f1e1bf83f45568f0a3ffd66f4
---

# OpenTelemetryCollector HPA 扩展停滞，当操作员版本早于上游的副本调和修复

## 问题

一个以 `deployment` 模式运行的 `OpenTelemetryCollector` 配置了 `.spec.autoscaler`（包括 `minReplicas`、`maxReplicas`、`targetCPUUtilization`、`targetMemoryUtilization`）。OpenTelemetry 操作员会自动构建匹配的 `HorizontalPodAutoscaler`（autoscaling/v2），并且 HPA 的 `scaleTargetRef` 通过 OTel CR 的 scale 子资源指向 `OpenTelemetryCollector` CR（而不是直接指向 collector Deployment）。

```text
$ kubectl -n <otel-ns> get opentelemetrycollectors,deploy,hpa
NAME                                                MODE         VERSION   READY   AGE
opentelemetrycollector.opentelemetry.io/<name>      deployment   0.147.0   2/2     25s
deployment.apps/<name>-collector                    2/2                     25s
horizontalpodautoscaler.autoscaling/<name>-collector   REFERENCE: OpenTelemetryCollector/<name>   2   8   1
```

在集群中观察到的 HPA 是一个标准的 `autoscaling/v2` `HorizontalPodAutoscaler`，其 `scaleTargetRef` 为 `OpenTelemetryCollector/<name>`，`apiVersion: opentelemetry.io/v1beta1` — 操作员通过 OTel CR 的 scale 子资源（`specReplicasPath=.spec.replicas`，`statusReplicasPath=.status.scale.replicas`）路由 HPA 驱动的更改，实际的 collector Deployment 由操作员响应更新。因此，从“HPA 提高期望副本数”到“collector Deployment 增长”的路径通过操作员对 scale 子资源的调和进行 — 使操作员成为扩展过程中的关键组件。

## 根本原因

这是 OpenTelemetry 操作员中的一个上游缺陷，跟踪为 [open-telemetry/opentelemetry-operator#4400](https://github.com/open-telemetry/opentelemetry-operator/issues/4400)，在操作员版本高达并包括 `0.135.0-1` 时存在，并在 `0.140.0-1` 中修复。在 ACP 上，修复后的操作员作为 `opentelemetry-operator2` PackageManifest 发布，目前为 `opentelemetry-operator2.v0.147.0-r0`（控制器镜像 `build-harbor.alauda.cn/asm/opentelemetry-operator2:0.147.0-r0`） — 远远超过上游的 `0.140.0-1` 修复线，因此在 ACP 上基于 `opentelemetry-operator2` 的安装已经包含了修复。确认正在运行的操作员镜像为 `0.147.0-r0`（或更新版本）足以排除该缺陷作为 HPA 与 Deployment 停滞的原因；较旧的操作员镜像是该缺陷存在的前提。

当指标管道无法提供新的 CPU/内存样本时，会发生一个次要但视觉上相似的停滞。HPA 然后报告 `FailedGetResourceMetric` / `failed to get … utilization`，并且根本不会提高期望副本数 — 这是一个独立的故障模式，必须在将停滞归因于操作员缺陷之前排除。本文的诊断步骤针对监控命名空间下的上游 `metrics-server` pod；在 ACP 上，metrics-API 提供者因集群而异，必须在集群内找到（见诊断步骤）。

## 解决方案

**在集群上使用修复后的 OpenTelemetry 操作员。** 在 ACP 上，修复后的操作员作为 `opentelemetry-operator2` PackageManifest 发布（`opentelemetry-operator2.v0.147.0-r0`，控制器镜像 `0.147.0-r0`），这远远超过上游的 `0.140.0-1` 修复线。在新集群上，将其订阅到一个专用命名空间，并使用 `AllNamespaces` 模式的 OperatorGroup（该包不支持 `OwnNamespace`/`SingleNamespace`/`MultiNamespace` 安装模式 — 订阅到已经包含 `OwnNamespace` OperatorGroup 的命名空间，例如 `istio-system`，将使 CSV 处于 `Failed` 状态，显示 `UnsupportedOperatorGroup`）。在经过验证的安装上，CSV 达到 `Succeeded`，控制器 pod 运行正常。

```yaml
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: opentelemetry-operator2-og
  namespace: opentelemetry-operator2
spec: {}            # 空 spec == AllNamespaces 安装模式
---
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: opentelemetry-operator2
  namespace: opentelemetry-operator2
spec:
  channel: stable
  name: opentelemetry-operator2
  source: platform
  sourceNamespace: cpaas-system
```

在订阅调和后，使用 `kubectl get csv -n opentelemetry-operator2` 和 `kubectl -n opentelemetry-operator2 get pods` 确认 CSV 和控制器 pod — 阶段为 `Succeeded`，pod 为 `1/1 Running`。

**在旧的/受影响的操作员构建上使用变通方案。** 如果尚无法升级到修复后的操作员，则从 `OpenTelemetryCollector` CR 的 `.spec.autoscaler` 中删除 `minReplicas` 字段，移除故障调和路径读取和写回的字段。CRD 允许省略该字段（它不是必需的），然后操作员将结果 HPA 的 `spec.minReplicas` 默认设置为 `1`；HPA 驱动的扩展生效，因为调和路径不再有 `minReplicas` 值可以复制回 Deployment。

```yaml
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: <name>
  namespace: <otel-ns>
spec:
  mode: deployment
  autoscaler:
    # minReplicas: 2          # 删除这一行
    maxReplicas: 8
    targetCPUUtilization: 80
    targetMemoryUtilization: 80
```

## 诊断步骤

查看 `OpenTelemetryCollector` CR 上的 autoscaler 块，以查看 `minReplicas` 是否已设置（变通方案目标）以及配置的目标是什么。

```bash
kubectl -n <otel-ns> get opentelemetrycollector <name> -o jsonpath='{.spec.autoscaler}{"\n"}'
```

检查操作员构建的 HPA。其 `REFERENCE` 应为 `OpenTelemetryCollector/<name>`（操作员管理的 HPA 通过 scale 子资源针对 OTel CR，而不是直接针对 Deployment）；`Min replicas`、`Max replicas` 和指标目标应与 CR 匹配。指标列显示当前与目标的利用率；`OpenTelemetryCollector pods: <X> current / <Y> desired` 是 HPA 对期望副本数的视图。

```bash
kubectl -n <otel-ns> describe hpa <name>-collector
```

直接读取 `OpenTelemetryCollector` 的 `.status.scale.replicas` — 这是 HPA 通过 scale 子资源读取和写入的内容，应该等于 HPA 的当前规模视图（`OpenTelemetryCollector pods: <X> current` 在描述输出中）。如果 `.status.scale.replicas` 低于 HPA 的期望计数，并且正在运行的操作员镜像版本早于 `0.140.0-1`，则该缺陷在范围内。

```bash
kubectl -n <otel-ns> get opentelemetrycollector <name> -o jsonpath='{.status.scale}{"\n"}'
```

验证支持 HPA 的指标管道是否实际提供 `metrics.k8s.io`。本文的配方假设监控命名空间下的上游 `metrics-server` pod；在 ACP 上，提供者因集群而异 — 一些集群预安装 `cpaas-system/cpaas-monitor-prometheus-adapter` 作为 `v1beta1.metrics.k8s.io` 提供者，而在不包含的集群中，APIService 完全缺失，HPA 描述中包含 `FailedGetResourceMetric: the server could not find the requested resource (get pods.metrics.k8s.io)`（这是一个与操作员缺陷无关的停滞）。

```bash
kubectl get apiservice v1beta1.metrics.k8s.io \
  -o jsonpath='{.spec.service.namespace}/{.spec.service.name}{"\n"}{.status.conditions[0].type}={.status.conditions[0].status}{"\n"}'
```

如果 APIService 缺失或其 `Available` 条件不为 `True`，则 HPA 无法读取指标 — 首先修复指标提供者（安装 `metrics.k8s.io` 提供者，例如 prometheus-adapter，或将现有提供者恢复为 `Available=True`），然后再将扩展失败归因于操作员缺陷。如果 APIService 可用，则抓取其 pod 日志（例如 `kubectl -n cpaas-system logs deploy/cpaas-monitor-prometheus-adapter`）以查找 `context deadline exceeded` 或其他 kubelet 抓取错误，这些错误会抑制新的样本。

最后，确认实际调和 CR 的操作员版本 — 确定缺陷与修复的问题需要知道控制器镜像是早于还是晚于 `0.140.0-1`。

```bash
kubectl get csv -A | grep -iE 'opentelemetry'
kubectl -n <opentelemetry-operator-ns> get deploy \
  opentelemetry-operator-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'
```

在修复后的安装中，预期的镜像为 `build-harbor.alauda.cn/asm/opentelemetry-operator2:0.147.0-r0`（CSV `opentelemetry-operator2.v0.147.0-r0`，阶段为 `Succeeded`）。
