---
tags: [runbook]
domain: 监控系统
component: enhancer/metrics
fault_type: 监控系统/metrics采集/历史数据累积导致资源上涨
symptom: cluster-enhancer-apiserver 的 cpu/mem 占用持续上升
last_updated: 2026-06-26
source_incidents: 1
affected_versions: [v4.2]
---
# 监控系统-cluster-enhancer-apiserver资源持续上升-排查手册

## 适用现象
- `cluster-enhancer-apiserver` 的 `cpu/mem` 长时间持续上涨
- `metrics` 请求返回数据量持续膨胀
- 可能伴随抓取超时

## 标准排查路径
1. 查 `ServiceMonitor` 配置。
2. 从 `vmagent` 侧定位实际抓取 token 和抓取路径。
3. 直接请求 enhancer 的 `metrics` 接口。
4. 对比正常环境与异常环境返回体量。
5. 判断是否存在历史 metrics 不断累积的问题。

## 分支判断
- 如果 token 或抓取配置有误，先修采集配置。
- 如果配置正常但返回体量持续增大，进入 **历史数据累积分支**。

## 标准处置步骤
1. 确认 `vmagent` 抓取 enhancer 的配置。
2. 获取 token 后直接访问 `metrics`。
3. 对比不同环境返回内容体量。
4. 若确认历史数据不断累积，短期可定期重建 Pod 缓解。
5. 长期升级到已修复版本。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| enhancer CPU/MEM 持续上涨 | 历史 metrics 数据不断累积，导致请求开销增长 | 定期重建 Pod，升级到 `v4.2.5` | [[2026-06-26-cluster-enhancer-apiserver-cpu-mem占用持续上升]] |

## 不适用场景
- enhancer 未安装导致面板缺失
- 防火墙阻断指标采集

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
