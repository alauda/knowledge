---
tags: [incident]
date: 2026-06-26
component: "容器引擎"
fault_type: "容器引擎/节点状态/根盘满导致服务查询异常"
symptom: "节点 kubelet、containerd 的 systemctl status 查询卡死，节点处于 NotReady"
root_cause: "根盘接近满盘触发 systemd-journald 报 No space left on device，进一步导致 systemctl 通过 D-Bus 查询异常，节点进入 NotReady"
runbook: "[[容器引擎-节点systemctl查询卡死并NotReady-排查手册]]"
branch: ""
source_path: ""
affected_versions: []
---
# 节点 kubelet、containerd 的 systemctl status 查询卡死

## 现象
- 节点上执行 `systemctl status kubelet`、`systemctl status containerd` 时查询卡死。
- 节点状态表现为 `NotReady`。
- 现场排查中同时发现 `journald`、根盘空间以及进程状态均存在异常，说明问题并非单一服务挂起，而是节点系统层资源状态已经恶化。

## 排查过程与命令
- 首先查看内核与系统日志，发现 `dmesg -T` 中反复出现如下报错：
  ```text
  systemd-journald[674]: Failed to open system journal: No space left on device
  ```
  该信息表明日志系统已经受到磁盘空间不足影响。
- 继续执行：
  ```bash
  journalctl --disk-usage
  ```
  输出显示：
  ```text
  Archived and active journals take up 1.2G in the file system.
  ```
  说明 `journald` 已占用较多根盘空间。
- 随后检查根盘使用率：
  ```bash
  df -h /
  ```
  结果显示根盘已使用到 `96%`，可以确认节点已接近满盘状态。
- 在此基础上继续检查关键服务状态，执行：
  ```bash
  systemctl status kubelet
  systemctl status containerd
  ```
  两者均返回：
  ```text
  Failed to get properties: Transport endpoint is not connected
  ```
  说明异常已不只是 `kubelet` 或 `containerd` 进程本身，而是 `systemctl` 依赖的 `D-Bus` 查询链路也已受到影响。
- 为进一步观察系统状态，执行：
  ```bash
  ps aux | awk '$8=="Z"{print}' | wc -l
  ```
  输出为 `7883`，说明节点上存在大量僵尸进程。该现象进一步佐证节点整体运行状态已明显异常，而不是单点服务故障。
- 综合以上现象可以确认：根盘接近满盘后，首先触发 `systemd-journald` 写入失败，随后影响系统服务管理链路，最终表现为 `systemctl status` 查询异常以及节点 `NotReady`。

## 根因与修复方案
- **根因**
  - 根盘接近满盘，触发 `systemd-journald` 报 `No space left on device`。
  - 日志系统异常进一步影响 `systemctl` 通过 `D-Bus` 的状态查询能力。
  - 最终表现为 `kubelet`、`containerd` 状态查询异常，节点进入 `NotReady`。
- **临时缓解方案**
  - 清理根盘空间，恢复节点文件系统可用容量。
  - 重启节点，使 `journald`、`D-Bus` 及关键服务状态恢复正常。
- **根本解决方案**
  - 对节点根盘使用率和 `journald` 占用建立持续监控与清理机制，避免空间长期逼近满盘。
  - 将大量僵尸进程、磁盘使用率异常和 `systemctl`/`D-Bus` 异常纳入节点健康检查项，提前发现系统层退化。
