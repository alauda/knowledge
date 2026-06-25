---
tags: [runbook]
domain: 容器存储
component: topolvm/local-storage
fault_type: 容器存储/topolvm/本地存储发现组件依赖缺失
symptom: diskmaker-discovery Pod 状态为 Error
last_updated: 2026-06-26
source_incidents: 1
affected_versions: []
---
# 容器存储-diskmaker-discovery异常-排查手册

## 适用现象
- `diskmaker-discovery` Pod `Error`
- 事件提示 `serviceaccounts "local-storage-admin" not found`
- 本地存储发现链路中断

## 标准排查路径
1. 查看 Pod 使用的 `serviceAccount`。
2. 查看 `describe` 事件是否为 `FailedMount`。
3. 查 `kubectl get sa -A | grep local`。
4. 查 `subs/installplan/csv`。
5. 评估 `Alauda Build of Local Storage` operator 资源完整性。

## 分支判断
- 如果 `serviceAccount` 存在，继续排 Pod 自身问题。
- 如果 `serviceAccount` 不存在，进入 **operator 资源缺失分支**。

## 标准处置步骤
1. 确认 `local-storage-admin` 是否存在。
2. 若不存在，检查 `Alauda Build of Local Storage` 安装状态。
3. 必要时重新安装 operator。
4. 验证 `diskmaker-discovery` 是否恢复。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| diskmaker-discovery Pod Error | Local Storage operator 被卸载或资源残缺，`serviceAccount` 缺失 | 重新安装 `Alauda Build of Local Storage` | [[2026-06-26-diskmaker-discovery-Pod状态为Error]] |

## 不适用场景
- Ceph 展示口径问题
- topolvm PV Released 不释放

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
