---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500079
sourceSHA: 48521376d366edab134993694957c16cdb858ee6392b5daad77c74f1a372b81e
---

# 如何触发手动哨兵故障转移

## 介绍

本指南解释了如何使用 `SENTINEL FAILOVER` 命令手动触发 Redis 哨兵模式实例的主/从故障转移。手动故障转移对于验证客户端应用程序是否正确处理主节点变化、验证哨兵法定人数行为以及对当前主节点进行计划维护非常有用。

:::info 适用版本
所有支持哨兵模式的 Alauda Cache Service for Redis OSS 版本。
:::

:::note
本文档使用“主节点”一词来指代复制设置中的主要 Redis 节点。这是当前的标准术语，取代了之前使用的“主节点”一词。
:::

## 前提条件

- 一个运行中的 Redis 哨兵模式实例，至少有一个从节点。
- 对托管实例的命名空间具有 `kubectl` 访问权限，或对任一哨兵 pod 具有终端访问权限。
- Redis 密码（如果实例设置了密码保护）。在默认端口（`26379`）上访问哨兵命令不需要数据节点密码，除非配置了哨兵身份验证。

## 操作步骤

### 1. 确定当前主节点

确定当前哪个 pod 正在作为主节点，以便您可以在之后确认故障转移。可以使用以下任一方法。

**选项 A：使用平台 UI**

打开平台上的 Redis 实例详细信息页面，并查看拓扑面板。当前主节点在拓扑视图中显示。

**选项 B：使用 `INFO replication` 命令**

连接到任何数据节点并运行：

```bash
redis-cli -a <your-password> INFO replication
```

输出中的 `role:master` 表示当前主节点；`role:slave` 表示一个从节点。从节点还报告 `master_host` 和 `master_port`，指向当前主节点。

### 2. 从哨兵 pod 触发故障转移

哨兵 pod 通常以 `rfs-` 前缀命名。打开任一哨兵 pod 的 shell，然后运行：

```bash
redis-cli -p 26379 SENTINEL FAILOVER mymaster
```

`mymaster` 是操作员使用的默认监控集群名称。除非您的实例被故意配置为不同的名称，否则请勿更改它。

成功的故障转移响应返回 `OK`。实际转换通常在 10 秒内完成。

:::tip
您可以从任何哨兵 pod 运行 `SENTINEL FAILOVER` — 哨兵法定人数将协调选举。在短时间内连续调用 `SENTINEL FAILOVER` 可能会因哨兵认为集群未准备好进行另一次故障转移而被拒绝，返回 `NOGOODSLAVE`。
:::

### 3. 验证新主节点

重新运行步骤 1 中的验证。之前作为从节点的 pod 现在应报告 `role:master`，而之前的主节点应报告 `role:slave` 并跟随新的主节点。

您还可以从哨兵 pod 监控故障转移事件：

```bash
redis-cli -p 26379 SENTINEL MASTERS
```

检查 `flags` 和 `ip`/`port` 字段以确认新的主节点。

## 重要考虑事项

- **短暂的不可用窗口**：在哨兵提升新主节点并让从节点重新连接的几秒钟内，客户端可能会收到错误。使用此操作步骤验证您的应用程序的重连逻辑是否正常。
- **法定人数要求**：哨兵必须有健康的法定人数（大多数可达的哨兵 pod）才能执行故障转移。如果法定人数丢失，`SENTINEL FAILOVER` 将无法成功。
- **冷却时间**：哨兵强制执行故障转移超时（默认 3 分钟）。在此期间，第二次手动故障转移可能会被拒绝 — 请等待超时到期或检查 `SENTINEL MASTERS` 输出。
- **哨兵密码**：如果您已配置哨兵密码（请参见 *如何在 Redis 哨兵节点上设置密码*），在运行 `redis-cli` 时，请在端口 `26379` 上使用 `-a <sentinel-password>` 传递它。
- **生产使用**：手动故障转移旨在用于测试和计划维护。请勿将其用作在实际故障期间的自动故障转移的替代方案。
