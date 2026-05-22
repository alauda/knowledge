---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500081
sourceSHA: 4426d9c27bc6a55442fd19b489639e55278db37f5ffdbb680f75ea7d8bba4252
---

# 手动移除失败的 Redis 集群节点

## 介绍

当一个 Redis 集群节点被永久移除（例如，在 pod 被删除或迁移后，其 IP 不再使用），集群的 gossip 视图可能仍然保留带有 `fail` 状态的过时条目。为了清理这些条目，操作员需要对集群中的 **每个其他节点** 发出 `CLUSTER FORGET` 命令，因为每个节点独立跟踪集群拓扑。

本指南提供了一个小型辅助脚本，用于在所有健康节点上发出 `CLUSTER FORGET` 命令。

:::tip
对于一个相关但不同的情况 - 清理孤立的 IP 回收伪影（例如，使用 Calico CNI），请参见 [清理无效的 Redis 集群节点](./How_to_Cleanup_Invalid_Cluster_Nodes.md)。
:::

## 先决条件

1. 一个健康的 Redis 集群，至少有一个可访问的主节点（状态不是 `fail`）。
2. 集群密码（在下面称为 `<password>`）。
3. 在运行脚本的机器上可用 `redis-cli`。如果未安装，请从您的发行版的软件包仓库中安装（例如 `yum install -y redis` 或使用平台 Redis pod 镜像中捆绑的版本）。
4. 脚本主机与集群中的 **每个** 节点之间的网络连接。

## 操作步骤

### 1. 列出集群节点

选择任何健康节点并列出集群拓扑：

```bash
redis-cli -h <node-ip> -a '<password>' cluster nodes
```

示例输出：

```text
e457476882acfaebcc860466da141a32972eace4 10.33.1.33:6379@16379 master - 0 1616656953463 0 connected 10923-16383
73cb7a3c3c5c1db1a43c7483eacc1fc261757cec 10.33.0.218:6379@16379 slave e457476882acfaebcc860466da141a32972eace4 0 1616656955466 1 connected
8bba60e0ed2c0cf33395399c2b8951dd0b9c0f57 10.33.0.50:6379@16379 slave 9023b45408c79a0f5e7434dad6547e59ff487b77 0 1616656950455 4 connected
5f2a6fab812ffb29e59456ff3b987ba68d0af46b 10.33.1.229:6379@16379 myself,slave 0b0e62b3dfdb5c55fd203ef01160c752c60e48bf 0 1616656952000 3 connected
9023b45408c79a0f5e7434dad6547e59ff487b77 10.33.0.217:6379@16379 master - 0 1616656952460 4 connected 5461-10922
0b0e62b3dfdb5c55fd203ef01160c752c60e48bf 10.33.0.49:6379@16379 master - 0 1616656954464 5 connected 0-5460
```

第一列是节点 ID。识别标志中包含 `fail` 或 `disconnected` 的 ID。

### 2. 创建辅助脚本

将以下内容保存为 `forget.sh`：

```bash
#!/bin/sh
ANY_NODE=$1
PASSWORD=$2
FORGET_NODE_ID=$3

redis-cli -h "${ANY_NODE}" -a "${PASSWORD}" cluster nodes \
  | grep -v "${FORGET_NODE_ID}" \
  | awk '{print $2}' \
  | awk -F: '{print $1}' \
  | xargs -I {} redis-cli -h {} -a "${PASSWORD}" cluster forget "${FORGET_NODE_ID}"
```

该脚本：

1. 从一个健康节点列出所有已知节点。
2. 过滤掉我们想要忘记的节点（否则我们会告诉失败的节点忘记自己）。
3. 提取剩余节点的 IP。
4. 向每个节点发送 `CLUSTER FORGET <node-id>`。

使其可执行：

```bash
chmod +x forget.sh
```

### 3. 针对每个失败节点运行一次脚本

对于每个状态为 `fail` 的节点 ID，运行：

```bash
sh forget.sh <healthy-master-ip> <password> <failed-node-id>
```

例如：

```bash
sh forget.sh 10.33.0.49 'mypass' e457476882acfaebcc860466da141a32972eace4
```

`<healthy-master-ip>` 必须是当前 **不** 在 `fail` 状态的主节点的 IP。

### 4. 验证集群

```bash
redis-cli -h <node-ip> -a '<password>' cluster info
```

健康的结果看起来像：

```text
cluster_state:ok
cluster_slots_assigned:16384
cluster_slots_ok:16384
cluster_slots_pfail:0
cluster_slots_fail:0
cluster_known_nodes:6
cluster_size:3
...
```

`cluster_state:ok`、`cluster_slots_assigned:16384` 和 `cluster_known_nodes` 计数与实时拓扑匹配，表明过时条目已在集群中被移除。

## 重要注意事项

### `CLUSTER FORGET` 有 60 秒超时

每个 `CLUSTER FORGET` 将目标节点添加到接收命令的节点的 60 秒黑名单中。如果 gossip 协议在所有对等节点忘记之前重新宣布失败的节点，该条目将在这些对等节点上重新出现。在同一分钟内在所有节点上运行脚本 - 上述辅助工具足够快速，可以在单次执行中完成此操作。

### 不要忘记健康节点

如果您不小心对健康节点 ID 调用 `CLUSTER FORGET`，该节点将暂时与集群视图断开连接（在 60 秒黑名单过期后将重新加入）。在运行脚本之前，始终验证目标节点 ID 是否处于 `fail` 状态。

### 不要忘记健康主节点的从节点

如果失败的节点是仍然健康的分片的主节点，在未先提升从节点的情况下移除它将导致该分片的槽没有主节点。在忘记旧主节点之前，请从存活的从节点使用 `CLUSTER FAILOVER`。

### 当此操作步骤不足时

如果集群中有许多来自 IP 回收的过时条目（例如，使用 Calico CNI），孤立的记录可能并不都是 `fail` 状态，可能需要不同的清理方法。请参见 [清理无效的 Redis 集群节点](./How_to_Cleanup_Invalid_Cluster_Nodes.md)。
