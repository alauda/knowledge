---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500449
sourceSHA: 91eb8269a0f816f5d15e89f213ef401761b56e31bd56fdf96ba6d6b9ee290a48
---

# 缺失的 ServiceAccount 阻止 Deployment 部署并导致观察到的镜像集为空

## 问题

在 Alauda Container Platform (ACP 基础版本 v4.3.x, kube v1.34.5) 上，`apps/v1` Deployment 和 ReplicaSet 是命名空间的核心 API 资源，控制器依赖于 `.spec.template.spec.serviceAccountName` 来创建 pods。当命名的 ServiceAccount 在 Deployment 的命名空间中不存在时，apiserver 的内置 ServiceAccount 许可插件会拒绝 ReplicaSet 控制器发出的每个 pod 创建调用，因此新的 ReplicaSet 永远不会生成正在运行的 pod。

由于新的 ReplicaSet 的 pod 从未达到 Ready，容器安全扫描器或任何观察 Deployment 运行 pod 集并从 `.items[*].spec.containers[*].image` 投影镜像的系统会报告受影响工作负载的镜像集为空。`.spec.template.spec.containers[*].image` 上的期望镜像列表是非空的，但观察到的镜像集为空，因为选择器匹配零个 pod。

## 根本原因

当引用的 ServiceAccount 在命名空间中不存在时，apiserver 会向 ReplicaSet 控制器的 pod 创建调用返回一个 Forbidden 响应，消息内容为 `pods "<name>" is forbidden: error looking up service account <ns>/<sa>: serviceaccount "<sa>" not found`。

ReplicaSet 控制器将该许可拒绝作为 `Warning` 事件呈现，`reason=FailedCreate` 和 `.involvedObject.kind=ReplicaSet`，并在 `.message` 中逐字携带 apiserver 的错误字符串。

如果新的 ReplicaSet 从未生成 pods，Deployment 控制器最终会将其 `Progressing` 条件切换为 `status=False, reason=ProgressDeadlineExceeded`，一旦 `.spec.progressDeadlineSeconds`（在 ACP `apps/v1` Deployments 上默认值为 600s）在没有进展的情况下到期，Deployment 将没有准备好的 pods。

## 解决方案

在 Deployment 的命名空间中创建缺失的 ServiceAccount。ReplicaSet 控制器的下一个 pod 创建调用将通过 SA 许可插件，新 pods 开始启动，部署完成：

```bash
kubectl create sa <name> -n <ns>
```

或者，编辑 Deployment，使得 `.spec.template.spec.serviceAccountName`（以及遗留别名 `.spec.template.spec.serviceAccount`）指向命名空间中现有的 ServiceAccount。`default` ServiceAccount 是由 SA 控制器在每个 ACP 命名空间中自动创建的，当不需要专用 SA 时，这是一个安全的后备选项：

```bash
kubectl edit deployment/<name> -n <ns>
```

一旦 pods 正在运行，遍历 Deployment 的 pods 的扫描器将报告工作负载的正确镜像集：

```bash
kubectl get pods -n <ns> -l <deployment-selector>
```

## 诊断步骤

列出命名空间的事件并查找 ReplicaSet 的 `Warning FailedCreate` 记录 — `.message` 字段携带 apiserver 的 `error looking up service account` 字符串，直接命名缺失的 SA：

```bash
kubectl get event -n <ns>
kubectl get event -n <ns> --field-selector reason=FailedCreate
```

检查 Deployment YAML 以读取错误配置的 `serviceAccountName` 和单个对象上的 `Progressing` 条件 — 当部署因缺失的 SA 而卡住时，`serviceAccountName` 字段指向缺失的 ServiceAccount，而 `.status.conditions[]` 在 600s 默认时间到期后携带 `ProgressDeadlineExceeded` 原因：

```bash
kubectl get deployment/<name> -n <ns> -o yaml
```
