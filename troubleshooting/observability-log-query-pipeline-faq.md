---
title: 日志查询无结果、关键字不匹配与外部 Kafka 链路 FAQ
type: faq
status: draft
domain: observability
product: acp
tags: [observability, logging, elasticsearch, clickhouse, kafka, vector, query, ticket-derived]
updated: 2026-06-24
source: [ticket, backlog-triage, raw-ticket]
evidence_label: medium-merged-existing-no-case
related_tickets:
  - TICKET-1348633284
  - TICKET-1352269254
  - TICKET-1352730134
  - TICKET-1353397784
  - TICKET-1354018204
  - TICKET-1353314714
  - TICKET-1354057234
  - TICKET-1355527234
  - TICKET-1355713644
related:
  - ./observability-log-storage-archive-retention-faq.md
  - ./observability-symptom-runbook.md
---

# 日志查询无结果、关键字不匹配与外部 Kafka 链路 FAQ

## 适用场景

- 日志页面查不到日志、关键字匹配结果异常；
- ClickHouse / ES / Kafka / Vector 链路中某段仍有数据，但页面无结果；
- 客户咨询日志规格调整、4.2 小版本升级后是否支持日志组件能力升级。

## 典型现象

- 页面不显示日志，但采集端或外部 Kafka 看起来仍在吐数据；
- 不带引号查无结果，带引号结果又不准确；
- Kafka 某个 partition 消费卡住，怀疑坏消息或 offset 问题；
- 小规模日志想调整为大规模，担心业务影响和查询中断。

## 排查路径

1. 先拆链路：采集端 / Vector / Kafka / ES 或 ClickHouse / 查询 API / 页面。
2. 页面无日志时，不要只重启 razor；至少确认：
   - 后端存储是否有目标时间窗数据；
   - 查询 API 是否返回空；
   - 是否有条件过滤、cluster 字段、特殊字符或 RPCH 配置导致过滤；
   - Kafka partition 是否存在 lag、坏消息或 retention 等待。
3. 关键字匹配异常时，用 curl 或存储原生查询交叉验证，区分“存储中没有该字符串”和“页面查询语义/代码缺陷”。
4. 日志规模调整时，确认当前日志组件形态；界面升级规格后组件重启期间可能短暂查不到日志，恢复后再验证查询。
5. 4.2 日志能力升级到支持 logdata/S3 冷热等新能力时，先确认产品小版本和日志组件版本，不只看业务集群版本号。

## 处理建议

- 页面无结果但外部 Kafka 有数据：优先查过滤条件、cluster 字段、RPCH/方案配置是否被特殊字符或旧配置影响；
- Kafka 单 partition 卡住：保留消费组、topic、partition、offset 和错误日志，再决定等待 retention、跳过坏消息或 deep-case；
- 搜索语义异常：用 ES/ClickHouse 原生查询保存对照证据，避免直接定性为采集问题；
- 规格调整：说明组件重启窗口和验证方式，避免承诺全程无查询抖动。

## 风险边界

- 该页只覆盖日志查询/链路 FAQ，不覆盖 `/cpaas` 容量增长、归档、索引删除；这些问题转 [[observability-log-storage-archive-retention-faq]]；
- 如果存在 Kafka offset 修复、删除 records、ClickHouse 数据修复等操作，必须先备份关键状态并评估影响；
- 只有“页面没日志”不能证明采集端、Kafka 或存储必然异常。

## 关联工单

- TICKET-1348633284：日志小规模调整为大规模可通过界面更新 ES 插件；组件启动期间可能短暂无法查询，恢复后验证页面查询。
- TICKET-1352269254：日志关键字查询匹配异常，需通过 curl 查询 ES 字符串信息做对照，疑似产品查询功能不足/待优化。
- TICKET-1352730134：Kafka 某 partition 不消费，怀疑坏消息卡队列，等待复现和进一步排查。
- TICKET-1353397784：ClickHouse 日志对接 Kafka 后页面无日志，删除 RPCH 并按方案重新配置后恢复，提示配置/过滤链路优先。
- TICKET-1354018204：4.2 环境需升级到 4.2.5 后才能升级日志组件以获得 4.3 相关 logdata/S3 能力。


