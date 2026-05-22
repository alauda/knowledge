---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500119
sourceSHA: 9e84aa970cf88287f92a0d8232f57653655d18a1cff080a024871c110333c99d
---

# Kafka 灾难恢复监控与告警

:::info 适用版本
ACP 3.x 与基于 Kafka MirrorMaker 2 的灾难恢复。
:::

## 介绍

MirrorMaker 2 灾难恢复监控应回答三个问题：

- MirrorMaker 2 是否在运行？
- 数据是否以所需速率进行复制？
- 目标集群是否可以接受故障转移流量？

本指南总结了用于 Kafka 灾难恢复的监控面板和告警表达式。

## 部署监控

创建一个 `PodMonitor` 以便 Prometheus 抓取 MirrorMaker 2 指标：

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

在 Prometheus 开始抓取 pod 后，将 MirrorMaker 2 仪表板 JSON 导入嵌入式 Grafana。

## 监控面板

| 面板                | 描述                                          |
| -------------------- | --------------------------------------------- |
| 连接器数量          | 活动的 MirrorMaker 2 连接器数量。            |
| 任务数量            | 连接器任务数量。                             |
| 总记录速率          | 每秒复制的记录数。                           |
| 总字节速率          | 每秒复制的字节数。                           |
| 输入字节            | 从源集群读取的字节数。                       |
| 输出字节            | 写入目标集群的字节数。                       |
| CPU 使用率          | MirrorMaker 2 的 CPU 使用率。                |
| JVM 内存            | JVM 内存使用情况。                           |
| GC 花费时间         | JVM 垃圾回收压力。                           |
| 记录年龄            | 等待在 MirrorSourceConnector 中的记录年龄。 |
| 复制延迟            | 从源到目标的复制延迟。                       |
| 消费者堆积量        | 复制主题和分区的堆积量。                     |

## 告警变量

在告警模板中使用这些变量：

| 变量                 | 含义                                                      |
| -------------------- | --------------------------------------------------------- |
| `$namespace`         | 目标 Kafka 和 MirrorMaker 2 资源的命名空间。             |
| `$targetClusterName` | 目标 Kafka 集群名称。                                   |
| `$mm2ClusterName`    | MirrorMaker 2 自定义资源名称。                          |
| `$topicName`         | 可选的主题过滤器。                                       |

## 推荐告警

```text
count(kafka_server_replicamanager_leadercount{namespace="$namespace",job="$targetClusterName"})
```

目标代理数量。

```text
avg(kubelet_volume_stats_used_bytes{namespace="$namespace",persistentvolumeclaim=~"data-$targetClusterName-.*"}) by (persistentvolumeclaim)
/
avg(kubelet_volume_stats_capacity_bytes{namespace="$namespace",persistentvolumeclaim=~"data-$targetClusterName-.*"}) by (persistentvolumeclaim)
```

目标 Kafka PVC 使用比例。

```text
sum(kafka_controller_kafkacontroller_activecontrollercount{job="$targetClusterName",namespace="$namespace"})
```

活动控制器数量。通常应该只有一个控制器处于活动状态。

```text
sum(kube_pod_container_status_ready{namespace="$namespace",pod=~"$mm2ClusterName-.*"})
```

MirrorMaker 2 准备就绪的 pod 数量。

```text
max(sum(kafka_consumer_fetch_manager_records_lag{namespace="$namespace",job="$mm2ClusterName",clientid!~"consumer-mirrormaker2-.*"}) by (topic, partition))
```

复制主题的最大堆积量。

```text
max(sum(kafka_connect_mirror_mirrorsourceconnector_replication_latency_ms{namespace="$namespace",job="$mm2ClusterName"}) by (partition, topic))
```

最大复制延迟。

```text
max(sum(kafka_connect_mirror_mirrorsourceconnector_record_age_ms{namespace="$namespace",job="$mm2ClusterName"}) by (partition, topic))
```

MirrorSourceConnector 中的最大记录年龄。

```text
sum(rate(container_cpu_usage_seconds_total{namespace="$namespace",pod=~"$mm2ClusterName-mirrormaker2-.+",container="$mm2ClusterName-mirrormaker2"}[5m])) by (pod)
```

MirrorMaker 2 的 CPU 使用率。

```text
sum without(area)(jvm_memory_bytes_used{namespace="$namespace",job="$mm2ClusterName"})
```

MirrorMaker 2 的 JVM 内存使用情况。

## RTO 和 RPO

RTO 是故障后恢复服务所需的最长时间。在此解决方案中，RTO 主要由手动故障转移决策时间和应用程序连接切换决定。

RPO 是故障后最大数据丢失。在 MirrorMaker 2 灾难恢复中，RPO 取决于复制吞吐量、复制延迟和消费者组偏移检查点时间。只要容量足够，RPO 可以是秒级，但必须在演练中进行测量。

## 重要考虑事项

- 健康的 MirrorMaker 2 pod 并不能保证目标 Kafka 集群准备好进行故障转移。需监控两侧。
- 在流量突发时，关注堆积量趋势，而不仅仅是绝对值。
- 目标集群的磁盘使用情况是灾难恢复准备的一部分。
- 在 Prometheus、VictoriaMetrics 或标签约定更改后，重新测试告警表达式。
