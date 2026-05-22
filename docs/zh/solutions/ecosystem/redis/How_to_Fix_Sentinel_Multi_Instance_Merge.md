---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500083
sourceSHA: bb4339c0bf9e40403408aad832f6893c31a4c0835cd5aed8fd46bc93b57356e0
---

# 如何恢复因 IP 回收而合并的 Sentinel 实例

:::warning 大多数当前操作员的用户可以跳过此文档
如果您正在运行 **redis-operator 3.18+ 且使用 Redis 6.0 或更高版本**（新实例的默认设置），您将 **不受此故障模式的影响**。Redis 6 引入了内置用户身份验证，防止即使在 pod IP 冲突时也发生跨实例身份验证。

仅在以下情况下阅读此文档：（a）您操作 **Redis 4.x/5.x 的遗留实例**，或（b）您因无关原因使用操作员 **<= 3.16**。
:::

## 介绍

本指南解释了如何从一种罕见但具有破坏性的故障模式中恢复，该模式下两个独立的 Redis Sentinel 模式实例在 pod 重启导致 IP 地址在实例间回收后合并为一个集群。一个实例的 Replica 节点附加到另一个实例，而两个实例的 Sentinel 法定人数看到所有六个数据节点，产生一个单一的 4-replica / 6-Sentinel "超级集群"。

:::info 适用版本

- redis-operator `<= 3.14`（所有 Redis 版本）
- redis-operator `>= 3.16` 运行 Redis `4.x` 或 `5.x`

Redis 6.0 及更高版本——包括在操作员 3.18+ 上创建的所有实例——均免疫。
:::

:::note
本文档使用 "Primary" 和 "Replica" 来指代主要 Redis 节点及其副本，取代之前使用的 "Master"/"Slave" 术语。
:::

## 背景

Redis Sentinel 和集群模式使用 IP（而非 DNS）来发现和形成其法定人数。这避免了对 DNS 的依赖，但使系统暴露于 IP 回收的风险中。合并序列如下：

1. 在 pod 重启后，实例的数据 pod 被分配一个之前属于 *不同* Redis 实例的 IP。
2. 新的 pod 启动并发现其现在可以访问的集群所宣传的 Primary，然后在该集群中注册自己为 Replica。
3. 与此同时，原始实例的 Sentinel pods 不断探测丢失的 IP。当该 IP 再次可达时，Sentinel 将其重新附加为 Replica——但该 IP 现在属于另一个实例的 pod。
4. 一旦操作员的协调尝试修复多主状态，两个实例将合并为一个单一的合并集群。

需要满足两个前提条件：

- **两个实例上的密码相同**。身份验证在实例边界之间成功。
- **一个回收 pod IP 的网络插件**。这在基于 Calico 的环境中最为常见；Kube-OVN 使用稳定的 IP 在很大程度上避免了此问题。

## 恢复操作步骤

恢复操作步骤因操作员版本而异。在继续之前，请识别您的操作员版本。

:::warning
恢复将删除冗余的 Replica，并可能丢失仅存在于一个实例的 Replica 上的数据。在运行操作步骤之前，请确定哪个数据副本是权威的。
:::

### 在 redis-operator 3.12 和 3.14 上恢复

1. **停止 redis-operator**，以便在修复集群时不会不断重新应用合并的拓扑。

2. **删除受影响实例的 Sentinel pods**。Sentinel pods 的名称以 `rfs-` 前缀命名：

   ```bash
   kubectl -n <namespace> delete pod -l app.kubernetes.io/component=sentinel,redissentinels.databases.spotahome.com/name=<instance-name>
   ```

3. **检查每个数据 pod 的角色**。数据 pods 的名称以 `rfr-` 前缀命名：

   ```bash
   kubectl -n <namespace> exec -it <rfr-pod> -- redis-cli -a <password> ROLE
   ```

4. **提升正确的 Primary**。在每个报告为 `slave` 的 pod 上运行：

   ```bash
   redis-cli -a <password> SLAVEOF NO ONE
   ```

   :::warning
   只有一个数据副本应保持权威。请在运行 `SLAVEOF NO ONE` 之前与应用程序所有者确认哪个 Replica 持有正确的数据。
   :::

5. **重启 redis-operator**。操作员将自动重建 Sentinel 法定人数和 Primary/Replica 拓扑。

6. **一旦实例健康，至少在一个受影响的实例上更改密码**，以便两个实例不再共享凭据。这可以防止再次发生：

   ```bash
   kubectl -n <namespace> create secret generic <new-password-secret> \
     --from-literal=password=<new-password>
   ```

   然后更新 Redis CR 中的 `spec.passwordSecret` 以引用新的 Secret。

### 在 redis-operator 3.16 及更高版本（使用 Redis 4 或 5）的行为

从 3.16 开始，操作员包含后事件协调逻辑，自动打破合并集群。**然而，恢复是破坏性的——仅存在于合并侧的数据可能会丢失。** 为避免问题，请在每个实例上设置不同的密码。

## 重要考虑事项

- **缓解，而非预防 Redis 4 / 5**：在 Redis 4.x / 5.x 上唯一可靠的预防措施是确保同一网络中的两个 Sentinel 模式实例不共享相同的密码。
- **升级路径**：如果可行，将受影响的实例升级到 Redis 6.0 或更高版本。Redis 6 具有内置用户，因此即使在 IP 冲突时也会拒绝跨实例身份验证。
- **网络插件**：如果您在 Calico 上大规模操作，请计划每个实例的密码隔离。Kube-OVN 使用持久化 pod IP 减少但并未完全消除风险。
- **检测**：监控 `redis_connected_slaves` 是否大于配置的 Replica 数量，并在 Sentinel pods 发现的 Primary 数量超过操作员声明的数量时发出告警。
