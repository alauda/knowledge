---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500005
sourceSHA: 4b084b99ae69bede07c322a0c29629ee01d98e41b875a84372fa1841b8a3c379
---

# ACP 节点上的默认 kubelet 垃圾回收

## 问题

计划容量、磁盘余量或驱逐策略的集群操作员需要了解 Alauda 容器平台节点上 kubelet 默认执行的图像和容器垃圾回收——它是否运行、监视哪些信号以及在任何节点级别的覆盖之前继承的阈值是什么。由于每个 ACP 节点都运行上游 kubelet，垃圾回收开箱即用地启用，并继续运行，除非节点管理员进行更改。

## 根本原因

没有单一的“GC 开/关”开关。kubelet 暴露了一组固定的可调参数，分为图像 GC（由 `imageGCHighThresholdPercent` / `imageGCLowThresholdPercent` 和图像年龄字段驱动）和 pod 驱逐（由 `evictionHard` 和 `evictionSoft` 信号映射驱动），每个节点继承这些字段的上游默认值，除非管理员在节点上进行更改。策略的驱逐部分围绕标准 kubelet 信号定义构建：`memory.available` 是从节点的内存容量减去工作集得出的，`nodefs.available` 和 `nodefs.inodesFree` 来自节点文件系统统计信息，`imagefs.available` 和 `imagefs.inodesFree` 来自容器运行时图像文件系统统计信息——这正是上游 `kubelet.config.k8s.io/v1beta1` KubeletConfiguration 声明的形状。

## 解决方案

将继承的默认值视为基线策略。kubelet 为垃圾回收暴露的可调参数分为三个独立组，任何组合都可以进行调整：容器的软驱逐策略、容器的硬驱逐策略以及基于图像文件系统使用情况的图像垃圾回收策略。这些可调参数的标准上游形式是 `kubelet.config.k8s.io/v1beta1` 下的 `KubeletConfiguration` 结构；在 ACP 节点上，保持相同的结构形状，任何覆盖都在节点级别应用（例如，通过编辑 `/var/lib/kubelet/config.yaml` 并重启 kubelet），而不是通过集群范围的自定义资源。

在单个节点上的典型编辑，字段保持在上游结构形状内：

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80
evictionHard:
  memory.available: "100Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"
  imagefs.inodesFree: "5%"
```

## 诊断步骤

在更改任何内容之前，读取运行节点上的实时有效 kubelet 配置——这将返回合并视图（上游默认值加上任何节点本地覆盖），并包括上述所有 GC 和驱逐字段：

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | jq '.kubeletconfig'
```

当仅对这些字段感兴趣时，将投影缩小到垃圾回收和驱逐子集：

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | jq '.kubeletconfig | {imageGCHighThresholdPercent, imageGCLowThresholdPercent, imageMinimumGCAge, imageMaximumGCAge, evictionSoft, evictionHard, evictionPressureTransitionPeriod, evictionMinimumReclaim, kubeReserved, systemReserved}'
```

该端点由 kubelet 本身提供，与任何集群侧配置交付无关；它直接回答操作员的问题“这个 kubelet 现在实际使用的是什么”，这是验证继承默认值和任何节点级更改效果的正确诊断。在多个节点上交叉检查相同的投影可以确认这些值在集群中是否一致，或者在单个节点上是否发生了漂移。
