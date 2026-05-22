---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500109
sourceSHA: 5a015508e2221c4045ad7427a1eae89531bd2cd917db3b3bcac8052e80bfcaec
---

# Kafka 灾难恢复部署指南 for ACP 3.15

:::info 适用版本
ACP 3.12 及更高版本；已验证 ACP 3.15。
:::

## 介绍

本指南描述了基于 MirrorMaker 2 的 Kafka 热备灾难恢复解决方案的部署方面。源集群用于正常的生产和消费。目标集群接收复制的数据，并可以在故障转移后或由单独的只读工作负载使用。

该解决方案针对同城双站点部署，带宽和延迟可以得到控制。

## 灾难恢复特性

| 项目                 | 值                                         |
| -------------------- | ------------------------------------------- |
| 灾难恢复级别         | 级别 5 灾难恢复模式                        |
| 复制引擎             | MirrorMaker 2                               |
| 同步模式             | 准实时异步复制                             |
| RTO                  | 分钟，取决于手动故障转移速度               |
| RPO                  | 当复制规模正确时为秒                       |

## 风险和限制

- 由于复制是异步的，可能会发生数据丢失。
- 由于消费者组偏移量是定期同步的，可能会发生重复消费。
- 带宽不足或高延迟会增加复制堆积量。
- 故障转移需要手动判断和连接切换。
- MirrorMaker 2 消耗 CPU、内存和网络带宽。应与应用消费者分开进行规模配置。

## 关键 MirrorMaker 2 参数

| 参数                                                          | 描述                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| `checkpointConnector.config.sync.group.offsets.enabled`      | 启用消费者组偏移量同步。                                  |
| `checkpointConnector.config.sync.group.offsets.interval.seconds` | 消费者组偏移量同步间隔。默认值为 60 秒。                   |
| `checkpointConnector.config.refresh.groups.interval.seconds`   | 新消费者组发现间隔。默认值为 10 分钟。                     |
| `sourceConnector.config.refresh.topics.interval.seconds`       | 新主题发现间隔。默认值为 10 分钟。                         |
| `sourceConnector.config.replication.factor`                    | 目标集群上复制主题的从节点数量。                          |
| `topicsPattern`                                              | 要复制的主题名称模式。                                    |

## 先决条件

- 源和目标业务集群已升级到 ACP 3.12 或更高版本。
- 源和目标 Kafka 实例使用相似的资源、存储和参数配置。
- 两个站点之间的网络带宽高于源写入流量。
- 目标存储容量和性能与源集群匹配。
- 如果需要监控 MirrorMaker 2，则已部署 Prometheus。

## 无身份验证部署

在目标 Kafka 命名空间中创建 MirrorMaker 2 指标 `ConfigMap` 和 `KafkaMirrorMaker2` 资源。

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaMirrorMaker2
metadata:
  name: my-mm2-cluster
  namespace: <target-namespace>
spec:
  resources:
    limits:
      cpu: "1"
      memory: 2Gi
    requests:
      cpu: "1"
      memory: 2Gi
  jvmOptions:
    -Xms: 1g
    -Xmx: 1g
  clusters:
    - alias: my-cluster-source
      bootstrapServers: <source-cluster-bootstrap>:9092
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
          emit.checkpoints.interval.seconds: 60
          checkpoints.topic.replication.factor: 1
          sync.group.offsets.enabled: "true"
          sync.group.offsets.interval.seconds: 60
          refresh.groups.interval.seconds: 600
          replication.policy.class: "io.strimzi.kafka.connect.mirror.IdentityReplicationPolicy"
      heartbeatConnector:
        config:
          heartbeats.topic.replication.factor: 1
      sourceConnector:
        tasksMax: 1
        config:
          offset-syncs.topic.replication.factor: 1
          refresh.topics.interval.seconds: 600
          replication.factor: 2
          sync.topic.acls.enabled: "false"
          replication.policy.class: "io.strimzi.kafka.connect.mirror.IdentityReplicationPolicy"
  replicas: 1
  version: 2.7.0
```

## 使用 SCRAM-SHA-512 身份验证部署

### 1. 创建源用户

在源集群上创建一个具有主题和组的 `All` 权限的 `RdsKafkaUser`：

```yaml
apiVersion: middleware.alauda.io/v1
kind: RdsKafkaUser
metadata:
  name: sync-user
  namespace: <source-namespace>
  labels:
    middleware.alauda.io/cluster: <source-cluster-name>
spec:
  authentication:
    type: scram-sha-512
  authorization:
    type: simple
    acls:
      - host: "*"
        operation: All
        resource:
          type: topic
          name: "*"
          patternType: literal
      - host: "*"
        operation: All
        resource:
          type: group
          name: "*"
          patternType: literal
```

### 2. 在目标命名空间中创建密码秘密

MirrorMaker 2 在目标命名空间中运行，因此将源用户的密码复制到那里：

```bash
echo -n '<source-user-password>' > MY-PASSWORD.txt
kubectl -n <target-namespace> create secret generic sync-user-secret \
  --from-file=password=./MY-PASSWORD.txt
```

### 3. 创建目标用户

```yaml
apiVersion: middleware.alauda.io/v1
kind: RdsKafkaUser
metadata:
  name: target-cluster-user
  namespace: <target-namespace>
  labels:
    middleware.alauda.io/cluster: <target-cluster-name>
spec:
  authentication:
    type: scram-sha-512
  authorization:
    type: simple
    acls:
      - host: "*"
        operation: All
        resource:
          type: topic
          name: "*"
          patternType: literal
      - host: "*"
        operation: All
        resource:
          type: group
          name: "*"
          patternType: literal
```

### 4. 将身份验证添加到 MirrorMaker 2

```yaml
spec:
  clusters:
    - alias: my-cluster-source
      bootstrapServers: <source-bootstrap>:9092
      authentication:
        type: scram-sha-512
        username: sync-user
        passwordSecret:
          secretName: sync-user-secret
          password: password
    - alias: my-cluster-target
      bootstrapServers: target-cluster-kafka-bootstrap:9092
      authentication:
        type: scram-sha-512
        username: target-cluster-user
        passwordSecret:
          secretName: target-cluster-user
          password: password
```

## 验证部署

```bash
kubectl -n <target-namespace> get kmm2
kubectl -n <target-namespace> get pod | grep mirrormaker2
```

MirrorMaker 2 自定义资源应变为就绪状态。

## 监控

为 MirrorMaker 2 指标创建 `PodMonitor`：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: kafka-mirrormaker2
  namespace: operators
  labels:
    prometheus: kube-prometheus
spec:
  jobLabel: strimzi.io/cluster
  namespaceSelector:
    any: true
  podMetricsEndpoints:
    - interval: 15s
      path: /metrics
      port: tcp-prometheus
  selector:
    matchLabels:
      strimzi.io/kind: KafkaMirrorMaker2
```

## 重要考虑事项

- 根据主题数量、分区数量和复制堆积量设置 `tasksMax`。
- 在主题名称必须保持不变的情况下，将 `replication.policy.class` 保持为 `IdentityReplicationPolicy` 以实现主动-被动灾难恢复。
- 为源读取和目标写入使用单独的凭据。
- 在将灾难恢复环境用于生产之前，验证主题同步、数据同步、消费者组同步和故障转移。
