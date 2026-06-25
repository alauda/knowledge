---
tags: [runbook]
domain: 日志系统
component: elasticsearch/kafka
fault_type: 日志系统/存储空间耗尽/Elasticsearch与Kafka异常
symptom: /cpaas 磁盘写满，Elasticsearch 和 Kafka 异常
last_updated: 2026-06-26
source_incidents: 1
affected_versions: []
---
# 日志系统-cpaas满盘导致Elasticsearch和Kafka异常-排查手册

## 适用现象
- 监控和日志组件同时异常
- 三个存储节点 `/cpaas` 磁盘写满
- `Elasticsearch` Pod 异常，`Kafka` 无法正常连接 `Zookeeper`

## 标准排查路径
1. 先确认 `/cpaas` 是否满盘。
2. 判断 `Elasticsearch` 是否已失去基础可用性。
3. 如果 `Elasticsearch` 因空间问题异常，先释放空间再恢复分片。
4. 再处理 `Kafka/Zookeeper` 依赖链路。
5. 排查空间来源是否来自监控数据与历史审计数据累积。

## 分支判断
- 如果 `/cpaas` 空间已满，进入 **磁盘耗尽分支**。
- 如果磁盘未满，则分别排 `Elasticsearch`、`Kafka` 本身故障。

## 标准处置步骤
1. 确认三个存储节点 `/cpaas` 使用率。
2. 卸载或临时清理监控数据目录，先释放空间。
3. 确保 `Elasticsearch` 恢复基础运行后，删除历史审计数据。
4. 触发 `Elasticsearch` 集群重分片恢复。
5. 恢复期间临时调整恢复参数。
6. 如 `Kafka` 仍异常，先重启 `Zookeeper`，再重启 `Kafka`。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| /cpaas 满盘导致 ES/Kafka 异常 | 监控和日志共用存储满盘，先压垮 ES，再影响 Kafka 链路 | 先释放空间，再恢复 ES 分片，最后恢复 Kafka/ZK | [[2026-06-26-cpaas磁盘写满导致elasticsearch和kafka异常]] |

## 不适用场景
- 仅 ClickHouse 损坏分区
- 纯前端展示偏差类问题

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
