---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500219
sourceSHA: 16b3fd3b3fdf329d9ff7b639de9e53d049c87d57ad43d25432fb0ebe7e68f8d4
---

# 诊断 kube-controller-manager 中的垃圾收集器同步失败

## 问题

在 Alauda 容器平台 (Kubernetes v1.34.5，`kube-controller-manager` 静态 Pod 镜像 `registry.alauda.cn:60080/tkestack/kube-controller-manager:v1.34.5` 在 `kube-system` 命名空间中)，`kube-controller-manager` 内部的垃圾收集器控制器可能在控制器启动后未能完成其依赖图构建器的同步。当这种情况发生时，控制器 — 在 `logger="garbage-collector-controller"` 下运行 — 在 `garbagecollector.go:144` 处发出 `Starting controller`，在 `garbagecollector.go:152` 处发出 `Garbage collector: not all resource monitors could be synced, proceeding anyways`，在 `garbagecollector.go:157` 处发出 `Proceeding to collect garbage`，并在 `garbagecollector.go:237` 处发出 `Unhandled Error`，其 `err=` 是字面意思的 `timed out waiting for dependency graph builder sync during GC sync`。

## 根本原因

垃圾收集器控制器通过遍历它可以通过集群的 API 发现循环发现的每个 GroupVersionResource，并为每个资源启动一个 informer 监视器来构建依赖图。当 CustomResourceDefinition 的 GroupVersion 过时、其转换 webhook 失败，或者无法通过发现 API 访问时，相应的监视器永远无法完成，依赖图构建器超时 — 这是上游原因家族中经典的失败 API 发现分支，阻止控制器访问其中一个被监视的资源。在这个集群中，控制器记录了失败以及未响应的特定 GroupVersion：`garbagecollector.go:787` 处的 `failed to discover some groups` 行在其 `groups=` 映射中命名了一个过时的 `app.alauda.io/v1alpha2` GroupVersion。当所有者引用指向已删除的 GroupVersionKind 的 CRD 时，同样的根本原因也会出现：控制器在 `garbagecollector.go:358` 处发出每个项目的 `error syncing item`，其 `err="unable to get REST mapping for <gvk>."` 和一个 `item="[<gvk>, namespace: <ns>, name: <name>, uid: <uid>]"` 字段，命名了有问题的 GVK 和孤立对象。

## 解决方案

直接从控制器日志中识别有问题的 CRD：GroupVersion 在 `failed to discover some groups` 行的 `groups=` 映射中命名，GroupVersionKind 以及有问题的命名空间、名称和 uid 在 `error syncing item ... unable to get REST mapping for <gvk>` 行中命名，因此控制器已经指向需要修复的资源。

识别 CRD 后，修复或禁用其转换 webhook，以便 GroupVersion 再次响应发现，或者 — 当 CRD 不再使用时 — 备份并删除它以及任何指向它的孤立所有者引用。一旦有问题的资源可以通过发现再次访问，依赖图构建器完成同步，垃圾收集器恢复工作；因为 `kube-controller-manager` Pod 在故障期间保持健康（`phase=Running ready=true`），在修复 CRD 后不需要重新启动静态 Pod：

```bash
kubectl get crd <name>.<group> -o yaml > <name>.<group>.yaml
kubectl delete crd <name>.<group>
```

## 诊断步骤

在 `kube-system` 中读取 `kube-controller-manager` 静态 Pod 日志，并过滤垃圾收集器发射器，以便依赖图超时和失败发现负载共同出现：

```bash
kubectl logs kube-controller-manager-<node> -n kube-system \
  | grep -E 'garbagecollector\.go|graph_builder\.go'
```

需要查找的信号序列，均由 `logger="garbage-collector-controller"` 记录：

```text
garbagecollector.go:144  "Starting controller"
garbagecollector.go:152  "Garbage collector: not all resource monitors could be synced, proceeding anyways"
garbagecollector.go:157  "Proceeding to collect garbage"
garbagecollector.go:237  "Unhandled Error" err="timed out waiting for dependency graph builder sync during GC sync"
garbagecollector.go:787  "failed to discover some groups" groups="map[\"<group>/<version>\":\"stale GroupVersion discovery: <group>/<version>\"]"
garbagecollector.go:358  "error syncing item" err="unable to get REST mapping for <group>/<version>/<kind>." item="[<gvk>, namespace: <ns>, name: <name>, uid: <uid>]"
```

结合 `groups=` 映射和 `item=` 字段，命名发现失败的 GroupVersion 和指向已删除 CRD GVK 的所有者引用的孤立对象；这两个方面是修复所需解决的失败 API 发现原因家族的两个方面。在同步错误发生时确认控制器 Pod 本身仍然健康 — `kube-system` 中的静态 Pod 应报告 `phase=Running` 和 `ready=true`，这使得修复集中在有问题的 CRD 上，而不是 `kube-controller-manager` 二进制文件：

```bash
kubectl get pod -n kube-system -l component=kube-controller-manager \
  -o jsonpath='{range .items[*]}phase={.status.phase} restarts={.status.containerStatuses[0].restartCount} ready={.status.containerStatuses[0].ready}{"\n"}{end}'
```
