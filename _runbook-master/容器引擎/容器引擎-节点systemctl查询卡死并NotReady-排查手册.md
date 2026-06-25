---
tags: [runbook]
domain: 容器引擎
component: kubelet/containerd
fault_type: 容器引擎/节点状态/根盘满导致服务查询异常
symptom: 节点 kubelet、containerd 的 systemctl status 查询卡死，节点处于 NotReady
last_updated: 2026-06-26
source_incidents: 1
affected_versions: []
---
# 容器引擎-节点systemctl查询卡死并NotReady-排查手册

## 适用现象
- `systemctl status kubelet/containerd` 卡死
- 节点 `NotReady`
- `journald`、根盘空间、僵尸进程同时异常

## 标准排查路径
1. 查 `dmesg -T`。
2. 查 `journalctl --disk-usage`。
3. 查 `df -h /`。
4. 查 `systemctl` 返回的 `D-Bus` 错误。
5. 查僵尸进程数量。

## 分支判断
- 如果根盘空间正常，则继续排 `D-Bus/systemd` 自身故障。
- 如果根盘逼近满盘，则进入 **磁盘耗尽分支**。

## 标准处置步骤
1. 执行 `dmesg -T`、`journalctl --disk-usage`、`df -h /`。
2. 执行 `systemctl status kubelet/containerd` 确认错误。
3. 如确认磁盘不足，优先清理根盘。
4. 清理后重启节点。
5. 验证 `journald`、`D-Bus`、`kubelet`、`containerd` 是否恢复。

## 已知根因与解法
| 现象/分支 | 根因 | 修复动作 | 典型案例 |
|---|---|---|---|
| systemctl 查询卡死且节点 NotReady | 根盘接近满盘，触发 `journald` 与 `D-Bus` 查询异常 | 清理根盘并重启节点 | [[2026-06-26-systemctl-status查询卡死节点NotReady]] |

## 不适用场景
- kubelet 单独进程崩溃
- 节点网络断连问题

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
