---
title: ACP Workload Runtime Resource Units and Operator Path FAQ
type: faq
status: active
domain: workload-runtime
product: acp
tags: [acp, workload-runtime, faq, resources, units, operator, quota, gpu]
updated: 2026-05-15
source: [official-docs, experience]
related:
  - ../faqs/workload-runtime-faq.md
  - ../faqs/workload-runtime-probe-readiness-hpa-faq.md
  - ../notes/workload-runtime-triage-quick-card.md
  - ../learning-progress.md
---

# ACP workload runtime：资源单位 / quota / operator 路径 FAQ

这页只压一组最容易反复答混的问法：
- 页面资源值为什么和 YAML 看起来不一样
- request / limit / quota 到底是什么关系
- overcommit ratio 为什么让我改不了 request
- 为什么我改了 Deployment 资源，过会儿又被改回去
- GPU / vGPU / 显存单位到底怎么理解

---

## 1. 为什么页面上的 CPU / 内存值和 YAML 看起来不一样？
很多时候不是平台算错，而是**展示口径和原始单位不同**。

官方单位基线是：
- CPU：`1 core = 1000m`
- Memory：`1 Gi = 1024 Mi`
- vGPU：`100` 个虚拟核心 = `1` 个物理 GPU core
- 显存：`1` 单位 = `256 Mi`

所以常见现象是：
- YAML 写 `500m`，页面更像在展示 `0.5 core`
- YAML 写 `1024Mi`，页面可能更像展示 `1Gi`
- GPU/显存页面是整数输入，但底层语义不是“1 就等于整张卡”

一句话说：
> 很多“不一致”只是单位换算不同，不是资源值丢了。

---

## 2. CPU 里的 `m` 到底是什么？
`m` 是 millicore。

也就是：
- `1000m = 1 core`
- `500m = 0.5 core`
- `100m = 0.1 core`

所以如果看到：
- request: `100m`
- limit: `200m`

最直接的理解就是：
- 调度至少按 `0.1` 核留资源
- 运行最多用到 `0.2` 核

---

## 3. 内存里的 `Mi` 和 `Gi` 怎么换？
官方口径是二进制单位：
- `1 Mi = 2^20 bytes`
- `1 Gi = 2^30 bytes`
- `1 Gi = 1024 Mi`

所以：
- `2048Mi = 2Gi`
- `512Mi = 0.5Gi`

如果页面把它转成人类友好展示，不代表 YAML 错了。

---

## 4. request 和 limit 本质上分别在管什么？
最短理解：
- **request**：调度下限，告诉 scheduler“至少给我留这些资源”
- **limit**：运行上限，告诉 runtime“最多只能用到这里”

结果上：
- request 决定 Pod 能不能调度到某个节点
- limit 决定容器运行时的资源边界

再短一点：
> request 更偏“能不能上车”，limit 更偏“最多跑多快”。

---

## 5. request、limit 和 namespace quota 到底是什么关系？
官方文档里最关键的约束是：

`Request ≤ Limit ≤ Namespace quota maximum`

而 namespace quota 管的是：
- 整个 namespace 下所有 Pod 的累计 requests
- 整个 namespace 下所有 Pod 的累计 limits
- 以及 Pod 数量上限

所以如果现场现象是：
- 单个 Pod 配得没问题
- 但一扩副本就失败

不要只盯单 Pod，要看：
- namespace 累计 quota 是否已经到顶
- pods 数量 quota 是否到顶

---

## 6. 为什么有时候 request 不能手动改？
高频原因是 namespace 开了 **overcommit ratio**。

官方口径是：
- 开启 overcommit ratio 后
- `request = limit / overcommit ratio`
- request 会自动计算
- **不能手工修改**

而且还有一个很容易漏掉的点：
- overcommit ratio 变化后，通常要 **重建 Pod** 才生效

所以如果用户说：
- “为什么我只能改 limit，改不了 request”
- “为什么我改完 ratio 了，Pod 还是旧值”

优先就看 overcommit ratio。

---

## 7. 为什么没有 namespace quota 时，看起来资源约束变松了？
因为官方文档明确写了：
- **没有 namespace quotas → no container resource constraints**

