---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500077
sourceSHA: f4ca14d7fa3a7bc9e7e79add58cb81bd1612cdbeb6dade299fdf66b6af343621
---

# Redis 应急响应手册

## 介绍

本手册收集了在 Kubernetes 上运行的 Alauda Cache Service for Redis OSS 部署中最常见的应急响应操作步骤。它旨在为需要快速、确定性步骤的值班工程师和平台操作员提供指导，以应对 Redis 实例、redis-operator 或集群模式拓扑处于降级状态的情况。

:::info 适用版本
所有当前支持的 Alauda Cache Service for Redis OSS 版本。
:::

:::note
本文档使用“Primary”和“Replica”来指代主 Redis 节点及其副本，取代之前使用的“Master”/“Slave”术语。
:::

手册涵盖了四种场景：

1. redis-operator 部署失败
2. Redis 实例部署失败
3. 集群模式缺少槽
4. 手动从集群模式拓扑中移除过期节点

有关更深入的恢复操作步骤，请参阅：

- *如何从 Redis 集群崩溃中恢复*（重置无法访问的 Replica）
- *如何从集群模式中的跨分片主节点损坏中恢复*
- *如何恢复因 IP 回收而合并的 Sentinel 实例*

## 架构概述

在触发恢复操作之前，了解部署拓扑至关重要。Sentinel 模式和集群模式均在 Kubernetes 上使用以下模式进行部署。

### Sentinel 架构

- **数据节点** (`rfr-<instance>-*`) 作为 `StatefulSet` 运行，以提供稳定的身份和存储。
- **Sentinel pods** (`rfs-<instance>-*`) 作为 `Deployment` 运行，因为它们是无状态的，并且受益于滚动更新。
- **反亲和性** 规则将数据和 Sentinel pods 调度到不同的节点上。
- **持久存储** 由 `PersistentVolume` / `PersistentVolumeClaim` 提供给数据节点。
- **配置和凭据** 存储在 `Secret` 和 `ConfigMap` 中。

### 集群架构

- **数据节点** 作为多个 `StatefulSets` 部署，每个分片一个。槽由 operator 在主节点之间分配。
- 每个分片的主节点与一个或多个副本通过反亲和性配对，因此单个节点故障不会导致分片失效。
- 为每个实例暴露一个 `Service` 以提供稳定的客户端端点。

## 操作步骤

### 场景 1：redis-operator 部署失败

**症状**：redis-operator 保持在 `Unknown` 或 `Pending` 状态，永远不会变为 `Running`。后续的 Redis CR 无法被协调。

**恢复**：

1. 删除 redis-operator 部署 / CSV：
   ```bash
   kubectl -n <operator-namespace> delete csv <redis-operator-csv>
   ```
2. 确认没有来自之前安装的残留资源：
   ```bash
   kubectl -n <operator-namespace> get csv,subscription,installplan | grep -i redis
   ```
   在继续之前，移除任何过期条目。
3. 重启 OLM 目录操作员，以便重新评估操作员目录：
   ```bash
   kubectl delete pods -n cpaas-system -l app=catalog-operator
   ```
4. 从目录中重新安装 redis-operator。

如果操作员仍然无法启动，请检查 catalog-operator 日志和集群的命名空间配额、镜像拉取凭据以及 CRD 安装状态（`kubectl get crd | grep -i redis`）。

### 场景 2：Redis 实例部署失败

**症状**：已创建 Redis CR，但保持在 `Processing` 状态，或者其 pods 保持在 `Pending`/`CrashLoopBackOff` 状态。

**恢复**：

1. 检查数据节点 pod 日志：
   ```bash
   kubectl -n <namespace> logs <pod-name> -c redis
   ```

2. 检查 pod 事件：
   ```bash
   kubectl -n <namespace> describe pod <pod-name>
   ```

3. 常见原因及解决方法：

   | 症状                                            | 可能原因                                       | 解决方法                                                                                                     |
   | -------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
   | `0/N nodes available: ... insufficient cpu/memory` | 集群容量不足                      | 扩展集群或减少实例资源请求。                                                    |
   | `pod has unbound immediate PersistentVolumeClaims` | StorageClass 缺失或 PV 未配置         | 验证 `StorageClass` 和提供者。对于 HostPath 设置，请参见 *使用 HostPath 创建 Redis 实例*。 |
   | `failed to pull image`                             | 注册表凭据缺失或镜像未镜像 | 配置 imagePullSecret；对于隔离环境，将镜像镜像到集群内注册表中。      |
   | 重复 `LOADING Redis is loading the dataset`   | 冷启动时大型 RDB                            | 等待加载完成；在加载过程中不要删除 pod。                                                 |

