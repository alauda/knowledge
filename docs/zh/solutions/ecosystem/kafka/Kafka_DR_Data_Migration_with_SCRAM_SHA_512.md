---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500105
sourceSHA: 3c0cc3b60d3eb4c1f847994d1e64727095cee045d2d6c4ed9ed9100c57707d11
---

# Kafka 灾难恢复与数据迁移使用 SCRAM-SHA-512

:::info 适用版本
ACP 3.x Kafka 集群使用 SCRAM-SHA-512 认证。
:::

## 介绍

本指南描述了如何使用 MirrorMaker 2 将数据从源 Kafka 集群复制到目标 Kafka 集群，当启用 SCRAM-SHA-512 认证时。相同的模式可以用于热备灾难恢复或迁移。

## 架构

- 源集群：当前由应用程序使用的 Kafka 集群。
- 目标集群：接收复制主题和数据的 Kafka 集群。
- MirrorMaker 2：在目标命名空间中运行，从源集群消费，并向目标集群生产。

## 操作步骤

### 1. 创建目标集群

创建目标 Kafka 集群，并在 MirrorMaker 2 使用的监听器上启用 SCRAM-SHA-512 认证。

### 2. 创建源用户

MirrorMaker 2 需要一个具有读取主题和消费者组权限的源侧用户。

对于 RDS 管理的 Kafka 源集群：

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

对于原生 Kafka 源集群，使用 Kafka 脚本创建 SCRAM 凭证和 ACL：

```bash
bin/kafka-configs.sh --zookeeper 127.0.0.1:2181 --alter \
  --add-config 'SCRAM-SHA-256=[password=<password>],SCRAM-SHA-512=[password=<password>]' \
  --entity-type users \
  --entity-name sync-user

bin/kafka-acls.sh --authorizer kafka.security.auth.SimpleAclAuthorizer \
  --authorizer-properties zookeeper.connect=127.0.0.1:2181 \
  --add --allow-principal User:sync-user --operation All --topic "*"

bin/kafka-acls.sh --authorizer kafka.security.auth.SimpleAclAuthorizer \
  --authorizer-properties zookeeper.connect=127.0.0.1:2181 \
  --add --allow-principal User:sync-user --operation All --group "*"
```

### 3. 在目标命名空间中创建源密码密钥

MirrorMaker 2 从运行 MirrorMaker 2 的命名空间中的 Kubernetes 密钥读取源密码：

```bash
echo -n '<source-password>' > MY-PASSWORD.txt
kubectl -n <target-namespace> create secret generic sync-user-secret \
  --from-file=password=./MY-PASSWORD.txt
```

### 4. 创建目标用户

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

目标用户生成的密码密钥通常与用户同名。

### 5. 创建 MirrorMaker 2

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
        tasksMax: 3
        config:
          offset-syncs.topic.replication.factor: 1
          refresh.topics.interval.seconds: 600
          replication.factor: 2
          sync.topic.acls.enabled: "false"
          replication.policy.class: "io.strimzi.kafka.connect.mirror.IdentityReplicationPolicy"
  replicas: 1
  version: 2.7.0
```

## 验证同步

检查主题同步：

```bash
kafka-topics.sh --bootstrap-server <target-bootstrap>:9092 --list
```

通过在源中生产数据并在目标中消费数据来检查数据同步。

监控堆积量。只有当主题数据存在且堆积量达到零或可接受的业务阈值时，切换的同步才算完成。

## 重要注意事项

- 源用户和目标用户必须对 MirrorMaker 2 使用的主题和组具有 `All` 权限。
- MirrorMaker 2 在目标命名空间中运行，因此所需的源凭证必须复制到那里。
- `IdentityReplicationPolicy` 保持主题名称不变，这通常是主动-被动灾难恢复所需的。
- 复制是异步的。在最终迁移切换期间，当需要精确一致性时，请冻结写入。
