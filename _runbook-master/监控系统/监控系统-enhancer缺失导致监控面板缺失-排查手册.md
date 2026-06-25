---
tags: [runbook]
domain: 监控系统
component: enhancer/vmselect
fault_type: 监控系统/enhancer指标采集/监控面板缺失
symptom: 新建集群中部分监控面板缺失
last_updated: 2026-06-26
source_incidents: 1
affected_versions: [v4.2]
---
# 监控系统-enhancer缺失导致监控面板缺失-排查手册

## 适用现象
- 新建集群的 `apiserver`、`etcd` 等监控面板比老集群缺失
- 页面并非单纯渲染错误，而是相关指标本身不存在

## 标准排查路径
1. 对比新旧集群的插件差异。
2. 确认是否缺少 `Alauda Container Platform Cluster Enhancer`。
3. 核对 `enhancer` 会暴露哪些指标。
4. 如果补装 enhancer，还要同时评估当前版本的 `vmselect` 已知资源问题。
5. 结合 `alertrule` 和 `servicemonitor` 做联动处理。

## 分支判断
- 如果 enhancer 未安装，进入 **enhancer 缺失分支**。
- 如果 enhancer 已安装但面板仍缺失，再查采集/查询链路。

## 标准处置步骤
1. 确认新集群是否安装 enhancer。
2. 如未安装，先补装 enhancer。
3. 备份并处理可能影响 `vmselect` 的 `alertrule`。
4. 通过 `vmui` 验证 enhancer 暴露指标。
5. 如不需要保留相关指标，可备份并删除 `servicemonitor`。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| 新建集群部分监控面板缺失 | 未安装 enhancer，导致相关指标未暴露 | 安装 enhancer，并视情况处理 `alertrule/servicemonitor` | [[2026-06-26-新建集群中部分监控面板缺失]] |

## 不适用场景
- 指标端口被防火墙拦截
- enhancer 资源上涨

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
