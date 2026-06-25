---
tags: [runbook]
domain: 监控系统
component: vmstorage/health-check
fault_type: 监控系统/健康状态刷新滞后/监控数据积压
symptom: 平台健康状态面板显示异常，部分组件状态未及时刷新；vmstorage 告警频繁
last_updated: 2026-06-26
source_incidents: 1
affected_versions: [v4.1, v4.2, v4.3]
---
# 监控系统-健康状态面板异常与vmstorage告警频繁-排查手册

## 适用现象
- 平台健康状态面板显示异常
- 部分组件状态未及时刷新
- `vmstorage` 告警频繁，资源波动较大

## 标准排查路径
1. 先确认相关 `pod` 和 `ep` 是否都正常。
2. 查页面 F12，请求来源是否为 `modulehealthrecords / cpaasmodulehealth`。
3. 排除 `courier`、`courier-api` 自身连通性问题。
4. 回溯是否存在监控断点或历史数据积压。
5. 评估 `vmstorage` 与 `vmagent` 资源限制及底层 `IO` 性能。

## 分支判断
- 如果服务本身异常，先排业务服务。
- 如果服务正常但页面显示滞后，进入 **历史数据积压 / 资源不足分支**。

## 标准处置步骤
1. 确认非灾备集群基础状态正常。
2. 核对健康状态指标来源。
3. 重启 `courier` / `courier-api` 验证是否为短时缓存问题。
4. 回溯监控断点与告警积压。
5. 调整 `vmstorage` 的 `cpu` 限制值与 `vmagent` 的 `memory` 限制值。
6. 持续观察告警频率和页面刷新状态。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| 健康状态面板滞后且 vmstorage 告警频繁 | 监控组件资源不足、历史数据积压、底层 SAN 盘 IO 偏弱 | 调整 `vmstorage/vmagent` 资源并持续观察 | [[2026-06-26-平台健康状态面板异常且vmstorage告警频繁]] |

## 不适用场景
- enhancer 未安装导致面板缺失
- ingress 10254 被防火墙拦截

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