4. 如果操作员日志显示提及 Sentinel 或集群拓扑的协调错误，请参考相应模式的解决文档。

### 场景 3：Redis 集群槽缺失

**症状**：`redis-cli --cluster check` 报告 `Not all 16384 slots are covered by nodes`。客户端收到 `CLUSTERDOWN` 错误。

**恢复**：

1. 从任何数据 pod 中识别缺失的槽和故障的分片：

   ```bash
   redis-cli -a $REDIS_PASSWORD --cluster check 127.0.0.1:6379
   ```

   输出将突出显示未覆盖的槽范围。

2. 在故障 pod 上打开一个 shell（失去槽范围的主节点）：

   ```bash
   kubectl -n <namespace> exec -it <pod-name> -- bash
   ```

3. 找到故障节点的 IP 和健康副本的集群节点 ID。从健康的 pod 中：

   ```bash
   redis-cli -a $REDIS_PASSWORD --cluster check 127.0.0.1:6379
   ```

4. 从故障主节点中移除被遗弃的槽映射：

   ```bash
   redis-cli -a $REDIS_PASSWORD -h <failing-primary-ip> CLUSTER DELSLOTS <slot-id>
   ```

   如果缺失多个槽，请重复或传递一个范围——例如在 shell 中使用小循环。

5. 将槽分配给应拥有它的副本（在可以访问受影响副本的节点上运行）：

   ```bash
   redis-cli -a $REDIS_PASSWORD --cluster call 127.0.0.1:6379 \
     CLUSTER SETSLOT <slot-id> NODE <replica-node-id>
   ```

6. 提升该副本以接管分片：

   ```bash
   # 在步骤 5 中针对的副本上运行：
   redis-cli -a $REDIS_PASSWORD CLUSTER FAILOVER TAKEOVER
   ```

7. 重新运行 `--cluster check`。所有 16384 槽现在应该都被覆盖。

:::warning
`CLUSTER FAILOVER TAKEOVER` 是一种强制操作，绕过了通常的多数要求。仅在确认原主节点无法恢复后使用；否则，建议使用常规的 `CLUSTER FAILOVER` 以避免历史分歧。
:::

### 场景 4：手动从集群中移除故障节点

**症状**：一个 pod 已被永久销毁或重建，但其节点 ID 仍在 `CLUSTER NODES` 中显示为 `fail` 或 `disconnected`。操作员尚未修剪它。

**恢复**：

1. 列出集群节点并识别过期条目：

   ```bash
   redis-cli -a $REDIS_PASSWORD CLUSTER NODES
   ```

2. 从第一列捕获故障节点的 `<node-id>`。

3. 从每个节点的集群视图中移除该节点。从任何数据 pod 运行：

   ```bash
   redis-cli -a $REDIS_PASSWORD --cluster call 127.0.0.1:6379 CLUSTER FORGET <node-id>
   ```

   `--cluster call` 将命令传播到集群中的每个节点；这是必需的，因为 `CLUSTER FORGET` 是每个节点本地的。

4. 从任何 pod 重新运行 `CLUSTER NODES`。被遗忘的节点应在 60 秒内消失（传播超时）。

:::warning

- `CLUSTER FORGET` 仅忘记条目；它并不会 **删除** 基础 pod。在运行此命令之前，请验证 pod 确实已消失，否则 gossip 协议将重新发现该节点。
- 不要 `FORGET` 仍然拥有槽的节点。首先使用场景 3 中的操作步骤重新分配其槽。
  :::

## 重要考虑事项

- **在破坏性恢复之前始终捕获诊断信息**：`kubectl get pods -o wide`、`kubectl describe pod`、`redis-cli CLUSTER NODES`、`redis-cli INFO replication` 和操作员日志。许多这些操作步骤在成功后会丢失关于先前错误状态的信息。
- **仅在受影响的 pod 上运行破坏性命令**。`CLUSTER RESET`、`FLUSHALL`、`SLAVEOF NO ONE` 和 `CLUSTER FAILOVER TAKEOVER` 是强大的且不可逆的。
- **在重试之前恢复秩序**：成功恢复后，等待操作员将 Redis CR 标记为 `Healthy`，再进行密码轮换或备份等进一步操作。
- **隔离环境**：上述所有命令均为集群本地命令，不需要外部连接。redis-operator 容器镜像和 Redis 镜像必须已经在集群内注册表中可用。
- **遇到问题时升级**：如果在这些操作步骤后集群仍然不健康，请收集上述诊断信息并联系支持产品团队。不要循环执行破坏性命令，希望获得不同的结果。
