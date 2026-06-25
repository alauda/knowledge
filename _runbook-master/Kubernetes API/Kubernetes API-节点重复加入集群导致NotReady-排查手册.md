---
tags: [runbook]
domain: Kubernetes API
component: node-registration
fault_type: Kubernetes API/节点注册/重复节点归属冲突
symptom: 节点 NotReady，kubelet 报 invalid bearer token
last_updated: 2026-06-26
source_incidents: 1
affected_versions: []
---
# Kubernetes API-节点重复加入集群导致NotReady-排查手册

## 适用现象
- 节点 `NotReady`
- `kubelet` 报 `invalid bearer token`
- `describe node` 中多个 condition 为 `Unknown`

## 标准排查路径
1. 查看 `describe node`，确认是否为整体状态上报异常。
2. 检查 `kubelet-client-current.pem` 是否过期。
3. 检查 `apiserver` 与容器运行时是否有直接异常。
4. 在节点侧查看 `10250` 连接，确认 `kubelet` 并非完全未运行。
5. 跨其他集群检查是否存在同一 IP 的重复纳管节点。

## 分支判断
- 如果证书过期，进入证书问题分支。
- 如果证书正常但另一个集群也存在同 IP 节点，进入 **重复节点归属冲突分支**。

## 标准处置步骤
1. 确认故障节点 IP。
2. 在其他相关集群执行 `kubectl get node | grep <节点IP>`。
3. 如确认重复纳管，清理错误归属的节点对象。
4. 确保同一节点只归属于一个集群，并观察当前集群节点状态是否恢复。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| 节点 NotReady，invalid bearer token | 同一 IP 节点被同时加入两个集群，状态上报错位 | 清理重复纳管节点，恢复唯一归属 | [[2026-06-26-节点重复加入集群导致NotReady]] |

## 不适用场景
- 节点证书过期问题
- 网络完全不可达导致的 NotReady

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
