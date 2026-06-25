---
tags: [incident]
date: 2026-06-26
component: "日志系统"
fault_type: "日志系统/存储空间耗尽/Elasticsearch与Kafka异常"
symptom: "集群监控和日志组件异常，三个节点 /cpaas 磁盘写满；elasticsearch 和 kafka 相关组件报错"
root_cause: "监控和日志组件所在存储节点 /cpaas 磁盘写满，导致 Elasticsearch 无法正常提供索引服务并连带触发 Kafka 依赖异常"
runbook: "[[日志系统-cpaas满盘导致Elasticsearch和Kafka异常-排查手册]]"
branch: ""
source_path: ""
affected_versions: []
---
# /cpaas 磁盘写满导致 Elasticsearch 和 Kafka 异常

## 现象
- 集群监控和日志组件同时出现异常，三个存储节点的 `/cpaas` 磁盘均已写满。
- `elasticsearch` 和 `kafka` 相关组件报错，导致日志链路与相关业务功能受影响。
- 现场首先表现为 `elasticsearch` 三个节点 Pod 均异常，且无法正常 `curl` 请求索引。

## 排查过程与命令
- 首先确认监控和日志三个存储节点均为 `/cpaas` 盘满，说明问题不是单个组件配置异常，而是底层存储空间耗尽导致的系统性故障。
- 随后检查日志相关组件状态，发现 `elasticsearch` 三个节点 Pod 均异常，且无法正常 `curl` 索引，请求恢复前必须先释放 `/cpaas` 空间。
- 为尽快释放空间，先将 `prome` 监控卸载，并清理三个节点的 `monitoring` 目录数据。释放部分 `/cpaas` 空间后，`elasticsearch` Pod 恢复运行，并可正常 `curl`。
- 在 `elasticsearch` 恢复基础可用后，继续通过 `curl` 删除三个月的审计数据，进一步释放三个日志存储节点的磁盘空间。
- 当节点空出大部分空间后，执行 `elasticsearch` 集群重分片恢复，使分片重新进入稳定状态。
- 为加快恢复速度，在恢复期间临时调整 `elasticsearch` 重分片恢复参数：
  ```text
  cluster.routing.allocation.nodeconcurrentrecoveries=10
  indices.recovery.maxbytesper_sec=400mb
  ```
- 与此同时，`kafka` 日志报错无法连接 `zookeeper`。为恢复依赖链路，先重启 `zookeeper` 三个节点，再重启 `kafka`，随后 `kafka` 恢复正常。
- 综合整个过程可以确认，最初的核心问题是 `/cpaas` 磁盘写满；在此基础上，`elasticsearch` 首先受影响，而 `kafka` 异常则是后续链路上的伴随故障。

## 根因与修复方案
- **根因**
  - 监控和日志组件所在存储节点的 `/cpaas` 磁盘写满。
  - 磁盘空间耗尽后，`elasticsearch` 无法正常提供索引服务，并进一步引发 `kafka` 相关组件异常。
- **临时缓解方案**
  - 卸载 `prome` 监控并清理 `monitoring` 目录数据，优先释放 `/cpaas` 空间。
  - 删除三个月的审计数据，进一步回收日志存储空间。
  - 调整 `elasticsearch` 重分片恢复参数，加快恢复速度。
  - 重启 `zookeeper` 和 `kafka`，恢复消息链路。
- **根本解决方案**
  - 建立 `/cpaas` 磁盘容量的持续监控和清理机制，避免监控与日志组件共享存储长期逼近满盘。
  - 对审计数据与监控数据设置容量治理或保留周期策略，减少历史数据无上限累积导致的空间风险。
