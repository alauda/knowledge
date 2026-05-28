---
kind:
  - BestPractices
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500279
sourceSHA: daa30c03afdcaf660e2f7633b8b712344ff63c9d73b05a6ecf189eb2555c5c65
---

# 在 ACP 上运行混合供应商工作节点并隔离工作负载

## 概述

在 Alauda 容器平台（安装包 v4.3.13，Kubernetes v1.34.5）上，工作节点通过 kubelet 和容器运行时进行抽象，仅通过 `node.status.nodeInfo` 显示通用节点信息——CPU 架构、操作系统、kubelet 版本和容器运行时版本，而不会显示底层硬件供应商。由于该层对每个节点的处理是相同的，无论其运行在何种机器上，因此来自不同硬件供应商的工作节点可以作为一个同质节点池加入并在同一集群中运行。

整个集群有一个约束：所有节点必须共享相同的 CPU 架构。每个节点的架构在 `node.status.nodeInfo.architecture` 中报告，由于容器镜像和调度器是围绕单一架构构建的，因此不支持在一个集群中混合架构（例如 `amd64` 和 `arm64`）。

本文涵盖了支持的、供应商中立的方式，以将工作负载固定在预定的节点上——使用 `nodeSelector` 的节点标签、带有 Pod 容忍度的节点污点，以及用于租户隔离的命名空间。

## 解决方案

要将工作负载固定到特定的工作节点集，请为这些节点打标签，并在 Pods 上设置匹配的 `nodeSelector`，以便调度器仅将它们放置在带标签的节点上。每个节点已经携带可用作选择目标的内置标签——`kubernetes.io/os`、`kubernetes.io/arch` 和 `kubernetes.io/hostname`——并且可以添加自定义标签以进行更细粒度的分组。

为目标组中的每个节点添加自定义标签：

```bash
kubectl label node <node-name> workload-tier=batch
```

在 Pod 模板的 `nodeSelector` 中引用该标签。API 服务器保持此调度字段不变，因此只有携带匹配标签的节点才会成为候选节点：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: batch-worker
spec:
  nodeSelector:
    workload-tier: batch
  containers:
    - name: app
      image: <image>
```

一种补充方法是将工作负载从一组节点中排除，而不是吸引它们：对节点进行污点处理，并仅向允许在此处的 Pods 授予匹配的容忍度，以便调度器将不容忍的 Pods 保持在污点节点之外。默认情况下，工作节点没有污点，因此这种隔离是选择性的，并通过 `kubectl taint` 显式应用。

对应保留的节点进行污点处理：

```bash
kubectl taint node <node-name> dedicated=batch:NoSchedule
```

为符合条件的 Pods 提供匹配的容忍度；API 服务器保持 `tolerations` 字段不变：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: batch-worker
spec:
  tolerations:
    - key: dedicated
      operator: Equal
      value: batch
      effect: NoSchedule
  containers:
    - name: app
      image: <image>
```

使用 `nodeSelector` 的标签和带有容忍度的污点可以很好地组合：容忍度允许 Pod 进入保留节点，而 `nodeSelector` 则防止其漂移到其他节点。

为了通过租户而不是通过节点来分离工作负载，请使用命名空间。该平台使用核心 Kubernetes `Namespace` 对象来实现这一点，基于普通命名空间结合 RBAC 构建的多租户隔离；将每个租户的工作负载分组到其自己的命名空间中是集群级别推荐的隔离边界。

```bash
kubectl create namespace team-batch
```

## 诊断步骤

要确认集群满足单一架构要求，请检查每个节点报告的架构；在考虑任何混合供应商节点池之前，所有值必须匹配：

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.architecture}{"\n"}{end}'
```

相同的节点状态字段揭示了操作系统、kubelet 版本和容器运行时版本，平台在供应商之间统一抽象，这是混合供应商共存的基础：

```bash
kubectl get nodes -o wide
```

在调度容忍工作负载之前，要验证哪些节点被污点保留，请列出每个节点的污点：

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints}{"\n"}{end}'
```
