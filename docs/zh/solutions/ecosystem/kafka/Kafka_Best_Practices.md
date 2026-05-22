---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500120
sourceSHA: a38a179f39a82f530afe6f7375c97084c913f5e7d6d8c2619f471e72017cca3c
---

# Kafka 最佳实践

:::info 适用版本
ACP 3.14.x 和 3.15.x。大多数架构指导同样适用于后续的 Kafka operator 版本，但请根据您集群中安装的 operator 版本验证确切的资源默认值。
:::

## 介绍

Kafka 是一个分布式流处理平台，用于高吞吐量事件摄取、消息缓冲、数据管道和流处理。在 Kubernetes 上，Alauda Application Services 通过 Kafka operator 堆栈管理 Kafka：一个面向 RDS 的 operator、Strimzi 集群 operator、实体 operator 和 Kafka 导出器。

在规划生产 Kafka 实例或审查现有部署时，请使用本指南。

## 核心术语

| 术语           | 描述                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| Broker         | 一个 Kafka 服务器进程。一个集群包含多个 brokers。                                       |
| Topic          | 一条逻辑记录流。生产者写入主题，消费者从主题读取。                                     |
| Partition      | 主题的存储和并行性单位。每个主题有一个或多个分区。                                     |
| Producer       | 一个将记录写入主题的客户端。                                                           |
| Consumer       | 一个从主题读取记录的客户端。                                                           |
| Consumer group | 一组共享主题分区以进行负载均衡的消费者。                                               |
| Offset         | 分区中单调递增的记录位置。                                                             |
| Lag            | 最新分区偏移量与消费者组已消费偏移量之间的距离。                                       |
| Leader         | 处理分区读写的 broker 副本。                                                            |
| Follower       | 从 leader 复制数据的副本，并在故障后可以接管。                                         |

## Operator 组件

| 组件               | 职责                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `rds-operator`     | 处理产品层配置、UI 集成和 RDS 自定义资源。                                                                    |
| `cluster-operator` | 从生成的 Kafka 资源创建、更新和删除 Kafka 集群。                                                            |
| `entity-operator`  | 包含用于管理 Kafka 主题和用户的主题和用户 operator。每个 Kafka 实例都有自己的实体 operator。                   |
| `kafka-exporter`   | 连接到 brokers 并暴露 Kafka 指标以供监控。                                                                  |

## 资源规划

### CPU

Kafka 通常是 I/O 密集型而非 CPU 密集型。CPU 主要用于压缩、解压缩、TLS、请求处理以及生产者、消费者和分区之间的高扇出。当 brokers 服务多个主题和客户端时，优先选择更多核心而非更高的单核频率。

根据 CPU 规格和基准测试结果调整这些 broker 参数：

```properties
num.network.threads=<network-thread-count>
num.io.threads=<io-thread-count>
```

### 内存

Kafka 在很大程度上依赖于操作系统页面缓存。如果消费者命中页面缓存，读取将避免磁盘 I/O，吞吐量将提高。除非节点容量已保留并经过验证，否则避免将 Kafka brokers 与内存密集型工作负载共置。

对于 JVM 堆，常见的起始点是大型 brokers 的 6-8 GiB。保持足够的内存在堆外用于页面缓存：

```yaml
spec:
  kafka:
    jvmOptions:
      -Xms: 6g
      -Xmx: 8g
```

### 磁盘

为 Kafka 数据使用专用磁盘。生产 brokers 不要与节点系统磁盘或 ZooKeeper 存储共享相同的磁盘路径。

优先选择 SSD 存储以获得更好的延迟和 IOPS。根据消息量、平均消息大小、副本数量、保留期和压缩比来确定磁盘容量。例如，每天 10 亿条消息，平均消息大小 1 KiB，2 个副本和 7 天的保留期大约需要 14 TiB 的容量，尚未考虑操作余量。

### 网络

网络带宽通常是吞吐量的瓶颈。规划峰值生产者和消费者流量、节点间复制、MirrorMaker 2 复制以及客户端扇出。

有用的 broker 级参数包括：

```properties
socket.send.buffer.bytes=<bytes>
socket.receive.buffer.bytes=<bytes>
socket.request.max.bytes=<bytes>
```

当网络带宽是限制因素时，启用生产者压缩。Kafka 支持 `gzip`、`snappy`、`lz4` 和 `zstd` 等编解码器。压缩节省带宽，但会增加 CPU 使用率。

## Operator 部署模式

