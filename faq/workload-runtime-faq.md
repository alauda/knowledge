---
title: ACP Workload Runtime FAQ
type: faq
status: draft
domain: workload-runtime
product: acp
tags: [acp, workload-runtime, faq, cpu, gpu, memory, pod, ticket-derived]
updated: 2026-05-13
source: [experience, ticket-cases]
related:
  - ../../../knowledge_base/troubleshooting/workload-runtime-symptom-runbook.md
  - ../../../ticket-documents/indexes/problem-clusters.md
---

# ACP 容器运行时与资源 FAQ

> 这份 FAQ 主要回答历史工单里高频出现的几类问题：
>
> - CPU / GPU / 内存异常
> - Pod 启动失败或容器运行异常
> - YAML 与平台展示的资源值不一致
> - Operator 控制资源配置被“改回去”

## 1. 为什么某个组件 CPU 会周期性飙高？
先不要把“周期性高 CPU”直接等同于故障。

从已有案例看，有些组件会按固定周期同步资源、刷新索引或执行后台任务，所以会出现规律性的 CPU 峰值。

支持现场需要先分两类：
- **规律性峰值，但业务无异常**：可能是组件设计行为
- **峰值异常高，伴随卡顿、重启、限流、告警**：需要进一步排查

关联案例：
- [TICKET-1282398824](../../../ticket-documents/cases/TICKET-1282398824%20CPU周期性过载且调整CPU限制配额后总被还原.md)
- [TICKET-1292277224](../../../ticket-documents/cases/TICKET-1292277224%20asm-otel-backend-collector组件cpu占用高.md)

## 2. 为什么我手动改了 Deployment 的资源限制，过一会又被改回去了？
高频原因是：这个 Deployment 并不是直接人工维护对象，而是被 Operator 控制。

也就是说：
- 直接改 Deployment 往往只是“表面改动”
- 真正生效的配置源，通常在 CR、ConfigMap 或 Operator 管理对象里

如果现场出现“我明明改了，为什么又恢复”，优先先确认：
- 这个工作负载是否被 Operator 管理
- 正确的配置入口到底在哪
- 是否存在周期性 reconcile

关联案例：
- [TICKET-1282398824](../../../ticket-documents/cases/TICKET-1282398824%20CPU周期性过载且调整CPU限制配额后总被还原.md)

## 3. 页面上显示的 CPU / 内存值，为什么和 YAML 看起来不一样？
这是典型 FAQ，不一定是数据错，很多时候只是**单位换算方式不同**。

常见情况：
- CPU：`500m = 0.5 核`
- CPU：`1` 表示 `1 核`
- 内存：如果 YAML 里没写单位，通常按 **byte** 理解
- `1073741824` 对应 `1 GiB`

所以“页面 1G、YAML 里 1073741824”并不一定冲突，可能只是：
- 一边在用人类友好展示
- 一边在保留底层原始值

关联案例：
- [TICKET-1297935034](../../../ticket-documents/cases/TICKET-1297935034%20页面显示的容器资源限制的值，和yaml中不一致.md)

## 4. CPU 超过 100% 是不是一定不正常？
不一定。

在 Kubernetes / Linux 语境里，CPU 百分比往往跟核数、采样方式、展示维度有关。比如：
- 单容器超过 100%，可能表示超过 1 个 CPU 核的使用量
- 如果组件本身允许多核使用，这不天然等于故障

但如果同时伴随：
- 周期性卡顿
- Pod 被限流
- 组件响应变差
- OOM / 重启 / 告警

那就不能只当“展示现象”看。

## 5. Pod 起不来 / 启动异常，第一反应应该先看什么？
别一上来就看平台页面，先回到最基础的四层：

1. **调度层**：资源够不够、污点/亲和性/配额是否拦住
2. **镜像层**：镜像拉取、凭证、仓库连通性
3. **运行时层**：containerd/docker、挂载、证书、runtime 配置
4. **应用层**：启动命令、探针、配置、依赖服务

这类工单最容易被误判成“平台异常”，但实际常常是：
- 资源不够
- 运行时异常
- 挂载失败
- 探针失败
- 依赖服务不可达

## 6. GPU 相关问题，和普通 CPU/内存问题最大的不同是什么？
GPU 问题一般不能只看 Pod 资源字段，还要额外看：
- 节点是否真有 GPU 能力
- 驱动、runtime、device plugin 是否正常
- 调度标签、污点、资源暴露方式是否正确
- 单卡 / 多卡隔离策略是否符合预期

也就是说，GPU 问题通常横跨：
- 节点能力
- 调度约束
- runtime 暴露
- 应用使用方式

关联案例：
- [TICKET-1313719784](../../../ticket-documents/cases/TICKET-1313719784%20GPU单卡隔离.md)
- [TICKET-1285416614](../../../ticket-documents/cases/TICKET-1285416614%20模型应用同时使用CPU和GPU，cpu使用率不高问题.md)

## 7. 内存持续缓慢增长，一定就是内存泄漏吗？
不能直接这么下结论。

支持现场更稳的判断方式是先分三类：
- **缓存增长**：业务正常，重启可回落
- **工作负载特征增长**：跟数据量、任务量、周期性任务有关
- **异常泄漏**：持续上涨且不回落，伴随 OOM、重启或性能下降

所以看到“缓慢增长”，先别直接给“泄漏”定性。

## 8. GPU / PPU 这类特殊算力资源，能像普通资源那样做项目或命名空间限额吗？
不要先按 CPU/内存那套原生 quota 口径泛答。

更稳的判断是：
- 先看这类资源在当前平台里是否沿 **HAMI 资源模型**暴露
- 再看对应资源名、ConfigMap 和能力配置如何治理
- 项目 / namespace 维度的限额通常不是“物理卡天然直接限”，而是要沿特殊资源治理方案落地

关联案例：
- [TICKET-1348886274](../../../ticket-documents/cases/TICKET-1348886274%20阿里ppu的卡%20资源限额咨询.md)

## 9. 这类问题更适合沉淀 FAQ 还是 Runbook？
都值得，但分工不同：

适合 FAQ 的：
- CPU/内存/GPU 单位和展示逻辑
- 为什么手改 Deployment 会被恢复
- 超过 100% 的 CPU 怎么理解
- 资源配置项的常见换算规则

适合 Runbook 的：
- Pod 起不来
- 容器运行异常
- 资源占用异常
- GPU 节点 / device plugin / runtime 排查

## 10. 当前最值得继续整理的子专题是什么？
从样本看，优先级比较高的是：

- **资源单位换算与展示 FAQ**
- **Operator 管理对象的资源配置修改方法**
- **Pod 启动失败分诊手册**
- **CPU/GPU/内存异常现象排查手册**

---

## 代表案例

- [TICKET-1282398824](../../../ticket-documents/cases/TICKET-1282398824%20CPU周期性过载且调整CPU限制配额后总被还原.md) CPU 周期性过载且手工修改资源被还原
- [TICKET-1297935034](../../../ticket-documents/cases/TICKET-1297935034%20页面显示的容器资源限制的值，和yaml中不一致.md) 页面资源值与 YAML 不一致
- [TICKET-1313719784](../../../ticket-documents/cases/TICKET-1313719784%20GPU单卡隔离.md) GPU 单卡隔离
- [TICKET-1285416614](../../../ticket-documents/cases/TICKET-1285416614%20模型应用同时使用CPU和GPU，cpu使用率不高问题.md) 模型应用同时使用 CPU/GPU，CPU 利用率异常

## 后续待补

- 补资源单位换算对照表
- 补 Operator 控制资源修改标准路径
- 补 Pod 启动失败最小分诊流程
