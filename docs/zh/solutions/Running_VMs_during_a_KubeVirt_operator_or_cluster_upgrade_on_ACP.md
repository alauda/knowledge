---
kind:
  - Information
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500239
sourceSHA: 665b2796305a41a5861477729829931eb894cb79c6323ab11bafa7451db2c5d1
---

# 在 ACP 上进行 KubeVirt 操作员或集群升级期间运行虚拟机

## 问题

在 Alauda Container Platform 上，虚拟化（KubeVirt）功能作为 `kubevirt-hyperconverged` 操作员提供，由上游的 HyperConverged Cluster Operator (HCO) 驱动。控制平面在 `kubevirt` 命名空间中运行（`virt-operator`、`virt-handler`、`virt-controller`、`virt-api`），并注册标准的上游虚拟机生命周期 CRD — `virtualmachines.kubevirt.io`、`virtualmachineinstances.kubevirt.io` 和 `virtualmachineinstancemigrations.kubevirt.io` — 以及 HCO 控制平面的 CRD `hyperconvergeds.hco.kubevirt.io`。计划升级操作员或基础平台的虚拟化管理员需要了解当前正在运行的虚拟机在升级过程中是否会被关闭或暂停。

## 根本原因

升级 `kubevirt-hyperconverged` 操作员的设计是为了确保正在运行的虚拟机不会被关闭或暂停。HyperConverged CR 带有 `spec.workloadUpdateStrategy`，在此集群中，`workloadUpdateMethods` 设置为 `["LiveMigrate"]`；HCO 将相同的 `LiveMigrate` 策略传播到它在升级过程中调和的嵌入式 KubeVirt CR。当新的 `virt-launcher` 镜像推出时，该策略旨在对正在运行的虚拟机进行实时迁移，而不是停止它们，迁移以滚动更新的方式进行（`batchEvictionSize=10`，`batchEvictionInterval=1m0s`），而不是作为批量停止执行。

升级基础平台同样不应关闭或暂停正在运行的虚拟机，除了任何节点升级所固有的节点重启带来的干扰。处理工作负载驱逐的实时迁移机制是存在并运行的 — `kubevirt-migration-controller` 和每个节点的 `virt-handler` DaemonSet（每个节点一个 Pod） — 以便在节点被排空以进行升级时，可以将虚拟机迁移出该节点。

## 解决方案

在操作员升级或平台升级期间，无需采取特殊措施以保持正在运行的虚拟机存活：在 HyperConverged CR 上配置的 `LiveMigrate` 工作负载更新策略 — 并传播到嵌入式 KubeVirt CR — 规定了这种行为。在依赖此行为之前，请确认工作负载更新策略正在生效，并查看与升级相关的操作员和平台版本的特定前提条件或行为变化，以便提前考虑。

该集群以镜像 `build-harbor.alauda.cn/3rdparty/kubevirt/virt-operator:v1.7.0-alauda.2` 运行 KubeVirt 操作员（HCO 操作员 1.17.0；观察到的 KubeVirt 版本为 `v1.7.0-alauda.2`），并且操作员自报告 `Upgradeable=True`、`Available=True`、`Degraded=False`，与非破坏性升级路径一致。

## 诊断步骤

确认控制正在运行的虚拟机的工作负载更新策略，当操作员推出新的 `virt-launcher` 镜像时如何处理。可以从 `kubevirt` 命名空间中的单例 HyperConverged CR 中读取：

```bash
kubectl get hyperconverged -n kubevirt \
  -o jsonpath='{.items[0].spec.workloadUpdateStrategy}'
```

包含 `LiveMigrate` 的 `workloadUpdateMethods` 列表确认在操作员升级时，正在运行的虚拟机将进行实时迁移，而不是被关闭或暂停。确认实时迁移控制器和每个节点的 `virt-handler` DaemonSet 存在并运行，因为它们在操作员和节点升级期间执行驱逐和迁移：

```bash
kubectl get pods -n kubevirt
kubectl get daemonset -n kubevirt virt-handler
```
