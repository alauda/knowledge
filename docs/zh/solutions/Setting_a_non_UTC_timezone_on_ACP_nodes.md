---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500176
sourceSHA: 3f6654dbf56ab94c970dfa30c6ed32060928ed340351c30125ef57dea9ce5193
---

# 在 ACP 节点上设置非 UTC 时区

## 问题

在运行 Kubernetes 服务器 v1.34.5 的 Alauda 容器平台集群中，使用基于 systemd 的 Ubuntu 22.04 工作节点和控制平面节点，操作员有时需要将节点的系统时区从 UTC 切换到本地时间，以符合本地操作政策或使单个节点的主机日志以墙钟时间读取。节点级时区由底层主机的 systemd 工具链控制 — `timedatectl(1)` 报告当前本地时间、协调世界时间、RTC 时间、配置的时区、系统时钟同步状态和 NTP 服务状态，并且是读取和更改活动时区的标准接口。

## 根本原因

集群编排不拥有每个节点的时区状态；活动时区记录在每个主机的文件系统中，路径为 `/etc/localtime`，这是一个指向 `../usr/share/zoneinfo/<zone>` 的符号链接，标识当前选择的时区（例如，`/etc/localtime -> ../usr/share/zoneinfo/UTC`）。符号链接解析的时区信息数据库，以及 `timedatectl` 读取的内容，由节点操作系统中提供的 `tzdata` 包提供。因此，任何对节点时区的更改必须在主机上进行 — 通过拥有这些文件的 systemd 接口 — 并且仅适用于该主机。

在节点级别操作非 UTC 时区通常不被推荐。一旦单个节点报告不同本地时间字符串的时间戳，集群范围的日志聚合必须应用每个源的偏移处理，以对齐事件在共同的时间线上，这会使关联和事件分类变得复杂。同样的差异在每年两次的夏令时转换中被放大，常常导致日志中的混淆，并破坏假设单调、无跳跃本地时间的应用程序。在每个节点上使用 UTC 可以避免这两类问题，并且是集群主机的常规选择。

## 解决方案

当在特定节点上确实需要非 UTC 时区时，通过在主机上运行 `timedatectl set-timezone <zone>` 来更改节点的时区。在 Ubuntu 22.04 基础上，这会调用 systemd 249 的 `timedatectl` 接口；该命令将 `/etc/localtime` 更新为指向 `/usr/share/zoneinfo/` 下请求的条目，并在一个步骤中通知 systemd 新的活动时区。

通过主机的正常管理路径应用更改（例如，直接主机 shell、管理节点的主机配置工具，或者 — 对于临时管理 — 进入主机挂载命名空间的 `kubectl debug` 会话）。无论如何获取 shell，主机上的命令都是相同的：

```bash
sudo timedatectl set-timezone Asia/Shanghai
```

为了将更改作为一个单位交付，以便在节点重新配置时生效，将相同的调用包装在一个 systemd 一次性单元中，其 `ExecStart` 调用 `timedatectl set-timezone <zone>`，并通过主机的配置工具安装该单元，以便在每次节点重新启动时重新应用。仅将该单元应用于确实需要非 UTC 时区的节点，其余集群保持在 UTC，以保持聚合日志的对齐。

## 诊断步骤

通过启动一个调试 pod，将目标节点的根文件系统挂载到 `/host`，并直接从那里读取三个由 systemd 管理的接口，来验证目标节点的实时状态。调试 pod 是 Kubernetes 服务器 v1.34.5 集群中最便携的入口点，通过 `/host` 挂载读取避免了需要 chroot 进入主机命名空间 — `chroot /host` 在该集群中不被允许，因为调试 pod 是在没有 `privileged` 能力的情况下创建的：

```bash
kubectl debug node/<node-name> -it --image=busybox
```

配置的时区名称记录在节点操作系统的 `/etc/timezone` 中，是当前设置的最简短读取；在调试 pod 内部，通过 `/host` 挂载读取它：

```bash
cat /host/etc/timezone
```

然后检查底层符号链接以确认哪个时区信息条目处于活动状态；链接目标直接标识所选时区。通过 `/host` 挂载读取它：

```bash
ls -l /host/etc/localtime
```

最后，通过查询节点的包管理器，使用 `--root=/host` 确认支持符号链接和 `/etc/timezone` 的时区信息数据库已安装 — `tzdata` 是提供 `/usr/share/zoneinfo/` 和时区定义的包，这两个接口都读取自：

```bash
dpkg --root=/host -l tzdata
```

如果 `timedatectl` 报告意外的时区或 `/etc/localtime` 指向错误的条目，请在主机上重新运行 `timedatectl set-timezone <zone>`，以将符号链接和 systemd 跟踪的活动时区恢复到所需状态。
