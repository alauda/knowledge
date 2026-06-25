---
title: Trace Missing Runbook
type: runbook
status: draft
domain: observability
product: acp
tags: [acp, observability, tracing, runbook, high-frequency]
updated: 2026-05-12
source: [official-docs, experience]
severity: p2
applies_to: [acp-4.3]
prerequisites:
  - tracing installed
  - jaeger query accessible
  - elasticsearch accessible
related:
  - ../../product-catalog/office_docs/faqs/observability-faq.md
  - ../../product-catalog/office_docs/notes/observability.md
  - ../../ticket-documents/TICKET-0000-template/README.md
---

# Trace Missing Runbook

## 适用场景

用于处理这类高频问题：
- 刚产生的 trace 查不到
- 某些请求稳定没有 trace
- UI 偶发查不到，但应用侧怀疑已经上报

## 先给一个结论

“查不到 trace” 通常要先区分两类：
1. **根本没采到 / 没写入**
2. **已经写入，但暂时查不到或查询条件不对**

不要一上来就判断是平台故障。

## 最小验证路径

1. 确认目标请求在应用侧确实发生过，并记录大致时间窗口
2. 在 Tracing 页面优先按以下方式缩小范围：
   - `TraceID`（如果已知）
   - `Service`
   - 更短的时间窗
   - `Only Search Error Spans`（如果目标是失败请求）
3. 如果是“刚发生”的请求，先等待十几秒后刷新，排除 Elasticsearch `refresh_interval` 导致的短暂不可搜索
4. 如果能进入 trace 但链路不完整，再转到“不完整 trace”分支，而不是继续按“missing trace”排

## 高优先级判断分支

### 分支 A：采样没有命中

常见现象：
- 同类请求只有部分能看到 trace
- 业务侧确认有请求，但平台完全无记录

处理思路：
- 先回看采样率配置
- 如果环境使用更复杂的采样策略，再看是否存在 tail sampling / 条件采样带来的过滤

### 分支 B：Elasticsearch 已写入但暂时不可搜索

常见现象：
- “刚产生”的 trace 过一会儿又能查到了
- 问题主要出现在实时查询场景

处理思路：
- 记住 Elasticsearch 索引默认 `refresh_interval = 10s`
- 先做短暂等待再刷新
- 如确有实时性要求，再评估 `jaeger-collector --es.asm.index-refresh-interval`

注意：
- 把该参数调得过激进，甚至设成 `"null"`，会影响 Elasticsearch 性能和查询速度

### 分支 C：查询条件太宽或太偏

常见现象：
- 页面结果太多，看起来像“没有”
- 只按时间窗查，噪音太高

处理思路：
- 优先补 `Service`、`Label`、`Span Duration Greater Than` 等条件
- 如果能从某个已知 span 进入，尝试利用 tag 快速反向构造更精准的查询条件

## 常见误区

- 误区 1：一查不到就判断 tracing 整体坏了
- 误区 2：不区分“没采到”和“还没 searchable”
- 误区 3：时间窗开得太大，结果太杂后误以为没有目标 trace
- 误区 4：trace 不完整时还继续按 missing trace 的思路排

## 相关验证点

- Tracing 页面是否能按更小时间窗查出其他服务的 trace
- Jaeger Query 是否可访问
- Elasticsearch 是否可访问且写入正常
- 如果业务日志已带 TraceID，可联查 Trace Logs 做旁证

## 相关链接

- [ACP Observability FAQ](../../product-catalog/office_docs/faqs/observability-faq.md)
- [ACP Observability Notes](../../product-catalog/office_docs/notes/observability.md)
- [TICKET-0000 Case Template](../../ticket-documents/TICKET-0000-template/README.md)
