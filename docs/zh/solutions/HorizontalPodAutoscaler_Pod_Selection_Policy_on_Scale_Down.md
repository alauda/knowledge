---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500146
sourceSHA: d18cf0c8d35b4daadd2955c5d833285276763e4f0c1f88579cf0de58a13cfbb9
---

# HPA 缩减行为未选择删除哪些 pods 在 ACP 上

## 问题

在运行 Kubernetes v1.34.5 的 Alauda Container Platform 上，操作员查看 `HorizontalPodAutoscaler`（内置的 `autoscaling/v2` API，通过 `kubectl explain hpa.spec.behavior.scaleDown` 暴露）希望控制在 HPA 减少副本数量时，特定工作负载的哪些副本被移除——例如，保留最旧的 pods 并驱逐最新的，或反之亦然。HPA 的 `spec.scaleTargetRef` 仅通过 `kind` 和 `name` 引用目标资源，并被描述为用于实际更改副本数量；pods 并未被 HPA 资源直接处理。

## 根本原因

HPA 负责计算目标工作负载的新期望副本数量，而不是选择删除哪些单独的 pods。下游工作负载控制器——ReplicaSet 控制器，一个内置的 `apps/v1` 控制器（`replicasets` / `rs`）——实际上是删除 pods 以达到新的副本数量。在这个集群中，该控制器在 `kube-controller-manager` 中启用（镜像 `registry.alauda.cn:60080/tkestack/kube-controller-manager:v1.34.5`），并以 `--controllers=*,bootstrapsigner,tokencleaner` 启动，因此 replicaset 控制器与其他内置控制器一起处于活动状态。

HPA 上的 `spec.behavior.scaleDown` 块是一个独立的关注点：它塑造副本数量变化的 *速率和幅度*，而不是受害者 pod 的选择。其模式包含 `policies[]`（每个条目都有必需的 `type`、`value` 和 `periodSeconds`）、`selectPolicy`、`stabilizationWindowSeconds` 和 `tolerance`——并且显著地没有 pod 选择器或 pod 排序字段。

## 解决方案

在 `HorizontalPodAutoscaler` 资源上——包括在 `spec.behavior.scaleDown` 下——没有选择最旧与最新 pods 的字段，或以其他方式选择在缩减期间删除哪个副本。HPA API 仅暴露上述的速度和稳定性调节器；它们都不涉及 pod 身份。

使用 `spec.behavior.scaleDown` 来调整 *缩减副本的速度* 和 *幅度*，使用标准的 `autoscaling/v2` 结构：

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: example
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: example
  minReplicas: 2
  maxReplicas: 10
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      selectPolicy: Max
      policies:
        - type: Percent
          value: 50
          periodSeconds: 60
        - type: Pods
          value: 4
          periodSeconds: 60
```

字段语义来自 CRD 模式：`policies[]` 中的每个条目都有必需的 `type`（`Pods` 或 `Percent`）、必需的 `value`（>0）和必需的 `periodSeconds`（范围 1–1800）。当未设置时，`selectPolicy` 默认为 `Max`（应用列出的最宽松的策略）。缩减的 `stabilizationWindowSeconds` 默认为 `300` 秒（范围 0–3600）。

要影响哪些 pods 在缩减中存活，请在工作负载控制器层面进行操作，而不是在 HPA 上。由于在缩减期间删除 pods 是由 `kube-controller-manager` 中的 ReplicaSet 控制器执行的，因此上游 Kubernetes 的缩减顺序在 ACP 上保持不变；HPA 资源本身没有调节器。

## 诊断步骤

确认该集群上的 HPA 资源是标准的内置 `autoscaling/v2` API，并且在 `spec.behavior.scaleDown` 下没有 pod 选择器字段：

```bash
kubectl explain hpa.spec.behavior.scaleDown
kubectl explain hpa.spec.behavior.scaleDown.policies
```

输出列出了 `policies[]`（包含 `periodSeconds`、`type`、`value`）、`selectPolicy` 和 `stabilizationWindowSeconds`——没有任何命名或选择单个 pods 的内容。

验证 ReplicaSet 控制器（实际在缩减时删除 pods 的组件）在控制平面上的 `kube-controller-manager` 中是否启用：

```bash
kubectl -n kube-system get pod -l component=kube-controller-manager \
  -o jsonpath='{range .items[*]}{.spec.containers[0].image}{"\n"}{.spec.containers[0].command}{"\n"}{end}'
kubectl api-resources --api-group=apps | grep -i replicaset
```

健康的控制平面报告 `kube-controller-manager:v1.34.5` 镜像以 `--controllers=*,bootstrapsigner,tokencleaner` 启动，并且 `replicasets`（`rs`、`apps/v1`、命名空间、类型 `ReplicaSet`）在 API 资源列表中存在。

检查 HPA 的目标引用以确认它指向一个工作负载的类型和名称（而不是 pods）：

```bash
kubectl get hpa <name> -o jsonpath='{.spec.scaleTargetRef}{"\n"}'
```
