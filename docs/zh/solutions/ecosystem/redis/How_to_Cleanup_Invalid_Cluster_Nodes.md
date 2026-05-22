---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500076
sourceSHA: b42689f79e8da2bb46f7e5d9f7d1e903e2886b95a1d30a3f054352c48af0bc62
---

# 清理无效的 Redis 集群节点

## 介绍

在 pod IP 在重启后发生变化的环境中——特别是在使用不保留 pod IP 的 CNI（如 **Calico**）时，Redis 集群可能会积累孤立的节点条目。每个存活的节点仍然通过节点 ID 和 IP 跟踪集群的先前拓扑，而这些过时的条目并不总是会自动清理。

症状包括：

- Redis pod 内的 `/data/nodes.conf` 文件包含状态为 `fail` 的条目。
- `CLUSTER NODES` 列出状态为 `fail` 的条目，其 IP 不再属于任何当前 pod。

本指南解释如何识别和删除这些孤立条目。

:::note 当前 operator 的自动清理
在 **redis-operator 3.18+** 中，控制器在 pod 重启期间会协调集群成员资格，并自动清理大多数过时条目。下面的手动操作步骤旨在作为 **后备**，用于孤立条目仍然存在的情况（例如，多个同时的 IP 回收或恢复期间的 operator 故障）。在旧版 operator（`<= 3.16`）中，这是常规的恢复路径。
:::

:::tip 相关
要删除已知 IP 和节点 ID 的单个失败节点，请参见 [手动删除失败的 Redis 集群节点](./How_to_Manually_Remove_Failed_Cluster_Nodes.md)。
:::

## 先决条件

1. 对运行 Redis 集群的命名空间具有 `kubectl` 访问权限。
2. Redis 密码。
3. 在 Redis pod 内或从可以访问所有 Redis pod 的主机上具有 `redis-cli` 访问权限。

## 操作步骤

### 1. 识别过时条目

对于 StatefulSet 中的每个 Redis pod，列出集群拓扑：

```bash
kubectl -n <namespace> exec -it <redis-pod> -- \
  redis-cli -a '<password>' cluster nodes
```

构建 **当前** pod IP 的列表：

```bash
kubectl -n <namespace> get pod -l <selector-for-redis> -o wide
```

对 `CLUSTER NODES` 返回的每个条目应用以下决策规则：

| 条目状态                                                              | 操作                                        |
| ------------------------------------------------------------------------ | --------------------------------------------- |
| 状态正常且 IP 属于当前 pod                                              | 保留                                          |
| 状态为 `fail` 或 `pfail`，且 IP **不** 是任何当前 pod 的 IP            | **使用 `CLUSTER FORGET` 删除**              |
| 状态异常但 IP **确实** 匹配当前 pod                                     | 不要忘记。首先调查该 pod。                   |
| 状态为 `disconnected` 且没有记录的 IP                                   | **使用 `CLUSTER FORGET` 删除**              |

### 2. 删除过时条目

对于每个过时条目，在每个健康节点上运行 `CLUSTER FORGET`：

```bash
redis-cli -h <healthy-node-ip> -a '<password>' cluster forget <stale-node-id>
```

`<stale-node-id>` 是要删除的条目在 `CLUSTER NODES` 输出中的第一列。

:::warning 在 60 秒内在所有健康节点上运行
集群节点相互传播其拓扑。如果您只在某些对等节点上忘记一个节点，存活的对等节点将重新宣布它，条目将重新出现。`CLUSTER FORGET` 会将目标列入黑名单 60 秒；您必须在该时间窗口内对所有健康节点执行此操作。
:::

一个简单的 shell 循环可以覆盖这一点。从可以访问所有 pod 的主机上：

```bash
HEALTHY_IPS=(<ip-1> <ip-2> <ip-3> <ip-4> <ip-5>)
STALE_ID=<stale-node-id>
PASSWORD=<password>

for ip in "${HEALTHY_IPS[@]}"; do
  redis-cli -h "$ip" -a "$PASSWORD" cluster forget "$STALE_ID"
done
```

对每个过时节点 ID 重复此操作。

### 3. 验证

清理后，确认集群状态：

```bash
redis-cli -h <node-ip> -a '<password>' cluster info
redis-cli -h <node-ip> -a '<password>' cluster nodes
```

`cluster_state:ok` 和 `cluster_known_nodes` 计数与实际 pod 数量匹配表示清理已完成。每个 pod 内的 `nodes.conf` 文件也不应再引用已删除的 ID。

## 重要考虑事项

### 不要忘记属于活动 pod 的条目

如果异常条目的 IP 匹配当前 pod，正确的解决方法是调查该 pod（CNI 问题、网络分区、复制堆积量），而不是忘记该节点。忘记它会暂时将活动 pod 与集群视图分离。

### 仅适用于健康节点

始终从健康节点的角度调用 `CLUSTER FORGET`。将命令发送到故障节点本身没有任何用处，并可能会混淆集群。

### 为什么 Calico 会出现这种情况

Calico 在 pod 重启时从其池中分配一个新的 IP。之前的 IP 进入 Calico 的回收池，但集群的 gossip 视图仍然引用旧 IP 和旧节点 ID。在条目在整个集群中被忘记之前，它会作为过时的 `fail` 记录存在。

对于这种情况变得常规的环境，考虑使用支持跨 pod 重启保留 IP 的 CNI 插件（例如 Kube-OVN，具有持久 pod IP）。
