---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500114
sourceSHA: cad0dbb809bfaf92f3ea9abfcff86523f9c0c734069849157041f69656b4c91c
---

# 使用 Kafka 内置性能测试脚本

:::info 适用版本
适用于 ACP 3.x Kafka 部署的一般 Kafka 指导。
:::

## 介绍

Kafka 镜像包含命令行工具，可以创建主题、运行生产者吞吐量测试、运行消费者吞吐量测试，并检查基本性能特征。使用这些脚本进行初步验证和比较测试，而不是替代特定工作负载的基准测试。

## 先决条件

- 已部署并可访问 Kafka 集群。
- 测试环境中可用 Kafka 脚本。
- 测试主题可以安全地创建和删除。
- 如果集群需要 SASL 或 TLS，则已准备好身份验证配置。

设置常见连接变量：

```bash
kafka_link="localhost:9092"
```

## 主题操作

```bash
./kafka-topics.sh --create \
  --bootstrap-server ${kafka_link} \
  --topic test_producer_perf \
  --partitions 6 \
  --replication-factor 1

./kafka-topics.sh --list --bootstrap-server ${kafka_link}
./kafka-topics.sh --describe --bootstrap-server ${kafka_link}
./kafka-topics.sh --delete --bootstrap-server ${kafka_link} --topic test_producer_perf
```

## 生产者测试

### 测试不同的分区数量

```bash
./kafka-topics.sh --create --bootstrap-server ${kafka_link} --topic test_producer_perf6 --partitions 6 --replication-factor 1
./kafka-topics.sh --create --bootstrap-server ${kafka_link} --topic test_producer_perf12 --partitions 12 --replication-factor 1

./kafka-producer-perf-test.sh --num-records 5000000 --topic test_producer_perf6 --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link}
./kafka-producer-perf-test.sh --num-records 5000000 --topic test_producer_perf12 --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link}
```

### 测试不同的从节点数量

```bash
./kafka-topics.sh --create --bootstrap-server ${kafka_link} --topic test_replication3 --partitions 3 --replication-factor 3
./kafka-topics.sh --create --bootstrap-server ${kafka_link} --topic test_replication5 --partitions 3 --replication-factor 5

./kafka-producer-perf-test.sh --num-records 5000000 --topic test_replication3 --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link}
./kafka-producer-perf-test.sh --num-records 5000000 --topic test_replication5 --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link}
```

### 测试批量大小

```bash
./kafka-producer-perf-test.sh --num-records 5000000 --topic test_producer_perf --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link} batch.size=200
./kafka-producer-perf-test.sh --num-records 5000000 --topic test_producer_perf --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link} batch.size=400
```

### 测试消息大小

```bash
./kafka-producer-perf-test.sh --num-records 5000000 --topic test_producer_perf --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link}
./kafka-producer-perf-test.sh --num-records 5000000 --topic test_producer_perf --throughput -1 --record-size 2000 --producer-props bootstrap.servers=${kafka_link}
```

重要的生产者选项：

| 选项                  | 说明                                                |
| --------------------- | -------------------------------------------------- |
| `--topic`             | 要生产到的主题。                                   |
| `--num-records`       | 要生产的记录数量。                                |
| `--throughput`        | 近似消息速率。 `-1` 禁用限流。                     |
| `--record-size`       | 消息大小（以字节为单位）。                         |
| `--producer-props`    | 生产者配置覆盖，例如 `bootstrap.servers`。        |
| `--producer.config`   | 生产者属性文件。                                  |
| `--print-metrics`     | 运行后打印详细指标。                              |

## 消费者测试

### 测试不同的线程数量

```bash
./kafka-consumer-perf-test.sh --bootstrap-server ${kafka_link} --messages 5000000 --topic test_producer_perf --timeout 100000 --threads 2
./kafka-consumer-perf-test.sh --bootstrap-server ${kafka_link} --messages 5000000 --topic test_producer_perf --timeout 100000 --threads 3
./kafka-consumer-perf-test.sh --bootstrap-server ${kafka_link} --messages 5000000 --topic test_producer_perf --timeout 100000 --threads 4
```

### 测试不同的分区数量

```bash
./kafka-consumer-perf-test.sh --bootstrap-server ${kafka_link} --messages 5000000 --topic test_producer_perf6 --timeout 100000
./kafka-consumer-perf-test.sh --bootstrap-server ${kafka_link} --messages 5000000 --topic test_producer_perf12 --timeout 100000
```

重要的消费者选项：

| 选项                  | 说明                                    |
| --------------------- | ---------------------------------------- |
| `--bootstrap-server`  | Kafka 引导服务器。                      |
| `--topic`             | 要消费的主题。                          |
| `--messages`          | 要消费的消息数量。                      |
| `--threads`           | 处理线程的数量。                        |
| `--num-fetch-threads` | 获取线程的数量。                        |
| `--consumer.config`   | 消费者属性文件。                        |
| `--timeout`           | 返回记录之间的最大间隔。                |

## 结果解读

生产者输出包括每秒记录数、每秒 MiB、平均延迟、最大延迟和延迟百分位数。消费者输出包括消费的数据、每秒 MiB 吞吐量、消息吞吐量和获取时间。

要从生产者的 MiB/s 估算网络带宽，将字节乘以 8 以转换为位。

## 重要注意事项

- Kafka 的内置生产者性能脚本并不能模拟每种应用模式，也不能替代真实客户端测试。
- 使用与生产客户端相同的身份验证、TLS、压缩、批量和确认设置进行测试。
- 在隔离主题上进行基准测试，并在使用后清理测试主题。
- 在测试期间监控代理的 CPU、磁盘、网络和消费者堆积量。
