---
title: ACP Virtualization VM Image Storage Network FAQ
type: faq
status: active
domain: virtualization
product: acp
tags: [acp, virtualization, kubevirt, vm, image, storage, network, faq]
updated: 2026-05-16
source: [official-docs]
related:
  - ../office-docs-home.md
  - ../learning-progress.md
  - ../notes/virtualization-boundary-quick-card.md
  - ../notes/storage-deployment-boundary-quick-card.md
  - ../notes/networking-exposure-model-quick-card.md
---

# ACP Virtualization：VM / Image / Storage / Network FAQ

这页只回答一组很容易被混成“虚拟化有问题”的问法：
- 为什么装了 KubeVirt 相关组件还是不能稳定创建 VM
- 镜像导入失败时先看哪里
- 为什么 VM 直连 IP 访问不是默认能力
- 为什么 snapshot 不能理解成随时在线热备
- 为什么 VM 存储问题经常其实是底层 TopoLVM / Ceph 前提问题

重点不是重写虚拟化全量手册，而是把官方文档里最适合支持现场先答清楚的 VM、镜像、存储、网络四层边界压平。

---

## 1. 为什么先要把 VM、本地前提、镜像、存储、网络分开？
因为 ACP Virtualization 本身就是叠在 Kubernetes 平台能力上的。

官方文档至少给了这几层：
- `VirtualMachine / VirtualMachineInstance` 资源模型
- 节点虚拟化前提
- 镜像导入
- PVC / CSI / CDI 存储链
- Kube-OVN 网络模式
- snapshot / backup 限制

一句话：
> “虚机有问题”通常不是单一组件坏了，而是多层前提中有一层没对齐。

---

## 2. 为什么装了 Operator 还不能直接当成虚拟化已经可用？
因为官方安装链不止 Operator 这一步。

至少还要看：
- 是否是**物理机集群**
- 节点是否启用了 virtualization switch
- **ACP Virtualization with KubeVirt** Operator 是否已安装
- **HyperConverged** 实例是否创建成功
- `status.phase` 是否到 `deployed`
- CDI / KubeVirt 类型实例是否自动创建成功

一句话：
> Operator 装好只是起点，不是“虚机能力一定 ready”的终点。

---

## 3. 为什么只有物理机节点才能谈启用虚拟化？
因为官方安装页写得很明确：
- 节点是**物理机**时，才可以启用或禁用节点虚拟化开关
- Windows 物理节点不支持启用虚拟化

所以如果底层节点前提不满足，后面所有 VM 调度问题都会变成伪问题。

一句话：
> 节点虚拟化开关不是普适按钮，它本来就依赖物理机前提。

---

## 4. 为什么镜像导入失败时，不该先看 VM 运行时？
因为镜像导入本身就是独立一层。

官方镜像文档明确支持：
- 来源：image registry / file server / S3-compatible object storage
- 格式：**QCOW2 / RAW**

另外，HyperConverged 创建时还要在：
- `spec.storageImport.insecureRegistries`
里填对虚机镜像仓库地址。

一句话：
> 镜像导入先看来源、格式、仓库地址，不要一上来先查 VMI 运行日志。

---

## 5. 为什么 VM 存储问题经常其实是底层 storage class 问题？
因为官方存储页说得很直白：
- VM 磁盘本质依赖 **PVC**
- 通过 **CSI** 接存储系统
- 用 **CDI** 初始化磁盘数据

这意味着很多现象：
- VM 创建失败
- 磁盘建不出来
- 数据盘初始化失败

本质都可能已经跑到：
- storage class
- 节点容量
- 存储网络
- CDI 导入链路

一句话：
> VM disk 不是一套独立存储宇宙，还是 Kubernetes 存储消费面。

---

## 6. 为什么 TopoLVM 常被推荐给虚拟化，但不代表它总是最合适？
官方安装页给得很清楚：
- **TopoLVM**：更轻、性能好、接近硬件性能
- 但不能跨节点、可靠性低、不能提供冗余
- **Ceph**：能跨节点、高可用、有冗余
- 但性能更弱、容量利用率更低

