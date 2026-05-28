---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500303
sourceSHA: 397627def0c9a6b2c8ccd8399c6d108f44ff64679d0b0fc1d28d841be4ef9717
---

# 当其 PVC 无法绑定到默认 StorageClass 时，Operator Pod 卡在 Pending 状态

## 问题

一个由 Operator 驱动的部署，其组件需要持久存储时，如果这些组件创建的 PersistentVolumeClaims 从未绑定，则可能无法启动。未设置 `spec.storageClassName` 的 PersistentVolumeClaim 会回退到集群的默认 StorageClass 进行动态供应，因此该声明依赖于集群中标记为默认的 StorageClass（标准的 Kubernetes 动态供应语义，在 Alauda Container Platform Kubernetes v1.34.5 中保持不变）。当这样的声明请求默认类但没有 StorageClass 被标记为默认时，该声明将保持在 `Pending` 阶段，并且永远不会绑定。挂载在 `Pending` 状态的 PersistentVolumeClaim 的 Pod 不能创建其容器，并且在声明绑定之前将保持在 `Pending` 阶段。

## 根本原因

PersistentVolumeClaim 的 `status.phase` 可能是 `Bound`、`Lost` 或 `Pending`；`Pending` 表示该声明尚未绑定到卷。省略 `spec.storageClassName` 的声明会被路由到带有默认标记的 StorageClass，而在没有默认的情况下，没有 StorageClass 可供供应，导致该声明无限期地保持在 `Pending` 状态。由于消费 Pod 的容器仅在其声明绑定后创建，因此 Pod 自身的 `status.phase` 将保持为 `Pending` —— 被调度程序接受但容器尚未创建 —— 只要声明未绑定。

## 解决方案

确保集群中恰好有一个 StorageClass 被标记为默认。在 Alauda Container Platform 中，默认 StorageClass `topolvm-hdd` 开箱即用（供应者 `topolvm.cybozu.com`，绑定模式 `WaitForFirstConsumer`），因此省略 `spec.storageClassName` 的声明有默认可供绑定，所描述的情况在默认集群中不会出现。如果没有 StorageClass 带有默认标记，则通过将注释 `storageclass.kubernetes.io/is-default-class` 设置为 `"true"` 来标记一个：

```bash
kubectl patch storageclass <name> \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

一旦存在默认 StorageClass，省略 `spec.storageClassName` 的 PVC 将根据标准 Kubernetes 动态供应行为与其绑定，从而摆脱 `Pending` 状态。随着它们的声明绑定，之前处于 Pending 状态的 Operator Pods 可以创建其容器并继续通过 Pending。

## 诊断步骤

列出 StorageClasses 以确认是否有一个被标记为默认。带有 `storageclass.kubernetes.io/is-default-class` 注释的类在其名称旁边显示 `(default)` 后缀：

```bash
kubectl get storageclass
```

```text
NAME   PROVISIONER          RECLAIMPOLICY   VOLUMEBINDINGMODE     ALLOWVOLUMEEXPANSION   AGE
topolvm-hdd (default)   topolvm.cybozu.com   Delete          WaitForFirstConsumer   true                   14d
```

如果没有条目显示 `(default)`，则没有 StorageClass 被标记为默认，省略 `spec.storageClassName` 的声明没有任何可供绑定的对象。检查一个卡住的声明以确认是未绑定的存储阻止了 Pod；描述它会显示声明的 `status.conditions`，其中报告了未绑定的原因，`status.phase` 显示为 `Pending` 而不是 `Bound`：

```bash
kubectl describe pvc <name> -n <namespace>
```

报告为 `Pending` 且缺少默认 StorageClass 原因的声明确认了诊断；一旦存在默认 StorageClass，省略 `storageClassName` 的 PVC 将根据标准 Kubernetes 行为与其绑定，消费 Pod 可以开始。
