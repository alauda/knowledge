---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500113
sourceSHA: 33f0a5cf2edcb4e941fda6589d4642232bf2fce66276405862b959fbcbb7dea1
---

# 使用用户名和密码访问 Kafka 集群

:::info 适用版本
ACP 3.x 从管理视图创建的 Kafka 实例。
:::

## 介绍

本指南展示如何创建一个使用 SCRAM-SHA-512 认证的 Kafka 集群，创建主题和用户，检索生成的密码，并使用 Kafka 命令行工具测试生产者和消费者的访问。

## 1. 创建 Kafka 集群

在客户端使用的监听器上启用 SCRAM-SHA-512 认证，并启用简单授权：

```yaml
apiVersion: kafka.strimzi.io/v1beta1
kind: Kafka
metadata:
  name: demo
  namespace: demo-dba
spec:
  kafka:
    version: 2.5.0
    replicas: 3
    listeners:
      plain:
        authentication:
          type: scram-sha-512
      external:
        type: nodeport
        tls: true
        authentication:
          type: scram-sha-512
      tls:
        authentication:
          type: tls
    authorization:
      type: simple
    config:
      log.message.format.version: "2.5"
      offsets.topic.replication.factor: 3
      transaction.state.log.min.isr: 2
      transaction.state.log.replication.factor: 3
    storage:
      type: persistent-claim
      size: 10Gi
      class: topolvm
  zookeeper:
    replicas: 3
    storage:
      type: persistent-claim
      size: 10Gi
      class: topolvm
```

## 2. 创建主题

```yaml
apiVersion: kafka.strimzi.io/v1beta1
kind: KafkaTopic
metadata:
  name: demo-topic
  namespace: demo-dba
  labels:
    strimzi.io/cluster: demo
spec:
  topicName: demo-topic
  partitions: 10
  replicas: 3
  config:
    retention.ms: 604800000
    segment.bytes: 1073741824
```

## 3. 创建用户

```yaml
apiVersion: kafka.strimzi.io/v1beta1
kind: KafkaUser
metadata:
  name: demo-user
  namespace: demo-dba
  labels:
    strimzi.io/cluster: demo
spec:
  authentication:
    type: scram-sha-512
  authorization:
    type: simple
    acls:
      - host: "*"
        operation: Read
        resource:
          type: topic
          name: demo-topic
          patternType: literal
      - host: "*"
        operation: Write
        resource:
          type: topic
          name: demo-topic
          patternType: literal
      - host: "*"
        operation: Describe
        resource:
          type: topic
          name: demo-topic
          patternType: literal
      - host: "*"
        operation: Create
        resource:
          type: topic
          name: demo-topic
          patternType: literal
      - host: "*"
        operation: Read
        resource:
          type: group
          name: demo-group
          patternType: literal
```

## 4. 获取引导服务

内部访问：

```bash
kubectl -n demo-dba get svc demo-kafka-bootstrap
```

外部访问：

```bash
kubectl -n demo-dba get svc demo-kafka-external-bootstrap
```

## 5. 检索生成的密码

```bash
kubectl -n demo-dba get secret demo-user -o jsonpath='{.data.password}' | base64 -d
```

## 6. 创建客户端属性文件

对于使用 SCRAM-SHA-512 的内部明文监听器：

```properties
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="demo-user" password="<password>";
security.protocol=SASL_PLAINTEXT
sasl.mechanism=SCRAM-SHA-512
```

将其保存为 `client.properties`。

## 7. 运行测试 Pod

在可能的情况下使用与代理相同的 Kafka 镜像：

```bash
kubectl -n demo-dba get pod demo-kafka-0 -o yaml | grep 'image:'

kubectl -n demo-dba run kafka-test0 -it \
  --image=<kafka-image> \
  --rm=true \
  --restart=Never \
  -- bash

kubectl -n demo-dba run kafka-test1 -it \
  --image=<kafka-image> \
  --rm=true \
  --restart=Never \
  -- bash
```

将属性文件复制到两个 Pod 中：

```bash
kubectl -n demo-dba cp ./client.properties kafka-test0:/home/kafka/client.properties
kubectl -n demo-dba cp ./client.properties kafka-test1:/home/kafka/client.properties
```

## 8. 生产和消费消息

生产者：

```bash
/opt/kafka/bin/kafka-console-producer.sh \
  --bootstrap-server demo-kafka-bootstrap:9092 \
  --topic demo-topic \
  --producer.config /home/kafka/client.properties
```

消费者：

```bash
/opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server demo-kafka-bootstrap:9092 \
  --topic demo-topic \
  --consumer.config /home/kafka/client.properties \
  --from-beginning \
  --group demo-group
```

## 重要注意事项

- 用户密钥由 Strimzi 用户操作员在 `KafkaUser` 准备就绪后生成。
- 仅对非 TLS 监听器使用 `SASL_PLAINTEXT`。对于 TLS 监听器，配置信任库设置并使用 `SASL_SSL`。
- 为消费者授予主题 ACL 和组 ACL。
- 外部访问要求 Kafka 元数据中返回的代理端点可以从客户端网络访问。
