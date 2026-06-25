---
tags: [runbook]
domain: 创建集群
component: node-join/form
fault_type: 创建集群/添加节点/端口与环境校验失败
symptom: 添加节点时提示检查超时并报 machines.port 类型错误
last_updated: 2026-06-26
source_incidents: 1
affected_versions: []
---
# 创建集群-添加节点检查超时与machines.port类型错误-排查手册

## 适用现象
- 添加节点时报 `检查超时，请重试`
- 接口返回 `machines.port` 类型错误
- 节点校验始终无法通过

## 标准排查路径
1. 先看接口返回是否为字段类型问题。
2. 若字段类型修正后仍失败，再查节点到 `global vip` 的关键端口。
3. 再检查节点环境是否有 `docker-runc` 等冲突残留。

## 分支判断
- 如果接口报 `cannot unmarshal string into ... int32`，进入 **字段类型错误分支**。
- 如果接口问题消失但仍添加失败，进入 **连通性 / 环境残留分支**。

## 标准处置步骤
1. 修正 `machines-port` 的输入格式。
2. 验证节点到 `6443/60080/443` 的连通性。
3. 移除 `docker-runc`。
4. 重新执行添加节点流程。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| 添加节点接口 400 | `machines-port` 作为字符串提交 | 改为正确类型重新提交 | [[2026-06-26-添加节点时提示检查超时并报machines-port类型错误]] |
| 添加节点检查超时 | 到 `global vip` 关键端口不通 | 放通 `6443/60080/443` | [[2026-06-26-添加节点时提示检查超时并报machines-port类型错误]] |
| 添加节点失败 | 节点残留 `docker-runc` | 移除后重新添加 | [[2026-06-26-添加节点时提示检查超时并报machines-port类型错误]] |

## 不适用场景
- 初始创建集群卡在 `kubeadm init`
- 纯 DNS 53 不通问题

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
