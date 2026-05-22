---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500090
sourceSHA: a22a34ef4cbe3fe4a6838f2ce65ccfebbbe76a58611ccfa23b9edc311ff8cd0a
---

# 如何从集群模式下的跨分片主节点损坏中恢复

## 介绍

本指南描述了如何恢复一个 Redis 集群模式实例，该实例在 Redis 层显示健康状态，但其 pod 到分片的映射变得不一致——通常在平台报告实例状态在密码更新后无限期地停留在“处理中”时观察到。根本原因是来自一个分片的 StatefulSet 的主节点角色被属于 *不同* 分片的 StatefulSet 的 pod 采用，因此操作员无法完成协调。

:::info 适用版本
这是一个低概率缺陷，可能发生在任何集群模式的 Alauda Cache Service for Redis OSS 实例上。下面的操作步骤与模式无关，适用于所有当前的操作员版本。
:::

:::note
本文档使用“主节点”和“从节点”来指代主要的 Redis 节点及其副本，替代之前使用的“主节点”/“从节点”术语。
:::

## 症状

- 在密码更新（或其他触发协调的操作）后，Redis CR 保持在 `Processing` 状态，永远不会返回到 `Healthy`。
- `redis-cli --cluster check` 报告集群健康且槽位完全覆盖。
- `cluster nodes` 报告的一个分片的主节点 IP 属于一个属于 *不同* 分片的 StatefulSet 的 pod。
- 操作员日志没有错误，但没有进展。

## 诊断

1. 从任何数据 pod 检查集群健康：

   ```bash
   redis-cli -a $REDIS_PASSWORD --cluster check 127.0.0.1:6379
   ```

   预期：`[OK] All 16384 slots covered.` 仅集群健康状态并不能排除不对齐的可能性。

2. 列出 pod 及其 IP 和 StatefulSet：

   ```bash
   kubectl -n <namespace> get pods -o wide
   ```

3. 列出 Redis 集群拓扑并检查主节点 IP：

   ```bash
   redis-cli -a $REDIS_PASSWORD CLUSTER NODES
   ```

4. 将步骤 3 中的主节点 IP 与步骤 2 中的 pod 到 StatefulSet 的映射进行交叉检查。如果持有分片 *N* 的主节点角色的 pod 不属于分片 *N* 的 StatefulSet (`drc-<instance>-N-*`)，则集群处于此处描述的不对齐状态。

根本原因怀疑与 pod IP 变化有关；目前无法确定性地重现。操作员重启和 pod 重启不会修复此问题。

## 恢复操作步骤

修复需要对每个受影响的分片进行两个手动步骤：在失去主节点的分片上重新选举正确的主节点，然后将错误的 pod 降级为其自身分片的从节点。

:::warning

- 所有命令必须在 Redis pod 内部或从具有 `redis-cli` 访问集群的工作站上运行。
- 此操作会暂时导致受影响的分片执行受控故障转移。请在维护窗口期间计划此操作。
:::

对于每个受影响的分片：

1. **识别参与者**：
   - 设 `PodA` 为 *当前* 持有主节点角色但属于错误 StatefulSet 的 pod。
   - 设 `PodB` 为一个（任意）在 *应该* 拥有此分片的 StatefulSet 中但当前没有主节点的 pod。
   - 记录 `PodB` 的 Redis 集群节点 ID。您将在下面使用它作为 `<PodBID>`。

     ```bash
     # 在 PodB 上：
     redis-cli -a $REDIS_PASSWORD CLUSTER MYID
     ```

2. **故障转移到 PodB**，以便正确的 StatefulSet 在分片中重新获得主节点：

   ```bash
   # 在 PodB 上：
   redis-cli -a $REDIS_PASSWORD CLUSTER FAILOVER
   ```

   等待 `CLUSTER NODES` 报告 `PodB` 为 `master`。

3. **将 PodA 重新附加为 `PodB` 的从节点**：

   ```bash
   # 在 PodA 上：
   redis-cli -a $REDIS_PASSWORD CLUSTER REPLICATE <PodBID>
   ```

4. 对任何其他不对齐的分片重复上述步骤。

5. 等待操作员进行协调。Redis CR 状态应从 `Processing` 转变为 `Healthy`。

## 重要注意事项

- **在故障转移之前始终执行 `--cluster check`** 以确认槽位覆盖完好。如果槽位缺失，请参见 *如何从 Redis 集群崩溃中恢复* 和 *Redis 紧急响应手册* 中的槽位恢复操作步骤，然后再继续。
- **不要删除 pods 以“强制”恢复**——不对齐的拓扑将在 pod 重启时持续存在，因为 Redis 集群状态保存在每个节点的 `nodes.conf` 中。
- **在恢复之前捕获诊断信息**：保留 `kubectl get pods -o wide`、`redis-cli CLUSTER NODES` 和操作员日志的副本，以便进行事件后分析。根本原因目前尚未确定；收集的证据有助于追踪潜在触发因素。
- **密码轮换**：如果触发因素是挂起的密码轮换，请在集群报告 `Healthy` 后再重试轮换。
