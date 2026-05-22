---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500098
sourceSHA: 67dd8c79154fe86caefa81bedffd63cd240f8b3c61690843e9d14886856347c9
---

# RocketMQ Exporter OOM 临时缓解措施

:::info 适用版本
RocketMQ 3.12.x.
:::

## 问题

在某些环境中，RocketMQ exporter 可能会出现内存不足的情况。一个报告的案例在将 exporter 内存增加到 `2Gi` 后才稳定下来。

默认的 exporter 资源配置为：

- CPU: `500m`
- 内存: `512Mi`
- 抓取间隔: `15s`

该 exporter 是用 Java 实现的，并且在报告的环境中，无法直接更新 exporter 的资源设置。

## 临时解决方法

手动修补或编辑 exporter 的 `Deployment`，并将其内存请求和限制提高到 `2Gi`。

## 重要限制

这仅仅是一个临时解决方法。如果 RocketMQ 实例被更新或重新协调，手动更改可能会被覆盖。

## 建议

- 仅将手动调整作为短期缓解措施。
- 在更改后监控实际的稳态内存使用情况。
- 跟进产品方面的修复，暴露 exporter 尺寸通过 CR 或改善 exporter 内存行为。
