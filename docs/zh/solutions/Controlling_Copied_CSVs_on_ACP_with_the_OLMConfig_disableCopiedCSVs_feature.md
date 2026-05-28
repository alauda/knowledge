---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500324
sourceSHA: 99329dd0039732d60349f06e8271931e9c4eed5835bd8d1774de1b6e9df1aad1
---

# 使用 OLMConfig 的 disableCopiedCSVs 功能控制 ACP 上的复制 CSV

## 概述

在 Alauda Container Platform 上，Operator Lifecycle Management 暴露了一个集群范围的单例 `OLMConfig`（apiVersion `operators.coreos.com/v1`，kind `OLMConfig`，name `cluster`），其 `spec.features.disableCopiedCSVs` 布尔值控制集群范围的操作员的 ClusterServiceVersion 是否被复制到其他命名空间。在由市场图表管理的集群中（图表版本 `v4.3.7`，OLM 控制器 `olm-operator` 和 `catalog-operator` 在 `cpaas-system` 中运行），此单例的 `spec.features.disableCopiedCSVs` 默认设置为 `true`。

`disableCopiedCSVs` 功能仅控制通过 AllNamespaces OperatorGroup 已经集群范围的操作员的复制 CSV 行为；它并不定义操作员安装的范围。操作员安装的边界——命名空间范围与集群范围——由 OperatorGroup 决定，而不是由此字段决定。

## 根本原因

当 `disableCopiedCSVs` 为 `false` 时，OLM 将集群范围（AllNamespaces）操作员的 ClusterServiceVersion 复制到每个命名空间，导致每个命名空间生成一个复制 CSV。将 `disableCopiedCSVs` 设置为 `true` 会停止这种复制，因此 ClusterServiceVersion 仅保留在操作员的安装命名空间中，其他地方不会创建副本。

原始的、未复制的 ClusterServiceVersion 存在于持有操作员 Subscription 的命名空间中，因为 Subscription 是驱动安装的因素。在托管集群中，`argocd-operator.v4.2.0` 的 ClusterServiceVersion 位于 `argocd` 命名空间中，与其 Subscription 一起，没有在其他命名空间中复制。

## 解决方案

通过直接读取单例来检查当前设置：

```bash
kubectl get OLMConfig cluster -o yaml
```

要更改该功能，请应用一个清单，将字段设置在 `cluster` 单例上：

```yaml
apiVersion: operators.coreos.com/v1
kind: OLMConfig
metadata:
  name: cluster
spec:
  features:
    disableCopiedCSVs: true
```

```bash
kubectl apply -f olm-config.yaml
```

禁用复制 CSV 不会影响操作员的范围。操作员的协调范围由其 OperatorGroup 设置，而不是由此字段设置，因此即使没有复制 CSV 存在，目标所有命名空间的操作员仍然会在每个命名空间上执行操作。由于范围是由 AllNamespaces OperatorGroup 设置的，而不是由此字段设置的，因此具有 AllNamespaces OperatorGroup 的操作员即使在禁用复制 CSV 的情况下也会监视每个命名空间。

## 诊断步骤

`OLMConfig` 单例通过类型为 `DisabledCopiedCSVs` 的状态条件报告复制 CSV 状态。当复制 CSV 被禁用时，条件携带原因 `CopiedCSVsDisabled`；`CopiedCSVsEnabled` 是此条件原因字段的另一个值——如果 `disableCopiedCSVs` 设置为 `false`，状态将报告的原因。读取单例以检查此条件：

```bash
kubectl get OLMConfig cluster -o yaml
```

要确认没有副本存在，请列出跨命名空间的 ClusterServiceVersions。设置 `disableCopiedCSVs=true` 时，每个 ClusterServiceVersion 仅出现在其自己的安装命名空间中，并且没有 ClusterServiceVersion 是另一个的副本。对于 AllNamespaces 的 `argocd-operator.v4.2.0` 操作员，其 ClusterServiceVersion 仅存在于 `argocd` 命名空间中，与其 Subscription 在同一命名空间。
