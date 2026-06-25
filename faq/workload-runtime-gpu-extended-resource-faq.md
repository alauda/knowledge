---
title: ACP Workload Runtime GPU and Extended Resource FAQ
type: faq
status: active
domain: workload-runtime
product: acp
tags: [acp, workload-runtime, faq, gpu, extended-resources, device-plugin, quota]
updated: 2026-05-15
source: [official-docs, experience]
related:
  - ../notes/workload-runtime-triage-quick-card.md
  - ../faqs/workload-runtime-resource-units-operator-path-faq.md
  - ../learning-progress.md
---

# ACP Workload Runtime GPU / Extended Resource FAQ

这页只处理一组很容易被混成“GPU 不可用”的问法：
- 集群明明有 GPU，为什么页面里不能配
- vGPU / pGPU / 显存单位到底怎么算
- 为什么 namespace 里配不了 GPU quota
- 为什么 Pod 申请了 GPU 还是调度不上
- device plugin、extended resource、node label 分别在管什么

重点不是泛讲 GPU，而是把 ACP 官方文档里对一线最有用的边界压平。

---

## 1. 为什么页面里看不到 GPU / Extended Resources 配置？
最常见原因不是页面坏了，而是**集群里还没有对应资源能力被暴露出来**。

官方文档给出的前提非常明确：
- 只有当集群里已经 provision 了 GPU 资源
- 并且安装了对应的 GPU 插件 / device plugin
- 页面和 quota 才会出现相关 extended resources

一句话：
> 看不到 GPU 配置，先别怪前端，先看集群有没有先把 GPU 能力暴露出来。

---

## 2. `Extended Resources` 在 ACP 里指什么？
在 workload/runtime 语境里，它指的是：
- 集群里除 CPU / memory 外，已经被 Kubernetes 暴露出来的额外资源
- 典型就是：`vGPU`、`pGPU`

在 ACP 控制台里，`Extended Resources` 更像一个入口：
- 让业务 Pod 申请 cluster-available 的硬件加速资源
- 但它不是自己创造资源

一句话：
> Extended Resources 是“已存在资源的申请入口”，不是“凭空启用 GPU”的开关。

---

## 3. vGPU、pGPU、显存单位最容易混的地方是什么？
官方口径里最关键的换算是：
- **100 vGPU units = 1 physical GPU core（pGPU）**
- **1 memory unit = 256 Mi**
- pGPU 只能按整数量级分配

所以最容易误判的是：
- 把 `1` 当成 1 张卡
- 把 `1` 当成 1 Gi 显存
- 把 vGPU 和 pGPU 当成同一种申请口径

一句话：
> ACP 的 GPU 资源值很多时候不是“卡数”，而是虚拟核心数和显存单位。

---

## 4. 为什么 namespace 里不能配置 GPU quota？
先看两个前提：
1. 集群里是否已经有 GPU 资源
2. 对应 GPU 插件 / device plugin 是否已经部署

官方文档写得很死：
- 只有当 GPU 资源已经在集群中 provision 出来时，才能配置 vGPU / pGPU quota
- 使用 vGPU 时，还能进一步配置显存 quota

所以如果用户说：
- “CPU 内存都能配，为什么 GPU 配不了？”

高概率不是权限问题，而是**集群底层还没先把 GPU 资源供出来**。

---

## 5. 为什么装了 GPU 节点，Pod 还是申请不到 GPU？
“节点有 GPU” 和 “Pod 能申请 GPU” 不是一回事。

中间至少还隔着几层：
- 节点物理 GPU 是否正常
- 驱动/runtime 是否正常
- device plugin 是否已部署并健康
- Kubernetes 是否已经把资源暴露到 node allocatable
- namespace quota 是否允许
- workload 是否真的声明了 extended resources

一句话：
> GPU 问题至少要分成“节点有能力”“集群已暴露”“命名空间允许”“Pod 正确申请”四层。

---

## 6. device plugin 在这里到底管什么？
官方对 NVIDIA GPU Device Plugin 的描述很清楚：
- 暴露每个节点上的 GPU 数量
- 跟踪 GPU 健康状态
- 让 Kubernetes 集群可以运行 GPU workload

