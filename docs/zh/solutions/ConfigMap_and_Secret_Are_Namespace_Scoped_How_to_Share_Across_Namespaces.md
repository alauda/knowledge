---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500147
sourceSHA: 18173a129ccac067c141b75128908883b3ddd049c403e8192e7cc43ead023c5d
---

# ACP 中 Pod 规格的跨命名空间 ConfigMap 和 Secret 引用

## 概述

在 Alauda 容器平台 (kube v1.34.5) 上，`ConfigMap` 和 `Secret` 是命名空间范围内的 core/v1 资源 — `kubectl api-resources` 报告这两种类型的 `NAMESPACED=true`，因此每个对象仅存在于一个命名空间中 \。使用它们的 PodSpec 引用字段不携带 `namespace` 选择器：`kubectl explain pod.spec.volumes.configMap` 和 `pod.spec.volumes.secret` 列出了 `{defaultMode, items, name, optional}` 和 `{defaultMode, items, optional, secretName}`，而 `secretName` 的描述逐字说明它是“要使用的 pod 命名空间中的 secret 的名称”；环境注入形状 `envFrom.configMapRef` / `envFrom.secretRef` 和键控的 `valueFrom.configMapKeyRef` / `valueFrom.secretKeyRef` 同样仅暴露 `{name, optional}`（加上 keyRef 变体上的 `key`），没有命名空间字段 \。因此，标准的上游 PodSpec 从 schema 上无法指向 Pod 自身命名空间之外的 ConfigMap 或 Secret。

## 根本原因

标准的上游 `ContainerStateWaiting` 形状携带 `{reason, message}` 字段 — `kubectl explain pod.status.containerStatuses.state.waiting` 精确列出了这一对，kubelet 使用它们来显示 `CreateContainerConfigError` 原因，以及一个 `not found` 消息，标识在 Pod 的命名空间中无法找到引用的 ConfigMap 或 Secret，当容器配置步骤无法找到引用的 ConfigMap 或 Secret 时 \。由于引用字段仅持有一个在 Pod 的命名空间中解析的裸名称，因此命名一个仅存在于其他命名空间的 ConfigMap 或 Secret 的结果与命名一个根本不存在的 ConfigMap 或 Secret 的结果相同。

## 解决方案

通过标准卷、`envFrom` 或 `valueFrom` 路径，没有内置的跨命名空间引用 ConfigMaps 或 Secrets — schema 没有暴露这一点。要使配置或秘密值可用于多个命名空间中的 Pods，请在每个运行消费 Pod 的命名空间中创建 ConfigMap 或 Secret 的副本，并让每个 Pod 通过名称引用其本地副本 \。这种每命名空间副本模式已经是该集群的上游规范：集群范围的列表显示相同名称 `kube-root-ca.crt` 作为独立的 ConfigMap 存在于多个命名空间中（`acp-storage`、`argocd`、`cert-manager` 等），每个命名空间一个副本 \。

当相同的数据必须在多个命名空间之间保持同步时，从单一的真实来源驱动副本，以便在源更改时每个命名空间对象保持一致。PodSpec 引用形状本身保持不变：每个消费 Pod 仍然引用其自身命名空间中的 ConfigMap 或 Secret \。

```yaml
# 相同的 ConfigMap，复制到每个消费命名空间中。
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: team-a
data:
  app.properties: |
    log.level=info
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: team-b
data:
  app.properties: |
    log.level=info
```

## 诊断步骤

当 Pod 无法进入 `Running` 状态，并且其容器报告 `CreateContainerConfigError` 时，kubelet 将缺失引用的详细信息记录为 Pod 事件，聚合在 `kubectl describe pod` 下 — core/v1 `Event` 资源在该集群中存在（`kubectl api-resources` 将其列为可见的、命名空间类型），因此容器的等待 `reason` / `message` 和周围的 `Events:` 块是缺失引用详细信息的地方；期望有一个 `not found` 指示，命名 kubelet 无法在 Pod 的命名空间中解析的 ConfigMap 或 Secret \。

```bash
kubectl get pod -n <pod-ns> <pod>
kubectl describe pod -n <pod-ns> <pod>
```

要确认引用在 Pod 自身命名空间中缺失，请直接查询它。对缺失对象的命名空间 GET 返回 `Error from server (NotFound): configmaps "<name>" not found`（或 `secrets "<name>" not found`），并带有非零退出代码，确认 Pod 的命名空间中不持有引用的资源 \。

```bash
kubectl get configmap -n <pod-ns> <name>
kubectl get secret    -n <pod-ns> <name>
```

要区分拼写错误与在错误命名空间中创建的同名对象，请列出集群范围并按名称过滤。在该集群中，`kubectl get configmaps --all-namespaces` 在 `kube-root-ca.crt` 的情况下显示多个命名空间中的相同名称，演示了该诊断所依赖的“相同名称，不同命名空间”形状 \。

```bash
kubectl get configmaps --all-namespaces | grep <name>
kubectl get secrets    --all-namespaces | grep <name>
```

在 Pod 的命名空间以外的命名空间中找到的结果确认资源存在，但无法通过标准引用字段从 Pod 访问 — 解决方案是创建一个副本在 Pod 的命名空间中，而不是尝试跨命名空间引用 \。
