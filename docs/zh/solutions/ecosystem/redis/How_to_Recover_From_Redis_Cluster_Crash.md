---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500086
sourceSHA: a3ea5789b5702568a300edc31c4431845c3ff50414a5f701d164fbe76ef8b98c
---

# 如何从 Redis 集群崩溃中恢复

## 介绍

本指南解释了如何恢复一个 Redis 集群模式的 pod，该 pod 的集群状态文件 (`nodes.conf`) 已被删除或损坏，导致节点无法重新加入其集群。最常见的指示是一个 Replica 启动但从未重新连接 — 在 `CLUSTER NODES` 输出中，它的 IP 和端口显示为 `0@0`，而不是预期的 `IP:6379@16379`。

:::info 适用版本
所有 Alauda Cache Service for Redis OSS 的集群模式版本。
:::

:::note
本文档使用“Primary”和“Replica”来指代主 Redis 节点及其副本，取代之前使用的“Master”/“Slave”术语。
:::

## 症状

一个 Replica pod 启动但无法重新加入集群。从任何健康的 pod 中运行：

```bash
redis-cli -a <password> CLUSTER NODES
```

健康节点的条目看起来像：

```text
<node_id> <IP>:6379@16379 master|slave ...
```

一个具有已删除/损坏集群配置文件的节点看起来像：

```text
<node_id> 0@0 ...
```

该坏 pod 还报告它“未在集群中”，并且没有槽分配。

## 恢复操作步骤

恢复操作重置节点的本地集群状态，并将其重新附加为适当 Primary 的 Replica。

:::warning

- `cluster reset` 和 `flushall` 是破坏性的：它们会丢弃节点的本地集群状态和该 pod 上的 *所有数据*。仅在 **损坏的 Replica pod** 上运行它们。绝不要在健康的 Primary 或未确认其数据可替换的 pod 上运行它们。
- 确认坏 pod 上的数据不再具有权威性。由于集群模式将 Primary 的写入复制到 Replicas，Replica 的数据通常可以从其 Primary 重新生成；这使得该操作步骤在 **仅限于 Replica** 上是安全的。
:::

### 1. 确认受影响的 Pod 是 Replica

```bash
kubectl -n <namespace> exec -it <broken-pod> -- redis-cli -a <password> ROLE
```

输出的第一行必须是 `slave`。如果返回 `master`，请 **不要** 继续此操作步骤 — 调查槽覆盖情况，并参考 *如何从跨分片主节点损坏中恢复* 或 *Redis 紧急响应手册* 中的槽丢失操作步骤。

### 2. 重置节点并清除其本地数据

在损坏的 Replica pod 上打开一个 shell 并运行：

```bash
kubectl -n <namespace> exec -it <broken-pod> -- bash

redis-cli -a <password>
> CLUSTER RESET
> FLUSHALL
> QUIT
```

重置后，从健康 pod 中运行 `CLUSTER NODES` 应该显示损坏的节点具有真实的 IP 和端口，但它仍会报告自己为独立节点（没有槽，没有 Primary）。

### 3. 将节点附加为正确 Primary 的 Replica

识别缺少 Replica 的 Primary。从任何健康的 pod 中：

```bash
redis-cli -a <password> CLUSTER NODES | grep master
```

选择缺少正在恢复的 Replica 的 Primary，并捕获其节点 ID — 在下面称为 `<primary-node-id>`。

在损坏的 pod 上，将其附加为 Replica：

```bash
redis-cli -a <password>
> CLUSTER REPLICATE <primary-node-id>
> QUIT
```

### 4. 验证

从任何健康的 pod 中：

```bash
redis-cli -a <password> CLUSTER NODES
```

恢复的 pod 现在应该显示为 `slave`，并且所选 Primary 的节点 ID 列为其主节点，`IP:6379@16379` 正确填充。在将恢复视为完成之前，请等待初始同步（`INFO replication` 显示 `master_sync_in_progress:0`）。

## 重要注意事项

- **操作员协调**：恢复后，操作员应将集群视为健康，并停止尝试重新部署受影响的 pod。如果操作员继续重新创建 pod，请在采取进一步行动之前捕获其日志和 Redis CR 状态。
- **重复出现** `0@0` 在集群输出中表示某些东西正在删除或损坏 `nodes.conf`。常见原因包括手动编辑、主机路径 PV 删除或清除数据目录的脚本。在重复应用此修复之前，调查并消除触发因素。
- **重置前备份**：如果您不确定损坏的 pod 是否确实是 Replica 或持有某些数据的唯一副本，请在运行 `CLUSTER RESET` / `FLUSHALL` 之前备份 pod 的数据目录。
- **密码处理**：所有 `redis-cli` 调用都需要实例密码（如果已配置）。使用 `-a <password>` 或设置 `REDISCLI_AUTH` 以避免在进程列表中泄露密码。
