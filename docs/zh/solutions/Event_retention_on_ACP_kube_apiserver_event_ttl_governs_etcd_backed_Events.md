---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x
id: KB260500158
sourceSHA: 0347b00a20f23babf797d1912b6d6c6614e799e52085d691276ff6067119d374
---

# ACP 上的事件保留 — kube-apiserver 的 event-ttl 管理 etcd 支持的事件

## 概述

Kubernetes `Event` 对象 (`v1/Event`) 是存储在集群 etcd 支持的对象存储中的一等 API 资源，作为版本化列表提供 (`kind: EventList`，每次写入时 `metadata.resourceVersion` 递增)。每个 `Event` 包含生命周期字段 — `firstTimestamp`、`lastTimestamp` 和在相同条件持续触发时递增的 `count` — kube-apiserver 对这些对象应用 `event-ttl`，以便过期条目从 etcd 中进行垃圾回收。在运行 kube-apiserver `v1.34.5`（镜像 `registry.alauda.cn:60080/tkestack/kube-apiserver:v1.34.5`）的 Alauda Container Platform 上，kube-apiserver 是一个静态 Pod，其 `Pod` 对象的 `metadata.annotations."kubernetes.io/config.source" = file`，因此保留设置存在于节点清单中，而不是任何集群范围的 CR 中。

## 根本原因

ACP 上 kube-apiserver 的节点静态 Pod 清单未传递 `--event-ttl` 标志（对清单执行 `grep -c 'event-ttl'` 返回 0）。当省略该标志时，kube-apiserver 会回退到其内置默认值，因此在此集群中，上游 kube-apiserver 默认值 — 而不是 ACP 或 operator 特定的覆盖 — 决定了事件在 etcd 中保留的时间。

## 解决方案

将 ACP 上的 `Event` 保留视为由每个控制平面节点的静态 Pod 清单中的 `--event-ttl` 标志管理的上游 kube-apiserver 行为。读取正在运行的 kube-apiserver Pod 的镜像和配置源，以确认它是静态 Pod 而不是受管的 Deployment：

```bash
kubectl -n kube-system get pod -l component=kube-apiserver \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.kubernetes\.io/config\.source}{"\t"}{.spec.containers[0].image}{"\n"}{end}'
```

要检查 `--event-ttl` 是否设置，请读取托管 kube-apiserver 的节点上的静态 Pod 清单（通常位于 `/etc/kubernetes/manifests/` 下），并 grep 查找该标志；在此 ACP 集群中没有覆盖，因此上游默认值适用于整个集群。

## 诊断步骤

要观察 `Event` 的生命周期，从工作负载生成一个并直接检查 API 对象。创建一个临时隔离命名空间并部署一个引用保证失败拉取的镜像的 Pod；kubelet 和调度器生成一系列 `Scheduled`、`Pulling`、`Failed` 和 `BackOff` 事件，kube-apiserver 会持久化这些事件。每个事件的 `firstTimestamp` 设置为第一次发生的时间，`lastTimestamp` 在条件持续触发时更新，`count` 在重复时递增。这些字段是去重/聚合元数据，允许相同条件的多个发生合并为一个对象；它们 *不是* 导致事件过期的原因。保留是由 kube-apiserver 存储层 TTL 单独管理的，该 TTL 通过 `--event-ttl` 设置：每个事件都以该 TTL 写入，apiserver 的 etcd 存储在 TTL 到期后将其删除，与 `firstTimestamp` / `lastTimestamp` / `count` 值无关。

将事件列出为版本化 API 对象以确认它们是 etcd 支持的：

```bash
kubectl -n <repro-namespace> get events \
  -o yaml | head -40
```

输出以 `kind: EventList` 开头，并带有 `metadata.resourceVersion` 值；`items[]` 下的每个项都有自己的 `firstTimestamp`、`lastTimestamp` 和 `count`。由于节点清单未传递 `--event-ttl`，在此命名空间中观察到的事件将在 kube-apiserver 从 etcd 中删除之前，仍然可以通过标准的上游保留窗口进行查询。
