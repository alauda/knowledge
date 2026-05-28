---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500263
sourceSHA: 91b20d3d5f6c8162a63ac60e1eead210d6259d09fc5d5a3b827c9bc049c3e4f5
---

# 诊断 ACP 虚拟化中 CDI image-import pods 的 ImagePullBackOff 问题

## 问题

在 Alauda 容器平台虚拟化中，image-import pod 可能会卡在 `ImagePullBackOff` 状态，并在 `kubectl get pods` 中长时间保持该状态 — 观察到一个节点调试 pod 在大约 38 小时内保持 `ImagePullBackOff` 而没有被清理。当 kubelet 无法成功拉取 pod 的容器或磁盘镜像时，pod 不会进入 `Running` 状态；它保持在 `ImagePullBackOff` 状态，同时 kubelet 以指数退避的方式重试拉取，pod 的阶段保持为 `Pending`，容器的 `waiting.reason` 设置为 `ImagePullBackOff`。一个拉取镜像持续失败的 pod 在失败时不会被垃圾回收 — 它在 pod 列表中保持 `ImagePullBackOff` 状态，而不是消失，因此卡住的 pod 在底层拉取问题解决之前保持可见。

在这种情况下，受影响的 pods 是属于 `DataImportCron` 的 CDI image-import pods，它们定期尝试从源镜像注册表下载操作系统基础磁盘镜像（例如社区 Linux 基础镜像）。在平台上有两个事实成立：`dataimportcrons.cdi.kubevirt.io` CRD 存在，并且在 `kubevirt` 命名空间中存在一个 `kubevirt-hyperconverged` HyperConverged 实例。

## 根本原因

`ImagePullBackOff` 出现的原因是无法获取镜像 — 源镜像注册表不可达或未配置，或者拉取未授权或被拒绝。因此，指向节点无法访问的注册表的 `DataImportCron` 源的导入 pod 会保持在该状态；在观察到的案例中，拉取因 `dial tcp ... i/o timeout` 失败，kubelet 记录了一个 `BackOff` 事件，消息为 `Back-off pulling image`，而 pod 从未成功拉取。由于 kubelet 不断以退避方式重试同一不可达目标，pod 既没有成功也没有终止。

## 解决方案

首先确认 pod 确实被图像拉取阻塞，并识别它试图获取的图像。导入 pods 在配置的 `DataImportCron` 的目标 DataSource/DataVolume 的命名空间中运行 — 不一定是 `kubevirt` — 因此在命名空间中定位失败的 pod（或在特定的 `DataImportCron` 命名空间中）并检查它；`STATUS` 列显示 `ImagePullBackOff`，容器的 `waiting.reason` 匹配，pod 上的事件携带 kubelet `BackOff` 消息，命名图像。导入 pods 仅在实际配置了 `DataImportCron` 资源的地方出现，并且由于默认情况下未提供任何 common-boot-image 集，因此默认安装可能列出零个。

```bash
kubectl get pods -A
kubectl describe pod -n <dataimportcron-namespace> <import-pod-name>
```

解决该条件意味着使源镜像注册表可达，并授权从集群节点进行拉取 — 例如，通过配置网络可达性或注册表镜像，并提供有效的拉取凭据 — 以便 kubelet 的下一个退避重试可以完成拉取，导入 pod 退出 `ImagePullBackOff`。一旦拉取成功，卡住的 pod 将被清除；它仅在拉取持续失败时保持存在。

`DataImportCron` 资源导入的操作系统基础磁盘镜像集在平台级别进行管理。在该平台上，`kubevirt` 命名空间中的 `kubevirt-hyperconverged` HyperConverged 实例（HyperConverged operator 版本 1.17.0，`hco.kubevirt.io/v1beta1`）具有一个 `spec.enableCommonBootImageImport` 字段，默认为 `true`，其 `dataImportCronTemplates` 在 spec 和状态中均为空 — 默认情况下未提供 common-boot-image 集 — 因此在给定集群上存在的导入 pods 反映了实际配置的 `DataImportCron` 资源。

从 HyperConverged 实例读取切换的当前值：

```bash
kubectl get hyperconverged kubevirt-hyperconverged -n kubevirt \
  -o jsonpath='{.spec.enableCommonBootImageImport}'
```

设置该字段以控制实例上是否启用 common boot-image 导入：

```bash
kubectl patch hyperconverged kubevirt-hyperconverged -n kubevirt --type=json \
  -p '[{"op":"replace","path":"/spec/enableCommonBootImageImport","value":false}]'
```

## 诊断步骤

列举 `DataImportCron` 资源，以将 `ImagePullBackOff` 导入 pod 映射回生成它的 cron 及其目标的操作系统基础磁盘镜像；CRD `dataimportcrons.cdi.kubevirt.io` 在平台上提供。

```bash
kubectl get dataimportcrons.cdi.kubevirt.io -A
```

对于卡住的 pod，kubelet 记录的事件是权威信号：带有 `dial tcp ... i/o timeout` 的 `Failed to pull` 条目指向不可达的注册表，而未授权或被拒绝的拉取则指向缺失或无效的凭据；无论哪种情况，kubelet 都会回退到 `ImagePullBackOff` 并继续以退避方式重试，而不是直接使 pod 失败。

```bash
kubectl describe pod -n <dataimportcron-namespace> <import-pod-name>
```