| 模式                  | 描述                                           | 推荐使用                                                                                     | 约束                                              |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 集群模式              | 一个 operator 管理所有命名空间中的实例。     | 资源受限的集群或集中操作。保持管理实例数量适中。                                          | Operator 必须在平台默认命名空间中运行。          |
| 多命名空间模式      | 一个 operator 管理一组选定的命名空间。       | 中等隔离，降低 operator 开销。                                                              | 不要在同一命名空间中部署另一个 operator。       |
| 单命名空间模式      | 一个 operator 仅管理其自己的命名空间。      | 租户或工作负载之间的强隔离。                                                                | 更高的 operator 开销。                             |

## 创建实例

在数据服务视图中，选择 **Kafka**，选择项目和命名空间，然后创建 Kafka 实例。对于 3.x 部署，除非您的应用程序需要特定版本，否则使用 operator 支持的最新 Kafka 版本。

### 参考资源大小

| 组件           | 小型生产起始点                          |
| -------------- | -------------------------------------- |
| Kafka broker   | 2 vCPU / 4 GiB, 3 个副本               |
| ZooKeeper      | 1 vCPU / 2 GiB, 3 个副本               |
| Kafka exporter | 300m CPU / 128 MiB                     |
| Topic operator | 500m CPU / 500 MiB 或更多用于多个主题 |
| User operator  | 500m CPU / 500 MiB 或更多用于多个用户 |

对于更重的工作负载，使用类似生产的生产者和消费者进行基准测试，然后一起扩展 brokers、分区和磁盘。

### 重要参数

| 参数                                      | 推荐默认值                                      | 原因                                                                                                            |
| ------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `auto.create.topics.enable`                | `false`                                          | 明确创建主题，以便控制分区数量、副本数量和保留。                                                               |
| `auto.leader.rebalance.enable`             | `false`                                          | 避免在生产中意外的 leader 移动。需要时在计划维护后手动重新平衡领导者。                                         |
| `log.message.format.version`               | 与客户端在升级期间使用的 Kafka 版本匹配。      | 防止线格式兼容性意外。                                                                                          |
| `offsets.topic.replication.factor`         | `3`                                              | 保持内部消费者偏移量的高度可用性。                                                                              |
| `transaction.state.log.replication.factor` | `3`                                              | 可靠事务工作负载所需。                                                                                          |
| `transaction.state.log.min.isr`            | `2`                                              | 当副本太少时，防止确认的事务写入。                                                                              |

## 调度

为 Kafka 和 ZooKeeper pod 启用 pod 反亲和性，以便副本分布在不同节点上。一个三 broker 的 Kafka 集群和一个三节点的 ZooKeeper 集群至少需要三个可调度节点以实现强反亲和性。

强反亲和性提高了可用性，但在节点稀缺时可能会阻止调度。仅在集群没有足够的专用节点且可用性权衡可接受时使用软反亲和性。

## 应用访问

| 场景                                          | 推荐访问模式                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| 应用程序在同一 Kubernetes 集群中运行         | 使用内部引导服务，例如 `<cluster>-kafka-bootstrap:9092`。                    |
| 应用程序在 Kubernetes 集群外部运行           | 根据环境使用 `NodePort` 或 `LoadBalancer` 外部监听器。                        |
| 应用程序需要经过身份验证的访问               | 在监听器上启用 SCRAM-SHA-512，并创建 `KafkaUser` 或 `RdsKafkaUser` 资源。 |

对于具有外部访问的 Kafka 集群，每个 broker 在元数据发现后必须保持单独可被客户端访问。除非使用 Kafka 感知代理或支持的负载均衡器配置，否则不要仅暴露一个 broker 端点。

## 操作

- 监控 broker 可用性、未复制分区、ISR 变化、磁盘使用、请求延迟、消费者堆积量和控制器数量。
- 保持 broker 数据磁盘低于操作阈值。在保留或磁盘压力影响可用性之前发出告警。
- 在扩展 brokers 时重新评估分区数量。仅添加 brokers 不会自动移动现有分区副本。
- 使用显式主题配置来设置保留、段大小、分区数量和副本数量。
- 避免在自定义资源名称中使用下划线。Kubernetes 资源名称必须满足 RFC 1123 命名规则。

## 重要考虑事项

- Kafka 吞吐量受限于磁盘、网络、CPU 和客户端配置中最慢的部分。在确定大小数字之前进行基准测试。
- 保持 ZooKeeper 存储和 Kafka broker 存储分开。
- 为页面缓存规划内存，而不仅仅是 JVM 堆。
- 当有足够的节点可用时，对生产集群使用强反亲和性。
- 明确创建主题，而不是依赖于自动创建。
- 在每次平台或 operator 升级后检查 operator 默认值。
