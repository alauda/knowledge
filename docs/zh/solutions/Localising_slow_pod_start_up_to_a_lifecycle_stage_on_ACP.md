---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500639
sourceSHA: 6e9792d5da7bf513a87d49549c4a2f37689ddaee96a2a8284a3145b8bcae774f
---

# 将慢速 Pod 启动本地化到 ACP 的生命周期阶段

## 问题

一个 Pod 达到 `Ready` 状态所需的时间较长，通常无法仅通过其阶段来揭示延迟发生在哪个生命周期阶段。在 Alauda Container Platform (kube `v1.34.5`) 上，通过读取上游调度器、kubelet 和 CNI 针对每个 Pod 填充的两个表面，可以恢复每个阶段的时间：Pod 的生命周期事件和 Pod 的 `.status.conditions`。将每个阶段的时间戳——调度、网络接口添加和镜像拉取——映射回单一时间线，可以将延迟归因于特定层，而不是进行猜测。

## 根本原因

启动延迟在不同的、顺序的阶段中累积，每个阶段发出自己的时间戳信号。对于正在调查的 Pod，生命周期事件携带阶段原因，如 `Scheduled`、`AddedInterface` 和 `Pulling`，每个事件标记了该阶段发生的时间，因此它们时间戳之间的间隔可以定位墙钟时间的消耗。同时，该 Pod 的 `.status.conditions` 列表包含 `PodScheduled`、`PodReadyToStartContainers`、`Initialized`、`ContainersReady` 和 `Ready` 条件类型，每个条件都有一个 `lastTransitionTime`，提供了其阶段时间线的第二个独立重建。读取一个 Pod 的两个表面并进行比较：事件原因和条件转换是同一生命周期的两个视图，因此一个视图中的大间隔可以证实另一个视图中所看到的主导阶段。

## 解决方案

列出按阶段排序的 Pod 生命周期事件，然后读取其条件转换时间，并比较这两个时间线以找到主导间隔。

列出 Pod 的生命周期事件：

```bash
kubectl get events -n <ns> \
  --field-selector involvedObject.name=<pod> \
  -o jsonpath='{range .items[*]}{.reason}{"\t"}{.eventTime}{"\t"}{.lastTimestamp}{"\n"}{end}'
```

在 kube `v1.34.5` 上，这些生命周期事件在 `lastTimestamp` 列中携带其时间戳，而 `eventTime` 为 `null`，因此基于 `eventTime` 的 `sort -k2` 无法可靠地对行进行排序——应从 `lastTimestamp` 列读取时间线。

读取每个 Pod 状态条件及其转换时间：

```bash
kubectl get pod <pod> -n <ns> \
  -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.lastTransitionTime}{"\n"}{end}'
```

`AddedInterface` 事件是由 `source.component=multus` 发出的，Multus 是 ACP 上的 CNI 元插件，而 `Scheduled` 是由 `source.component=default-scheduler` 发出的；将每个事件归因于其发出者可以确认哪个子系统拥有正在计时的阶段。

## 诊断步骤

当网络接口阶段被怀疑为间隔时，将 Pod 的 `creationTimestamp` 与其 Multus `.metadata.managedFields` 条目的 `time` 进行比较，以测量 Multus 准备接口之前经过的时间。在此 ACP 版本中，Multus 以 `acp/multus-cni:v4.2.4-b223aa77` 形式提供，因此下面的管理字段条目反映了该版本的行为。相关的管理字段条目是由名为 `multus` 的管理者写入的（操作 `Update`，子资源 `status`，携带 `k8s.v1.cni.cncf.io/network-status` 注释）；在一个代表性的 Pod 上，间隔为 `creationTimestamp 15:02:41Z` 与 `multus` 条目 `time 15:02:48Z`，即 7 秒。

一起读取这两个时间戳：

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.metadata.creationTimestamp}{"\n"}'
kubectl get pod <pod> -n <ns> \
  -o jsonpath='{range .metadata.managedFields[?(@.manager=="multus")]}{.time}{"\n"}{end}'
```

这个间隔是一个可测量的阶段，当 Multus 准备 Pod 的接口较慢时，可能主导感知的启动延迟；上述 7 秒的案例虽然较小，但该阶段存在并在每个 Pod 上都有时间戳，因此这里的大间隔标志着网络接口设置是延迟的主要贡献者。
