---
tags: [runbook]
domain: 容器存储
component: ceph/capacity
fault_type: 容器存储/Ceph/池容量展示口径偏大
symptom: ceph 池已使用容量在平台显示偏大，与实际使用不符
last_updated: 2026-06-26
source_incidents: 1
affected_versions: [v4.2]
---
# 容器存储-ceph池容量展示偏大-排查手册

## 适用现象
- `ceph` 池容量条接近满盘
- 实际使用量明显低于页面展示
- `ceph df detail` 与平台 UI 不一致

## 标准排查路径
1. 先查 `ceph -s`。
2. 再查 `ceph df detail`。
3. 核对平台页面展示口径。
4. 核对已用与可用容量 query。
5. 区分逻辑容量与物理空间使用率。

## 分支判断
- 如果 `ceph df detail` 也高，说明是真正容量压力。
- 如果 `ceph df detail` 正常但页面高，进入 **前端展示口径分支**。

## 标准处置步骤
1. 执行 `ceph -s` 与 `ceph df detail`。
2. 确认池真实使用率。
3. 核对前端使用的已用/可用 query。
4. 对外解释时以 `ceph df detail` 为准。
5. 若处于已知版本，规划升级到修复版本。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| 页面显示偏大但实际未满 | 前端按逻辑容量口径展示，和物理空间不一致 | 以 `ceph df detail` 为准，升级到已修复版本 | [[2026-06-26-ceph池容量在平台上显示偏大]] |

## 不适用场景
- Ceph 真正满盘
- topolvm 回收问题

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
