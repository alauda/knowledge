---
tags: [runbook]
domain: 日志系统
component: clickhouse/observability
fault_type: 日志系统/ClickHouse/损坏分区自动修复阈值过低
symptom: ClickHouse Pod Running 但日志持续报错，导致 razor 异常
last_updated: 2026-06-26
source_incidents: 1
affected_versions: []
---
# 日志系统-ClickHouse损坏分区导致razor异常-排查手册

## 适用现象
- `ClickHouse` Pod `Running`
- 日志持续报错
- `razor` 异常
- 出现 `Suspiciously big size ... broken parts`

## 标准排查路径
1. 先查 `clickhouse` 日志。
2. 查 `observability.audit` 分区是否异常。
3. 关注 `TOOMANYUNEXPECTEDDATAPARTS`。
4. 确认磁盘空间是否仍可用。
5. 验证 `maxsuspiciousbrokenparts_bytes` 阈值是否过低。

## 分支判断
- 如果磁盘已满，优先排空间问题。
- 如果磁盘正常但 broken parts 超阈值，进入 **自动修复阈值分支**。

## 标准处置步骤
1. 查看日志确认 broken parts 报错。
2. 在正常节点与异常节点对比 `system.parts`。
3. 临时将 `mergetree/maxsuspiciousbrokenparts_bytes` 调高到 `10Gi`。
4. 重建 Pod 并验证参数生效。
5. 检查损坏分区是否自动恢复。
6. 恢复默认参数并确认数据未丢失。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| ClickHouse Pod Running 但报错，razor 异常 | broken parts 总量超默认阈值，无法自动修复 | 临时调高 `maxsuspiciousbrokenparts_bytes` 至 `10Gi` | [[2026-06-26-clickhouse日志持续报错导致razor异常]] |

## 不适用场景
- Elasticsearch 满盘
- Kafka/Zookeeper 依赖故障

## 全量历史案例

```dataview
TABLE WITHOUT ID
  file.link AS 案例,
  branch AS 分支,
  date AS 日期,
  join(affected_versions, ", ") AS 版本,
  root_cause AS 根因
FROM "Troubleshooting/_runbook-archive"
WHERE econtains(tags, "incident") AND econtains(file.outlinks, this.file.link)
SORT branch ASC, date DESC
```