所以：
- 性能敏感、接受节点绑定时，TopoLVM 很合适
- 更看重 HA / 跨节点语义时，Ceph 更自然

一句话：
> TopoLVM 是性能优先口径，Ceph 是高可用优先口径，不是简单新旧之分。

---

## 7. 为什么用 TopoLVM 时，多块磁盘配置很容易失败？
因为官方安装页给了一个很实在的限制：
- 如果 TopoLVM 配了多块磁盘
- 虚拟化启用节点上的剩余容量，必须能满足这些磁盘总容量
- 否则 VM 创建会失败

所以这类问题常常不是 YAML 写错，而是：
- 节点本地盘容量不够
- Topology 对应节点不满足条件

一句话：
> TopoLVM 失败高频不是“虚拟化坏了”，而是节点本地容量现实太硬。

---

## 8. 为什么用 Ceph 时，还要关心 VM 所在网络和存储网络互通？
因为官方安装页明确提醒：
- 如果使用 Ceph distributed storage
- 要确保存储所在网络和虚机所在网络可以通信

这说明：
- Ceph 不只是“卷能 provision 出来”就结束
- VM 运行时对数据面的网络可达也有硬依赖

一句话：
> Ceph 侧 provision 成功，不代表 VM 数据面一定没问题。

---

## 9. 为什么“直接通过 IP 访问 VM”不是默认能力？
因为官方文档把这件事直接绑定到网络模式：
- 如果需要直接通过 IP 访问 VM
- 集群必须使用 **Kube-OVN Underlay**

所以这不是：
- 给 VM 多配一个 Service
- 随便改个网卡参数
就能等价替代的事。

一句话：
> VM 直连 IP 是网络架构前提，不是事后补丁能力。

---

## 10. 为什么虚拟化网络问题要优先想到 Kube-OVN，而不是只盯 KubeVirt？
因为官方网络文档明确写了：
- ACP Virtualization with KubeVirt 与 **Kube-OVN 深度集成**
- 支持 IPv6、静态 IP 保留、多网络模式

所以这类问题如果表现为：
- IP 重启后是否保留
- 直连 IP 是否可达
- 多网卡/多网络模式是否满足

往往更像网络模式与 Kube-OVN 集成边界问题。

一句话：
> 虚机网络不只是 KubeVirt 资源问题，常常已经进入 Kube-OVN 网络模型问题。

---

## 11. 为什么 snapshot 不能当成“默认在线热备”理解？
因为官方 backup/recovery 文档给了两个硬限制：
- 创建 snapshot 前要先**停机**
- VM 磁盘使用的 PVC 必须支持**多节点共享访问模式**

所以：
- 不是所有在线 VM 都能直接做快照
- 不是所有本地卷场景都能直接满足前提

一句话：
> snapshot 更像“有条件的恢复能力”，不是默认的在线热备服务。

---

## 12. 为什么 namespace 内存 quota 看起来总是不够用？
因为官方安装页明确解释：
- 承载 VM 的 Pod 内存，通常大于 VM 实际可用内存
- 官方建议预留 **20%** 资源

这意味着：
- 不能直接拿“虚机规划内存”去等价理解 namespace quota 消耗

一句话：
> VM 的 quota 口径和普通容器不完全一样，内存侧要预留冗余。

---

## 13. 为什么开了 VM CPU overcommit 后，用户自己写的 request 不一定生效？
因为官方文档给了硬规则：
- VM 只支持 **CPU overcommit**
- 推荐值 **2 到 4**
- 开启后，container request 会按：
  - `limits / VM overcommit ratio`
 重新计算
- 用户自己通过 YAML 写的 request 就不再是最终决定项

一句话：
> overcommit 一开，request 口径就进入平台规则，不再完全按用户 YAML 原样走。

---

## 14. 一句话总口径

> ACP Virtualization 现场先分清 **节点/Operator/HyperConverged 前提**、**镜像导入**、**PVC/CSI/CDI 存储链**、**Kube-OVN 网络模式**、**snapshot 与 overcommit 限制**；很多“虚机异常”不是 VM 本体坏了，而是底层存储、网络模式或平台前提没先对齐。
