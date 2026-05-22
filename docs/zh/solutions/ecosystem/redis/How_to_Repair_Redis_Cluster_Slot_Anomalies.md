---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500078
sourceSHA: 93afa44760862ef1bdaab72629fa72e7ce7addae2f805b44623b1a6a80414d0d
---

# 修复 Redis 集群槽异常

## 介绍

Redis 集群将其键空间分配到 **16384 个槽**。当集群报告 `cluster_state:fail` 或当 `redis-cli --cluster check` 标记缺失或错误分配的槽时，集群无法为受影响的键范围提供服务。本指南涵盖两种常见的修复场景：

1. 主节点丢失了一段连续的槽。
2. 槽错误地分配给了从节点。

:::note 术语
本文档使用 **主节点** 和 **从节点** 来代替以前称为主节点和从节点的 Redis 角色。Redis CLI 子命令（`CLUSTER ADDSLOTS`、`CLUSTER DELSLOTS`、`CLUSTER FAILOVER`）保持其原始名称。
:::

## 先决条件

1. 对运行 Redis 集群实例的命名空间具有 `kubectl` 访问权限。
2. Redis 密码（在下面称为 `<password>`）。它通常存储在 `<instance-name>-default-credentials` Secret 中。
3. Pod 内部有一个可用的 `redis-cli`（平台镜像中捆绑了它）。

## 操作步骤

### 场景 1：主节点丢失槽

#### 1. 检查集群

进入任意 Redis Pod 并运行集群检查：

```bash
kubectl -n <namespace> exec -it <redis-pod> -- \
  redis-cli -a '<password>' --cluster check 127.0.0.1:6379
```

输出将列出每个主节点的槽分配。如果某个主节点报告的槽数为零或少于预期，则需要重新添加缺失的范围。对于一个 3 分片的集群，典型的默认范围为：

| 分片 | 槽         |
| ---- | ---------- |
| 0    | 0-5461     |
| 1    | 5462-10922 |
| 2    | 10923-16383|

#### 2. 在主节点上重新添加缺失的槽

进入 **受影响的主节点** 的 Pod 并添加每个缺失的槽。对于缺失范围 `0-5460`：

```bash
for i in $(seq 0 5460); do
  redis-cli -a '<password>' -h 127.0.0.1 -p 6379 cluster addslots $i
done
```

根据您的环境调整范围。`CLUSTER ADDSLOTS` 仅在槽当前未在集群中分配时成功；如果某个槽被其他节点占用，请先使用 `CLUSTER DELSLOTS` 在那里释放它。

#### 3. 验证

重新运行集群检查：

```bash
redis-cli -a '<password>' --cluster check 127.0.0.1:6379
```

槽计数现在应总计为 16384，`cluster_state` 应为 `ok`。

### 场景 2：从节点错误地分配槽

在健康的集群中，只有主节点拥有槽。如果 `--cluster check` 显示从节点拥有一个或多个槽，而其主节点缺失这些槽，则分配是损坏的，需要恢复。

#### 1. 确认集群状态

```bash
redis-cli -h <node-ip> -p <port> -a '<password>' cluster info
redis-cli -a '<password>' --cluster check 127.0.0.1:6379
```

识别由从节点拥有的槽及其所属的主节点。

#### 2. 将槽移回主节点

进入受影响分片的 **主节点** Pod 并删除过时的槽所有权：

```bash
redis-cli -a '<password>' -h 127.0.0.1 -p 6379 CLUSTER DELSLOTS <slot>
```

然后进入当前拥有该槽的 **从节点** Pod 并在那里也删除它：

```bash
redis-cli -a '<password>' -h 127.0.0.1 -p 6379 CLUSTER DELSLOTS <slot>
```

该槽现在未分配。将其重新添加到主节点：

```bash
# 在主节点 Pod 上
redis-cli -a '<password>' -h 127.0.0.1 -p 6379 CLUSTER ADDSLOTS <slot>
```

#### 3. （如有需要）触发受控故障转移

如果由于错误的分配导致集群拓扑漂移，您可以请求从节点接管其主节点的角色，使用手动故障转移。从 **从节点** Pod：

```bash
redis-cli -a '<password>' -h 127.0.0.1 -p 6379 CLUSTER FAILOVER
```

仅在主节点不可达时使用 `CLUSTER FAILOVER FORCE` - 它会绕过复制检查，可能会丢失正在进行的写入。

#### 4. 验证

```bash
redis-cli -a '<password>' --cluster check 127.0.0.1:6379
redis-cli -a '<password>' cluster info
```

`cluster_state:ok` 和 `cluster_slots_assigned:16384` 确认集群健康。

## 重要注意事项

### 槽所有权是集群范围的

`CLUSTER ADDSLOTS` 和 `CLUSTER DELSLOTS` 在本地节点的视图上操作，但会传播给同伴。运行它们后，允许几秒钟让集群收敛，然后再重新检查。

### 不要重新分配持有实时数据的槽

`CLUSTER DELSLOTS` 不会迁移那些槽中存在的键。如果在您即将删除的槽中存在键，它们将变得不可访问。首先使用 `CLUSTER COUNT-KEYS-IN-SLOT <slot>` 确认槽是空的，或者在更改所有权之前使用 `redis-cli --cluster reshard` 迁移键。

### 始终从主节点修复

在应拥有槽的主节点上运行 `ADDSLOTS`，而不是在从节点上。从节点从其主节点继承槽所有权；在从节点上手动添加槽正是导致场景 2 的原因。

### 当修复不足时

如果集群丢失了太多状态，以至于 `--cluster check` 报告许多重叠的槽所有者，请优先使用：

```bash
redis-cli -a '<password>' --cluster fix 127.0.0.1:6379
```

这将引导集群进行修复，包括键迁移。仅在其他健康集群上进行外科修复时使用手动的 `ADDSLOTS` / `DELSLOTS` 工作流。