这不等于资源无限，也不等于集群真不会出问题。
它更准确的意思是：
- 少了一层 namespace 侧默认约束和默认继承口径
- 但最终仍然不能超过 cluster 实际容量

所以：
> 没有 quota 是“少一层平台约束”，不是“资源真的无限”。

---

## 8. 为什么我手动改了 Deployment 的资源，过一会又被改回去了？
最常见原因不是页面抽风，而是这个对象**不是最终配置源**。

如果它是 **Operator Backed Application**：
- Deployment 往往只是 Operator reconcile 出来的结果
- 真正应该改的是 Operator 管的 **Custom Resource（CR）**
- 例如文档里就明确提到，创建 Operator Backed 应用时要在 CR 里配置：
  - `spec.resources.limits`
  - `spec.resourceQuota`
  - 以及其他 Operator 自定义字段

所以现场更稳的判断是：
1. 这个 workload 是原生 Deployment，还是 Operator Backed？
2. 如果是 Operator Backed，真正入口是不是 CR？
3. 有没有周期性 reconcile 把手工改动覆盖掉？

一句话说：
> 被 Operator 管的对象，直接改 Deployment 往往只是改“结果”，不是改“配置源”。

---

## 9. 怎么快速判断一个资源值问题，是原生 workload 还是 Operator 路径问题？
可以先这样分：

### 更像原生 workload
- Deployment / StatefulSet 是直接创建和维护的
- 改 YAML 后没有别的控制器持续改回去
- 问题更像 request/limit/quota/unit 口径问题

### 更像 Operator 路径
- 页面里本来就是通过 **Operator Backed App** 创建的
- 底层 Deployment 经常被自动改回
- 资源字段来自某个 CR 的 `spec`
- 还有 install/upgrade/reconcile 这些控制动作

---

## 10. GPU / vGPU / 显存单位最容易误判什么？
最容易误判的是把它当成“和 CPU / memory 一样直观”。

官方口径里：
- vGPU 是按**虚拟 GPU core 数**算
- `100` 虚拟核心才等于 `1` 个物理 GPU core
- 显存按整数单位输入，但 `1` 单位只等于 `256Mi`

所以：
- `1` 不是“1 张 GPU”
- `1` 也不是“1Gi 显存”

如果现场觉得 GPU 资源值“特别小”或“特别怪”，先确认它看的到底是：
- 物理卡
- 虚拟核心
- 还是显存单位

---

## 11. 为什么 HPA 的 CPU / memory 百分比有时看着和期望不一样？
因为 HPA 的利用率不是只看绝对使用量，还会参考 **resource request**。

官方描述里很关键的一点是：
- 如果设的是 utilization target
- 控制器会把当前使用量算成相对于 request 的百分比

这意味着：
- request 配得过小，百分比很容易显得偏高
- request 配得过大，百分比又可能显得偏低

所以有些“HPA 阈值不准”的根因，其实不是 HPA，而是 request 基线本身不合理。

---

## 12. 资源打满、OOM、磁盘压力，和 request/limit/quota 是同一层吗？
不是同一层。

- request / limit / quota：更像**调度与声明式资源治理层**
- eviction / OOM / disk pressure：更像**节点运行时资源压力层**

比如：
- 内存超 limit 可能触发 OOM killed
- 节点磁盘或内存压力过大，kubelet 可能按 eviction policy 驱逐 Pod
- 这些不是简单“把 request 调大一点”就能解决

一句话说：
> quota 管“怎么分”，eviction/OOM 管“机器已经快扛不住了怎么办”。

---

## 13. 现场最短怎么先把资源问题分层？
可以先这样问：

1. **这是单位展示不一致，还是资源真的不够？**
2. **这是 request/limit 配置问题，还是 namespace quota 卡住？**
3. **namespace 有没有 overcommit ratio？**
4. **这个 workload 是原生 Deployment，还是 Operator Backed？**
5. **是平台展示问题，还是对象被 reconcile 改回去了？**
6. **如果是 GPU，当前值表示的是物理卡、vGPU core，还是显存单位？**

---

## 14. 一句话口径

> 先分清这是单位换算、request/limit/quota 约束、overcommit ratio 自动计算，还是 Operator 管理对象的正确修改入口问题；很多“资源值不对”其实不是一类问题。