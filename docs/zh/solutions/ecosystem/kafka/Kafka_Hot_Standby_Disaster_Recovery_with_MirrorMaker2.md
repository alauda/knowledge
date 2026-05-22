---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500123
sourceSHA: 521cfef3d919e570558d2f30f0f9d3dfab86e39ca06df45661ac62dfdda65e70
---

# Kafka 热备份灾难恢复与 MirrorMaker 2

:::info 适用版本
ACP 3.8 及更高版本。ACP 3.12+ 部署应优先参考 ACP 3.15 部署指南中的更新 KafkaMirrorMaker2 API 示例。
:::

## 介绍

热备份 Kafka 灾难恢复架构使用两个位于不同站点或可用区的 Kafka 集群。源集群处理正常的生产和消费。目标集群接收复制的数据，并可以在故障后使用，或用于具有独立消费者组的只读分析工作负载。

复制由部署在目标集群附近的 Kafka MirrorMaker 2 执行。

## 架构

MirrorMaker 2 创建连接到源集群的消费者和连接到目标集群的生产者。它从选定的源主题读取记录，并将其写入目标集群。

MirrorMaker 2 还使用检查点主题来同步消费者组偏移量。检查点记录包含消费者组、主题、分区、上游偏移量、下游偏移量、元数据和时间戳。

## 限制

Kafka 2.5 及更早版本不会自动将检查点偏移量转换为目标集群的 `__consumer_offsets` 主题。在故障转移后，应用程序可能需要手动转换偏移量，然后才能继续在目标集群上消费。

对于 Java 客户端，Kafka 源代码包括 `RemoteClusterUtils.translateOffsets()` 以实现此目的。非 Java 客户端需要等效的逻辑。

## 基本部署流程

1. 创建源 Kafka 集群。
2. 创建目标 Kafka 集群。
3. 在目标集群命名空间中部署 `KafkaMirrorMaker2`。
4. 验证 MirrorMaker 2 Pod 和自定义资源已准备就绪。
5. 在源集群中创建一个主题。
6. 验证该主题出现在目标集群中。
7. 向源主题生产数据。
8. 验证数据出现在目标主题中。
9. 在宣布 DR 操作步骤准备就绪之前测试消费者组故障转移。

## 示例 MirrorMaker 2 资源

```yaml
apiVersion: kafka.strimzi.io/v1alpha1
kind: KafkaMirrorMaker2
metadata:
  name: my-mm2-cluster
  namespace: <target-namespace>
spec:
  clusters:
    - alias: my-cluster-source
      bootstrapServers: <source-bootstrap>:9092
    - alias: my-cluster-target
      bootstrapServers: target-cluster-kafka-bootstrap:9092
      config:
        config.storage.replication.factor: 1
        offset.storage.replication.factor: 1
        status.storage.replication.factor: 1
  connectCluster: my-cluster-target
  mirrors:
    - sourceCluster: my-cluster-source
      targetCluster: my-cluster-target
      topicsPattern: ".*"
      groupsPattern: ".*"
      checkpointConnector:
        config:
          checkpoints.topic.replication.factor: 1
          emit.checkpoints.interval.seconds: 60
          sync.group.offsets.enabled: "true"
          sync.group.offsets.interval.seconds: 60
          refresh.groups.interval.seconds: 600
          replication.policy.class: "io.strimzi.kafka.connect.mirror.IdentityReplicationPolicy"
      heartbeatConnector:
        config:
          heartbeats.topic.replication.factor: 1
      sourceConnector:
        config:
          offset-syncs.topic.replication.factor: 1
          refresh.topics.interval.seconds: 600
          replication.factor: 2
          sync.topic.acls.enabled: "false"
          replication.policy.class: "io.strimzi.kafka.connect.mirror.IdentityReplicationPolicy"
  replicas: 1
  version: 2.7.0
```

## 故障转移注意事项

- 新主题并不总是立即同步。默认刷新间隔为 10 分钟，可以通过 `refresh.topics.interval.seconds` 进行更改。
- 消费者组偏移量会定期同步。如果源集群在最新偏移检查点被复制之前发生故障，消费者在故障转移后可能会重新处理某些记录。
- 应用程序应容忍在 DR 故障转移期间的重复消费。

## 重要考虑事项

- MirrorMaker 2 的复制是异步的。RPO 取决于复制吞吐量和堆积量。
- 站点之间的网络带宽必须超过正常写入流量，加上复制开销。
- 保持源集群和目标集群的规模、存储容量和主题保留策略一致。
- 故障转移需要手动决策和应用程序连接更改，除非应用程序具有自己的路由层。
