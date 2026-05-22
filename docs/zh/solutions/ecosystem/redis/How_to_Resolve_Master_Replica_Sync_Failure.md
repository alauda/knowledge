---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500075
sourceSHA: 800ce7d3a03537dfbdcb65959b0a6e2bd17b73670b31f54471daff19567fbe59
---

# 解决主从同步失败

:::info 适用范围
Redis 实例在 **哨兵模式** 和 **集群模式** 下。
:::

## 介绍

Redis 复制依赖于主节点和从节点之间的两个缓冲区：

- **复制回溯** (`repl-backlog-size`) - 由主节点上的所有客户端共享，默认值为 `1mb`。用于部分重新同步。
- **客户端输出缓冲区** (`client-output-buffer-limit`) - 每个连接的，包括从节点连接。默认的 `slave` 设置为 `256mb 64mb 60`：硬限制为 256 MiB，软限制为 64 MiB，持续 60 秒后关闭连接。

当任一缓冲区溢出时，从节点将断开连接并被迫进行完全重新同步，这会产生明显的错误和复制延迟。

:::note redis-operator >= 3.14
从 redis-operator **3.14** 开始，`repl-backlog-size` 由操作员使用公式 `maxmemory * 0.01` 自动计算。在旧版本中，您必须手动设置它。
:::

## 前提条件

1. 对运行 Redis 实例的命名空间具有 `kubectl` 访问权限。
2. 有权限更新 Redis CR（或持有 Redis 配置的底层 ConfigMap）。
3. 意识到在运行实例上更改 `client-output-buffer-limit` 将重置打开的从节点连接。

## 识别症状

### 在从节点上

从节点日志报告：

```text
I/O error reading bulk count from MASTER: Resource temporarily unavailable
```

### 在主节点上

主节点日志报告：

```text
... scheduled to be closed ASAP for overcoming of output buffer limits.
```

任一消息都表明主节点上的从节点客户端输出缓冲区已溢出。

## 诊断：为什么缓冲区会溢出

| 原因                   | 如何识别                                                                                                                                                                                                     | 解决方案                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 客户端写入过快  | 主节点 CPU 在正常负载下保持在 ~90%                                                                                                                                                                         | 提高缓冲区有助于短期解决，但增加实例大小或添加分片是持久的解决方案。 |
| 从节点写入过慢 | 从节点日志显示在完全同步期间 RDB 加载持续时间过长（例如 2 GB 需要 ~3 分钟）。完全同步受限于磁盘。                                                                                       | 切换到 `diskless` 参数模板以减少从节点的磁盘 I/O。                                    |
| 大键                | 主节点的 RDB 持久化日志显示持久化由非常少的键更新触发（远低于 ~20k）；CPU 没有饱和，写入也不重。单个大值可以瞬间饱和缓冲区。 | 增加缓冲区；在应用层识别并拆分大键。                                 |

## 操作步骤

### 1. （仅适用于 redis-operator < 3.14）设置复制回溯大小

对于旧版操作员，显式设置 `repl-backlog-size`。大约使用 `maxmemory * 0.01`：

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>
  namespace: <namespace>
spec:
  customConfig:
    repl-backlog-size: "100mb"   # 示例：对于 10 GiB 实例
```

对于 redis-operator **>= 3.14**，此值会自动计算，无需设置。

### 2. 增加从节点客户端输出缓冲区

`slave` 类的默认值为 `256mb 64mb 60`。仅调整 **slave 部分**，保持 `normal` 和 `pubsub` 为默认值。合理的第一步是将限制加倍：

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>
  namespace: <namespace>
spec:
  customConfig:
    client-output-buffer-limit: "normal 0 0 0 slave 516mb 256mb 60 pubsub 33554432 8388608 60"
```

应用更改并观察主节点的日志。如果 `out output buffer limit` 错误仍然存在，请 **再次将从节点的硬限制和软限制加倍** 并观察。

### 3. 验证

检查主节点上的 `INFO replication`：

```bash
kubectl -n <namespace> exec -it <primary-pod> -- \
  redis-cli -a '<password>' info replication
```

健康的从节点条目显示 `state=online` 和 `lag=0`（或单数字秒）。主节点或从节点日志中不应再出现错误。

## 重要考虑事项

### 缓冲区是每个连接的

`client-output-buffer-limit slave` 独立适用于 **每个** 从节点的连接。主节点上的内存预算随着从节点数量的增加而增加，因此非常大的限制与多个从节点结合可能会对主节点的内存造成压力。

### 大键是真正的解决方案

单个多兆字节值（长列表、哈希或集合）可以在一个命令中填满缓冲区。提高缓冲区只是推迟了症状。使用 `redis-cli --bigkeys` 或 `MEMORY USAGE` 查找问题键，然后在应用程序中重新建模数据（拆分键、减少元素数量）。

### 对于慢速从节点的无磁盘复制

如果瓶颈是在完全同步期间从节点的磁盘，请将操作员的参数模板切换为 **diskless**。主节点直接将 RDB 流式传输到从节点的内存，而不是在两侧写入和读取磁盘。

### 重新同步是破坏性的

每当缓冲区溢出时，下一次重新同步可能是完全同步（而不是部分同步）。完全同步会激增主节点和从节点的资源使用；设置缓冲区以确保在瞬时减速期间 **部分** 重新同步仍然是常态。
