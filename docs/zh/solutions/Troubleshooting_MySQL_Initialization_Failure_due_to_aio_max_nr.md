---
kind:
  - How To
products:
  - Alauda Application Services
ProductsVersion:
  - '4.0,4.1,4.2,4.3'
id: KB260515001
sourceSHA: 871dd4a7e1c6eefd7b01aee5c9ba18e47fc01535da9fb4b344ecbdaf22ddeb0f
---

# 解决 MySQL 初始化失败（由于异步 I/O 插槽耗尽）

## 问题

一个 MySQL Pod（单实例、PXC 或 MGR）无法初始化，容器日志显示 `io_setup() failed`。检查主机发现 `/proc/sys/fs/aio-nr` 达到或接近 `/proc/sys/fs/aio-max-nr`，这意味着内核的异步 I/O 上下文池已耗尽，MySQL 无法注册打开 InnoDB 表空间所需的 AIO 上下文。

这种情况通常出现在已经承载许多 AIO 重负载的主机上（多个 NFS 或分布式存储挂载、其他数据库容器、虚拟化 I/O 路径），默认的 `fs.aio-max-nr = 65536` 已不再足够。

## 环境

- 在 ACP 上的 Alauda 应用服务 for MySQL（任何拓扑：独立 MySQL、MySQL-PXC、MySQL-MGR）
- 带有 libaio 的 Linux 内核（任何支持的发行版）
- 主机已达到或接近内核默认的 `fs.aio-max-nr = 65536`

## 解决方案

### 1. 确认症状

在托管失败 Pod 的节点上，检查当前 AIO 使用情况：

```bash
cat /proc/sys/fs/aio-nr
cat /proc/sys/fs/aio-max-nr
```

如果 `aio-nr` 达到或接近 `aio-max-nr`，则主机已耗尽 AIO 上下文，任何在其上调度的新 MySQL 容器将会因 `io_setup() failed` 而失败。

### 2. 暂时提高 `fs.aio-max-nr`

这可以在不重启节点的情况下解除初始化阻塞：

```bash
echo 1048576 > /proc/sys/fs/aio-max-nr
cat /proc/sys/fs/aio-max-nr
```

在值提高后，删除失败的 MySQL Pod，以便操作员调度一个新的 Pod；初始化现在应该成功。

### 3. 在重启后保持更改

将设置添加到 `/etc/sysctl.conf`（或在 `/etc/sysctl.d/` 下的 drop-in 文件）：

```bash
echo 'fs.aio-max-nr = 1048576' >> /etc/sysctl.conf
sysctl -p
cat /proc/sys/fs/aio-max-nr
```

在每个可能托管 MySQL Pod 的节点上应用此更改——如果调度将 Pod 移动到值仍为默认的节点，故障将再次出现。

### 4. 选择合适的值

`fs.aio-max-nr` 限制内核系统范围内接受的未完成异步 I/O 请求的数量。默认的 `65536` 是为轻量级桌面工作负载设计的，而不是数据库主机。

| 主机配置                                           | 建议值                                   |
| -------------------------------------------------- | ---------------------------------------- |
| 配备快速存储（NVMe/闪存）的专用数据库主机       | `1048576` 或更高                        |
| 还运行数据库的一般用途 Kubernetes 节点           | `262144`                                 |
| 具有多个 NFS / 分布式存储挂载的主机              | `1048576`（每个后端消耗上下文）        |

注意：

- 每个 AIO 上下文消耗少量内核内存；在 RAM 少于 16 GB 的节点上，建议使用较低的值以避免浪费内存。
- 高性能存储从较大的值中受益最多——没有它，存储层将无法驱动足够的并发请求以饱和设备。
