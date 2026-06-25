---
title: Gateway Cross Namespace TLS Runbook
type: runbook
status: draft
domain: networking
product: acp
tags: [acp, networking, gateway-api, runbook, high-frequency]
updated: 2026-05-12
source: [official-docs, experience]
severity: p2
applies_to: [acp-4.3]
prerequisites:
  - gateway api enabled
  - access to gateway and certificate namespaces
related:
  - ../../product-catalog/office_docs/faqs/networking-faq.md
  - ../../product-catalog/office_docs/notes/networking.md
---

# Gateway Cross Namespace TLS Runbook

## 适用场景

用于处理这类高频问题：
- Gateway 想引用其他 namespace 的 TLS Secret
- 证书明明存在，但 Gateway 不生效
- 跨 namespace 证书复用失败

## 先给一个结论

**不能直接跨 namespace 引用 TLS Secret。**

如果 Gateway 需要使用其他 namespace 里的证书，必须在**证书所在 namespace** 创建 `ReferenceGrant`，放通引用关系。

## 最小验证路径

1. 确认目标 TLS Secret 确实存在于另一个 namespace
2. 确认 Gateway 的 listener/证书引用对象写对了
3. 检查证书所在 namespace 是否已创建 `ReferenceGrant`
4. 再看 Gateway 状态是否恢复正常

## 高优先级判断分支

### 分支 A：根本没有 `ReferenceGrant`

常见现象：
- 证书对象存在
- Gateway 配置看起来没问题
- 但 listener 无法正常使用该 Secret

处理思路：
- 在证书所在 namespace 创建 `ReferenceGrant`
- 确认放通的是正确的来源与目标关系

### 分支 B：`ReferenceGrant` 建错 namespace

常见误区：
- 把 `ReferenceGrant` 建在 Gateway 所在 namespace

正确位置：
- 应建在**被引用资源所在 namespace**，也就是证书所在 namespace

### 分支 C：把它理解成单 Secret 精确授权

需要注意：
- 文档特别强调，这不是给单个 Secret 做非常细粒度的临时授权思路
- 它本质上是基于资源引用关系的放通机制

## 常见误区

- 误区 1：觉得 Secret 名字写对就能跨 namespace 用
- 误区 2：`ReferenceGrant` 建错 namespace
- 误区 3：把跨 namespace 证书问题误判成 Gateway 本身故障

## 相关验证点

- Gateway 引用的 namespace / Secret 名称是否正确
- 证书 Secret 是否存在且有效
- `ReferenceGrant` 是否在正确 namespace
- Gateway / Route 的状态字段是否有更明确报错

## 相关链接

- [ACP Networking FAQ](../../product-catalog/office_docs/faqs/networking-faq.md)
- [ACP Networking Notes](../../product-catalog/office_docs/notes/networking.md)
