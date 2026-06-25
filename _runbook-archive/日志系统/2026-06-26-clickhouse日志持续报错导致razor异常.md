---
tags: [incident]
date: 2026-06-26
component: "日志系统"
fault_type: "日志系统/ClickHouse/损坏分区自动修复阈值过低"
symptom: "clickhouse Pod 处于 Running，但 chi-cpaas-clickhouse-replicated-0-1 日志持续报错，导致 razor 异常"
root_cause: "节点重启后 observability.audit 表出现损坏分区，损坏 parts 总量约 2.60 GiB，超过默认 maxsuspiciousbrokenparts_bytes 的 1.00 GiB 限制，导致表加载失败"
runbook: "[[日志系统-ClickHouse损坏分区导致razor异常-排查手册]]"
branch: ""
source_path: ""
affected_versions: []
---
# clickhouse Pod Running 但日志持续报错导致 razor 异常

## 现象
- `clickhouse` Pod 处于 `Running` 状态，但 `chi-cpaas-clickhouse-replicated-0-1` 日志持续报错。
- 现场现象进一步表现为 `razor` 异常，业务侧可见功能受影响。
- 这类问题不是 Pod 未启动，而是 `ClickHouse` 内部表加载和损坏分区处理过程出现异常。

## 排查过程与命令
- 首先查看 `clickhouse` 日志，发现核心报错为：
  ```text
  DB::Exception: Suspiciously big size (10 parts, 2.60 GiB in total) of all broken parts to remove while maximum allowed broken parts size is 1.00 GiB
  ```
  同时提示可调整 `mergetree` 配置 `maxsuspiciousbrokenparts_bytes`。
- 为确认是否仅是单节点表状态异常，进入正常 `clickhouse` 节点查询 `observability.audit`：
  ```sql
  SELECT DISTINCT partition
  FROM system.parts
  WHERE (table = 'audit') AND (database = 'observability')
  ORDER BY partition ASC
  ```
  正常节点显示 `11` 个 partition。
- 再进入异常节点执行相同查询，返回：
  ```text
  TOOMANYUNEXPECTEDDATAPARTS
  ```
  由此确认 `observability.audit` 表存在损坏分区，且默认阈值不允许自动移除。
- 同时检查三个 `clickhouse` 节点的 `/cpaas` 盘空间，确认仍有可用空间，因此问题并非磁盘满盘导致的数据写入失败。
- 为临时放宽损坏分区处理阈值，执行：
  ```bash
  kubectl edit clickhouseinstallations.clickhouse.altinity.com -n cpaas-system cpaas-clickhouse
  ```
  并在 `spec.configuration.settings` 下增加：
  ```yaml
  mergetree/maxsuspiciousbrokenparts_bytes: "10737418240"
  ```
  将阈值调整为 `10Gi`。
- `Pod` 重建后，执行以下查询验证参数生效：
  ```sql
  SELECT name, value, changed, description
  FROM system.mergetreesettings
  WHERE name LIKE '%suspicious%';
  ```
- 随后在三个 `clickhouse` 节点执行：
  ```sql
  SELECT database,table,name,partition,formatReadableSize(bytesondisk) AS size,state AS state,modificationtime
  FROM system.parts
  WHERE state = 'Broken'
  ORDER BY bytesondisk DESC;
  ```
  检查损坏分区状态是否已被自动恢复。
- 表自动恢复后，删除修改 `clickhouse` 实例 YAML 产生的配置变更，恢复默认参数配置；`clickhouse` Pod 再次重建后未发现数据丢失，说明临时放宽阈值后表已恢复正常。

## 根因与修复方案
- **根因**
  - 节点重启后 `observability.audit` 表出现损坏分区。
  - 损坏 `parts` 总量约 `2.60 GiB`，超过默认 `maxsuspiciousbrokenparts_bytes` 的 `1.00 GiB` 限制，导致表加载失败。
- **临时缓解方案**
  - 将 `mergetree/maxsuspiciousbrokenparts_bytes` 临时调整为 `10Gi`。
  - 待表自动恢复后，再恢复默认配置。
- **根本解决方案**
  - 对 `ClickHouse` 损坏分区自动修复阈值进行版本与环境适配，避免默认阈值过低导致表加载失败。
  - 建立节点重启后关键表健康检查流程，提前发现 `Broken parts` 积压问题并做人工介入。
