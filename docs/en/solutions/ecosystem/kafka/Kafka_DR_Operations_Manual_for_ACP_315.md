---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Disaster Recovery Operations Manual for ACP 3.15

:::info Applicable Versions
ACP 3.15.
:::

## Introduction

This operations guide covers routine monitoring, alerting, troubleshooting, and drill practices for a Kafka hot standby DR deployment based on MirrorMaker 2.

## Routine Monitoring

MirrorMaker 2 monitoring should show replication health and resource usage. Import the MirrorMaker 2 dashboard into the embedded Grafana after Prometheus is available on the target ACP cluster.

Common dashboard filters:

| Filter | Description |
| --- | --- |
| Namespace | Namespace where the MirrorMaker 2 instance runs. |
| Cluster Name | Name of the MirrorMaker 2 custom resource. |
| Topic Name | Topic to inspect. |

Important panels:

| Panel | Meaning |
| --- | --- |
| Number of Connectors | Number of MirrorMaker 2 connectors. |
| Number of Tasks | Number of running connector tasks. |
| Total record rate | Overall record replication rate. |
| Total byte rate | Overall byte replication rate. |
| Incoming bytes | Bytes read from the source cluster. |
| Outgoing bytes | Bytes written to the target cluster. |
| CPU Usage | MirrorMaker 2 CPU usage. |
| JVM Memory | MirrorMaker 2 JVM memory usage. |
| Time spent in GC | JVM garbage collection time. |
| Record Age | How long records stay in the MirrorSourceConnector before replication. High values can indicate slow replication. |
| Replication Latency | Source-to-target replication latency in milliseconds. |
| Consumer Lag | Replication lag by topic and partition. |

## Alert Expressions

Replace `$namespace`, `$targetClusterName`, `$mm2ClusterName`, and `$topicName` with your environment values. If the environment uses VictoriaMetrics with a cluster label, add the appropriate `vmcluster` filter.

| Alert | Example Expression |
| --- | --- |
| Target broker count | `count(kafka_server_replicamanager_leadercount{namespace="$namespace",job="$targetClusterName"})` |
| Target PVC usage | `(avg(kubelet_volume_stats_used_bytes{namespace="$namespace",persistentvolumeclaim=~"data-$targetClusterName-.*"}) by (persistentvolumeclaim) / avg(kubelet_volume_stats_capacity_bytes{namespace="$namespace",persistentvolumeclaim=~"data-$targetClusterName-.*"}) by (persistentvolumeclaim))` |
| Active controller count | `sum(kafka_controller_kafkacontroller_activecontrollercount{job="$targetClusterName",namespace="$namespace"})` |
| MirrorMaker 2 ready pods | `sum(kube_pod_container_status_ready{namespace="$namespace",pod=~"$mm2ClusterName-.*"})` |
| Max lag across all topics | `max(sum(kafka_consumer_fetch_manager_records_lag{namespace="$namespace",job="$mm2ClusterName",clientid!~"consumer-mirrormaker2-.*"}) by (topic, partition))` |
| Max lag for one topic | `max(sum(kafka_consumer_fetch_manager_records_lag{topic=~"$topicName",namespace="$namespace",job="$mm2ClusterName",clientid!~"consumer-mirrormaker2-.*"}) by (topic, partition))` |
| Lag growth | `sum(delta(kafka_consumer_fetch_manager_records_lag{namespace="$namespace",job="$mm2ClusterName",clientid!~"consumer-mirrormaker2-.*"}[5m])) by (topic, partition)` |
| Max replication latency | `max(sum(kafka_connect_mirror_mirrorsourceconnector_replication_latency_ms{namespace="$namespace",job="$mm2ClusterName"}) by (partition, topic))` |
| Record age | `max(sum(kafka_connect_mirror_mirrorsourceconnector_record_age_ms{namespace="$namespace",job="$mm2ClusterName"}) by (partition, topic))` |
| CPU usage | `sum(rate(container_cpu_usage_seconds_total{namespace="$namespace",pod=~"$mm2ClusterName-mirrormaker2-.+",container="$mm2ClusterName-mirrormaker2"}[5m])) by (pod)` |
| JVM memory | `sum without(area)(jvm_memory_bytes_used{namespace="$namespace",job="$mm2ClusterName"})` |

## Troubleshooting

### Kafka Startup Is Abnormal

If the target Kafka cluster is not ready, MirrorMaker 2 may be unable to write replicated data. Check broker status, controller count, PVC capacity, and under-replicated partitions.

```bash
kubectl -n <namespace> get pod
kubectl -n <namespace> get kafka <cluster-name> -o yaml
```

### MirrorMaker 2 Lag Keeps Increasing

Check these items:

- Source write rate exceeds MirrorMaker 2 throughput.
- `tasksMax` is too low for the topic and partition count.
- CPU or memory limits are too small.
- Network bandwidth or latency between sites is insufficient.
- Target Kafka brokers are slow or under disk pressure.

### Consumer Group Offset Is Behind After Failover

Consumer group offsets are checkpointed periodically. Reduce `sync.group.offsets.interval.seconds` if the business requires a lower RPO for consumer offsets, and ensure applications can tolerate duplicates.

## DR Drill Checklist

- Confirm source and target Kafka clusters are ready.
- Confirm MirrorMaker 2 status is ready.
- Confirm selected topics are replicated.
- Produce and consume test data.
- Stop the source consumer and continue producing.
- Simulate source failure in a controlled environment.
- Switch clients to the target bootstrap endpoint.
- Measure RTO and RPO.
- Record any duplicate records observed by the consumer.
- Restore the source cluster and document switch-back steps.

## Important Considerations

- Alerts should be tuned to business traffic patterns. Low traffic periods can make some rate-based alerts noisy.
- Use both replication lag and record age to judge replication health.
- High target PVC usage can break DR even when MirrorMaker 2 itself is healthy.
- Treat DR drills as part of release validation after Kafka operator upgrades.