## 日志采集/查询链路补充：Secret、路径软链、连接泄漏与日志量异常（2026-06-24）

### 适用场景

- 部署日志组件时报 `secret "log-collector-bearer-auth" not found`；
- 指定路径日志采集不生效，但容器内能看到目标文件；
- 日志页面无法查询，后端 ES/ClickHouse 地址在组件网络命名空间内连接失败；
- nevermore / 日志采集组件 CPU 异常升高，怀疑与业务 Pod 日志量有关。

### 排查路径

1. 缺少日志采集 Secret：先确认 Log Essentials / 日志插件是否安装，再查 `log-center-secret`、`log-collector-bearer-auth` 等前置 Secret；若前置存在但派生 Secret 缺失，可重启 `cluster-transformer` 触发重算。
2. 指定路径采集不生效：确认 nevermore 实际读取的宿主机路径、容器内路径、软链接目标和采集配置是否一致。软链接/挂载路径不一致时，采集端可能拿不到真实文件。
3. 查询无法连接后端存储：在查询组件（如 `courier-api`）的网络命名空间内直接 curl ES/CK 地址，区分“存储不可达”“连接数/端口耗尽”“页面查询异常”。
4. 日志组件 CPU 高：不要先扩容组件；先定位是否有业务 Pod 短时间大量写日志，结合节点磁盘写入、采集速率、nevermore/filebeat 日志确认来源。

### 处理建议

- Secret 缺失类优先恢复日志插件/transformer 的声明态，不建议手工伪造 Secret；
- 路径采集类保留 nevermore 打印路径、容器内 `ls/readlink`、宿主机路径和配置截图，必要时将软链接改为采集端可直接访问的真实路径；
- `cannot assign requested address` 等连接耗尽类可先重启查询组件止血，但要标注可能是连接泄漏或版本缺陷，后续按修复版本收口；
- 业务日志量异常导致采集组件高 CPU 时，应先处理业务日志源或限流策略，避免把采集组件异常写成平台根因。

### 关联工单补充

- TICKET-1353314714：日志部署缺 `log-collector-bearer-auth`，确认日志插件前置 Secret 后重启 `cluster-transformer` 恢复。
- TICKET-1354057234：指定路径日志采集不生效，现场发现 tomcat 目录为软链接，调整为采集端可识别路径后恢复。
- TICKET-1355527234：nevermore CPU 异常升高，排查到异常节点磁盘写入和业务 Pod 日志量高，停止相关 Pod 后下降。
- TICKET-1355713644：日志无法查询，`courier-api` 网络命名空间 curl ES 报 `cannot assign requested address`，临时重启释放连接；问题在 4.1.4 后修复。

### Deep-case 信号补充

- 当前判断：可选。
- 原因：Secret 派生、路径软链、连接泄漏止血和业务日志量异常属于可复用排查模式；若连接泄漏反复出现或采集路径规则不清，需要补版本与组件日志证据。
- 还缺什么证据：日志插件安装状态、相关 Secret 列表、cluster-transformer 日志、nevermore 实际采集路径、软链接解析结果、courier-api 连接数、ES/CK 原生连通性、异常业务 Pod 日志量曲线。

## Deep-case 信号

- 当前判断：可选。
- 原因：普通查询语义、规格调整和配置过滤可按 FAQ 处理；Kafka partition 卡住、offset 操作或跨版本日志组件升级失败可能需要证据链。
- 还缺什么证据：查询 API 原始返回、存储原生查询结果、Kafka consumer lag/offset、Vector/razor 日志、RPCH 配置前后 diff。

## 可链接知识

- [[observability-log-storage-archive-retention-faq]]
- [[observability-symptom-runbook]]