也就是说，device plugin 更像：
- **把节点 GPU 能力接进 Kubernetes 调度与资源模型**

它不直接等于：
- 业务就一定能调度成功
- quota 一定已经配好
- 应用就一定正确使用了 GPU

---

## 7. 为什么“节点上有 GPU”不等于“平台里已经能看到 GPU 标签 / 设备标签”？
因为官方节点管理文档又多给了一层边界：
- 平台里的 **device labels** 本质上还是 node labels
- 但在你能设置这些 device labels 之前，前提是 **先部署 device plugins**

所以：
- 物理 GPU 存在 ≠ 平台已经有对应设备标签入口
- 设备标签入口出现 ≠ Pod 已经自动具备正确申请方式

一句话：
> 先有 device plugin，后有 device labels；先有资源暴露，后谈调度表达。

---

## 8. Pod 申请了 GPU 还是 Pending，第一反应先看什么？
建议先按最短路径看：

1. **节点 allocatable 里有没有对应 GPU 资源**
2. **namespace quota 是否允许该类 GPU / 显存资源**
3. **Pod 申请的是 vGPU、pGPU，还是别的 resource name**
4. **节点有没有 taint / device label / nodeSelector 约束**
5. **如果是高性能场景，是否还叠加了 topology / CPU pinning / Guaranteed QoS 前提**

很多“GPU 调度失败”并不只是“GPU 不够”，而是：
- 申请口径不对
- quota 不放行
- 调度约束没匹配上

---

## 9. 高性能场景里，为什么只申请 GPU 还不够？
因为官方 resource manager policy 文档强调的是：
- **CPU ManagerPolicy**
- **Memory ManagerPolicy**
- **Topology ManagerPolicy**

它们关注的是：
- CPU pinning
- NUMA affinity
- CPU / memory / device 拓扑对齐

而且它明确给出一个很硬的前提：
- 想获得 dedicated CPU 和 NUMA affinity，Pod 要尽量满足 **Guaranteed QoS**
- requests = limits
- CPU 还要按完整 core 指定

一句话：
> 申请到 GPU 只说明“有设备”，不说明 CPU / 内存 / NUMA 拓扑已经对齐，高性能场景常常还得看 manager policies。

---

## 10. `Guaranteed QoS` 和 GPU / 拓扑策略有什么关系？
官方文档里这条很关键：
- CPU pinning、NUMA affinity、topology alignment 的理想前提，是 **Guaranteed QoS Pod**

所以如果业务在问：
- “为什么同样有 GPU，延迟差很多？”
- “为什么设备在，但性能不稳？”

不能只盯 GPU 数量，还要回到：
- request 是否等于 limit
- CPU 是否按 full cores 申请
- topology / memory manager 是否已按节点侧正确配置

---

## 11. GPU 相关问题和普通 CPU/内存问题最大的不同是什么？
普通资源问题更多停留在：
- request / limit / quota
- 调度和运行时约束

GPU 问题还要多两层：
- **节点设备能力与 device plugin 暴露**
- **资源名称 / 单位 / quota 口径**

也就是说它天然跨四层：
1. 物理设备层
2. 插件暴露层
3. namespace quota 层
4. workload 申请与调度层

---

## 12. 这类问题更适合继续长成 FAQ 还是 Runbook？
先做 FAQ 很值，因为一线最容易先答混的是口径：
- 有没有 GPU 资源
- vGPU / pGPU / memory unit 怎么算
- device plugin 和 extended resources 到底谁管什么

后续如果继续深化，最适合再长一页 runbook：
- **workload runtime GPU scheduling runbook**
- 更偏执行步骤：看 node allocatable、看 quota、看 plugin、看 Pending 证据点

---

## 13. 一句话总口径

> GPU / Extended Resources 问题先别统称“GPU 不可用”；先分清是 **集群还没暴露资源、device plugin 没到位、namespace quota 不允许，还是 Pod 的 extended resource 申请与调度约束没对齐**，其中 vGPU / pGPU / 显存单位口径本身就是高频误判源。
