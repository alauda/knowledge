---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500110
sourceSHA: fe87aa7ebdd7ebbb66d3c75f63eb7138cabb90ef73801f8d8b1c905b04a7ce6c
---

# Kafka 灾难恢复操作手册（ACP 3.15）

:::info 适用版本
ACP 3.15.
:::

## 介绍

本操作指南涵盖基于 MirrorMaker 2 的 Kafka 热备份灾难恢复部署的常规监控、告警、故障排除和演练实践。

## 常规监控

MirrorMaker 2 监控应显示复制健康状况和资源使用情况。在目标 ACP 集群上 Prometheus 可用后，将 MirrorMaker 2 监控面板导入嵌入式 Grafana。

常见监控面板过滤器：

| 过滤器       | 描述                                      |
| ------------ | ----------------------------------------- |
| 命名空间    | MirrorMaker 2 实例运行的命名空间。      |
| 集群名称     | MirrorMaker 2 自定义资源的名称。        |
| 主题名称     | 要检查的主题。                          |

重要面板：

| 面板                | 意义                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 连接器数量          | MirrorMaker 2 连接器的数量。                                                                                   |
| 任务数量            | 正在运行的连接器任务数量。                                                                                     |
| 总记录速率          | 整体记录复制速率。                                                                                             |
| 总字节速率          | 整体字节复制速率。                                                                                             |
| 输入字节            | 从源集群读取的字节。                                                                                           |
| 输出字节            | 写入目标集群的字节。                                                                                           |
| CPU 使用率          | MirrorMaker 2 的 CPU 使用率。                                                                                   |
| JVM 内存            | MirrorMaker 2 的 JVM 内存使用情况。                                                                             |
| 垃圾回收耗时        | JVM 垃圾回收时间。                                                                                             |
| 记录年龄            | 记录在 MirrorSourceConnector 中停留的时间，直到复制。高值可能表示复制缓慢。                                   |
| 复制延迟            | 源到目标的复制延迟（以毫秒为单位）。                                                                           |
| 消费者堆积量        | 按主题和分区的复制堆积量。                                                                                     |

## 告警表达式

将 `$namespace`、`$targetClusterName`、`$mm2ClusterName` 和 `$topicName` 替换为您的环境值。如果环境使用 VictoriaMetrics 并带有集群标签，请添加适当的 `vmcluster` 过滤器。

| 告警                     | 示例表达式                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目标代理数量             | `count(kafka_server_replicamanager_leadercount{namespace="$namespace",job="$targetClusterName"})`                                                                                                                                                                                                 |
| 目标 PVC 使用情况        | `(avg(kubelet_volume_stats_used_bytes{namespace="$namespace",persistentvolumeclaim=~"data-$targetClusterName-.*"}) by (persistentvolumeclaim) / avg(kubelet_volume_stats_capacity_bytes{namespace="$namespace",persistentvolumeclaim=~"data-$targetClusterName-.*"}) by (persistentvolumeclaim))` |
| 活跃控制器数量           | `sum(kafka_controller_kafkacontroller_activecontrollercount{job="$targetClusterName",namespace="$namespace"})`                                                                                                                                                                                    |
| MirrorMaker 2 就绪 Pod 数 | `sum(kube_pod_container_status_ready{namespace="$namespace",pod=~"$mm2ClusterName-.*"})`                                                                                                                                                                                                          |
| 所有主题的最大堆积量     | `max(sum(kafka_consumer_fetch_manager_records_lag{namespace="$namespace",job="$mm2ClusterName",clientid!~"consumer-mirrormaker2-.*"}) by (topic, partition))`                                                                                                                                     |
| 单个主题的最大堆积量     | `max(sum(kafka_consumer_fetch_manager_records_lag{topic=~"$topicName",namespace="$namespace",job="$mm2ClusterName",clientid!~"consumer-mirrormaker2-.*"}) by (topic, partition))`                                                                                                                 |
| 堆积量增长                | `sum(delta(kafka_consumer_fetch_manager_records_lag{namespace="$namespace",job="$mm2ClusterName",clientid!~"consumer-mirrormaker2-.*"}[5m])) by (topic, partition)`                                                                                                                               |
| 最大复制延迟             | `max(sum(kafka_connect_mirror_mirrorsourceconnector_replication_latency_ms{namespace="$namespace",job="$mm2ClusterName"}) by (partition, topic))`                                                                                                                                                 |
| 记录年龄                | `max(sum(kafka_connect_mirror_mirrorsourceconnector_record_age_ms{namespace="$namespace",job="$mm2ClusterName"}) by (partition, topic))`                                                                                                                                                          |
| CPU 使用率              | `sum(rate(container_cpu_usage_seconds_total{namespace="$namespace",pod=~"$mm2ClusterName-mirrormaker2-.+",container="$mm2ClusterName-mirrormaker2"}[5m])) by (pod)`                                                                                                                               |
| JVM 内存                | `sum without(area)(jvm_memory_bytes_used{namespace="$namespace",job="$mm2ClusterName"})`                                                                                                                                                                                                          |

## 故障排除

### Kafka 启动异常

如果目标 Kafka 集群未准备好，MirrorMaker 2 可能无法写入复制数据。检查代理状态、控制器数量、PVC 容量和不足复制的分区。

```bash
kubectl -n <namespace> get pod
kubectl -n <namespace> get kafka <cluster-name> -o yaml
```

### MirrorMaker 2 堆积量持续增加

检查以下项目：

- 源写入速率超过 MirrorMaker 2 吞吐量。
- `tasksMax` 对于主题和分区数量过低。
- CPU 或内存限制过小。
- 站点之间的网络带宽或延迟不足。
- 目标 Kafka 代理速度慢或磁盘压力过大。

### 故障转移后消费者组偏移量滞后

消费者组偏移量会定期检查点。如果业务要求消费者偏移量的较低 RPO，请减少 `sync.group.offsets.interval.seconds`，并确保应用程序能够容忍重复。

## 灾难恢复演练检查清单

- 确认源和目标 Kafka 集群已准备好。
- 确认 MirrorMaker 2 状态为就绪。
- 确认选定的主题已复制。
- 生成和消费测试数据。
- 停止源消费者并继续生成。
- 在受控环境中模拟源故障。
- 将客户端切换到目标引导端点。
- 测量 RTO 和 RPO。
- 记录消费者观察到的任何重复记录。
- 恢复源集群并记录切换回的步骤。

## 重要考虑事项

- 告警应根据业务流量模式进行调整。低流量时期可能会使某些基于速率的告警产生噪声。
- 使用复制堆积量和记录年龄来判断复制健康状况。
- 高目标 PVC 使用率可能会破坏灾难恢复，即使 MirrorMaker 2 本身是健康的。
- 将灾难恢复演练视为 Kafka 操作员升级后的发布验证的一部分。
