---
tags: [runbook]
domain: 容器网络
component: kubelet/iptables
fault_type: 容器网络/节点iptables/10250访问受阻
symptom: 节点 web-cli 连接失败，Pod 日志无法查看
last_updated: 2026-06-26
source_incidents: 1
affected_versions: []
---
# 容器网络-节点10250访问受阻导致web-cli和日志失败-排查手册

## 适用现象
- `web-cli` 连接失败
- 运行在该节点上的 `Pod` 日志无法查看
- `kubectl logs` 报 `connect: no route to host`

## 标准排查路径
1. 排除 Pod 调度异常。
2. 验证问题节点 `10250` 端口本机与外部访问差异。
3. 确认节点到 `6443` 正常但反向访问 `10250` 失败。
4. 检查节点 `iptables` 规则。
5. 关注是否存在 `REJECT ... icmp-host-prohibited`。

## 分支判断
- 如果节点本机访问 `10250` 正常而外部失败，进入 **iptables 拒绝分支**。
- 如果本机也失败，则排 kubelet 监听问题。

## 标准处置步骤
1. 执行 `telnet <问题节点IP> 10250`。
2. 检查 `kubectl logs` 是否同样失败。
3. 检查节点规则。
4. 若存在异常拒绝规则，执行 `iptables -F`。
5. 重启 `kube-proxy` 与 `cni`，验证恢复。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| web-cli 与日志访问失败 | 节点异常 `iptables` 规则拒绝 `10250` | 清理规则并重启 `kube-proxy/cni` | [[2026-06-26-节点web-cli连接失败且Pod日志无法查看]] |

## 不适用场景
- kubelet 本身未启动
- 6443 不通导致节点失联

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
