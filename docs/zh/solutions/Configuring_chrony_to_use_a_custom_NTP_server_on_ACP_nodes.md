---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x
id: KB260500160
sourceSHA: fdb42acd5e000441f80d8a32343a20da17b5af7b7c6db3ed05fe47d4f846fb2c
---

# 在 ACP 节点上配置 chrony 使用自定义 NTP 服务器

## 问题

Alauda 容器平台节点需要将其时钟指向由操作员提供的 NTP 源，而不是节点操作系统分发的默认设置。每个 ACP 节点上的主机级时间同步守护进程（在 Kubernetes `v1.34.5` 上验证）是 `chronyd`，在 `chrony.service` systemd 单元下启动，并通过链接到 `/lib/systemd/system/chrony.service` 的 `multi-user.target.wants/chrony.service` 启用；该守护进程以 `/usr/sbin/chronyd -F 1` 运行，并从 `/etc/chrony/chrony.conf` 读取其配置。用一个或多个指向所需 NTP 主机的 `server` 行替换分发池条目是更换源的支持方式。

## 解决方案

在每个节点上编辑 `/etc/chrony/chrony.conf`，使其包含每个上游 NTP 源的一行 `server <host> iburst`，并注释掉分发的 `pool` 行，然后重启 `chrony.service`。配置必须在所有节点上保持一致，以保持集群内的时间漂移均匀。一个有效的文件片段如下所示：

```text
# pool ntp.ubuntu.com        iburst maxsources 4
# pool 0.ubuntu.pool.ntp.org iburst maxsources 1
# pool 1.ubuntu.pool.ntp.org iburst maxsources 1
# pool 2.ubuntu.pool.ntp.org iburst maxsources 2

server 192.168.16.4 iburst
server 1307::192:168:16:4 iburst

confdir /etc/chrony/conf.d
sourcedir /etc/chrony/sources.d
```

`server` 行接受 IPv4 和 IPv6 地址；列出集群应访问的每个 NTP 端点。通过重启单元来激活新配置：

```bash
systemctl restart chrony
```

对于应作为 drop-ins 而非直接编辑 `chrony.conf` 的更改，主配置声明了两个扩展点：`confdir /etc/chrony/conf.d` 用于附加配置指令，`sourcedir /etc/chrony/sources.d` 用于时间源定义。放置在这些目录下的文件在执行相同的 `systemctl restart chrony` 后会被拾取，避免直接修改主文件。

持久性说明：`/etc/chrony/chrony.conf` 和 `conf.d` / `sources.d` drop-in 目录是磁盘文件，因此在写入后编辑会在节点重启后保留；`systemctl restart chrony` 仅重新加载已持久化的文件。在每个节点上应用相同的更改——没有集群级控制器来传播它——并在任何被重新映像或重新配置的节点上重新应用，因为重新配置会恢复分发默认的 `chrony.conf`。

在每个节点重启后，确认 chrony 实际上接受了新的源并能够访问它；不要仅依赖重启成功。`chronyc sources -v` 列出配置的源，并带有每个源的状态列（前导的 `^*` 标记当前选定/同步的服务器，`^?` 表示不可达），而 `chronyc tracking` 报告 chrony 当前锁定的服务器的参考 ID、层次和偏移量：

```bash
chronyc sources -v
chronyc tracking
```

期望自定义 NTP 主机出现在 `chronyc sources -v` 中，并且一旦可达，将被选中（`^*`），`chronyc tracking` 显示其为 `Reference ID` 并具有小且稳定的偏移量。保持 `^?` 的源意味着 chrony 无法访问它——NTP 使用 UDP 123 端口，因此在假设配置错误之前，请验证每个节点能够通过 UDP/123 访问 NTP 主机（防火墙、安全组和路由均允许）。

## 诊断步骤

确认守护进程正在运行，已在 systemd 中启用，并且每个节点的活动配置包含预期的 `server` 行：

```bash
ps -o pid,cmd -C chronyd
systemctl is-enabled chrony.service
systemctl status chrony.service --no-pager
grep -E '^(server|pool|confdir|sourcedir)\b' /etc/chrony/chrony.conf
ls -l /etc/chrony/conf.d /etc/chrony/sources.d
```

预期输出是一个以 `/usr/sbin/chronyd -F 1` 调用的单个 `chronyd` 进程，单元报告为 `enabled` 和 `active (running)`，文件显示操作员提供的 `server` 条目，并且分发的 `pool` 行被注释掉——在集群中的每个节点上都是相同的。
