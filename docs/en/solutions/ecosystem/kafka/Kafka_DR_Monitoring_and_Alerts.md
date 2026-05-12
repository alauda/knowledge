---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Disaster Recovery Monitoring and Alerts

:::info Applicable Versions
ACP 3.x with Kafka MirrorMaker 2 based disaster recovery.
:::

## Introduction

MirrorMaker 2 DR monitoring should answer three questions:

- Is MirrorMaker 2 running?
- Is data being replicated at the required rate?
- Can the target cluster accept failover traffic?

This guide summarizes the dashboard panels and alert expressions used for Kafka DR.

## Deploy Monitoring

Create a `PodMonitor` so Prometheus scrapes MirrorMaker 2 metrics:

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

Import the MirrorMaker 2 dashboard JSON into the embedded Grafana after Prometheus starts scraping the pod.

## Dashboard Panels

| Panel | Description |
| --- | --- |
| Number of Connectors | Number of active MirrorMaker 2 connectors. |
| Number of Tasks | Number of connector tasks. |
| Total record rate | Records replicated per second. |
| Total byte rate | Bytes replicated per second. |
| Incoming bytes | Bytes read from the source cluster. |
| Outgoing bytes | Bytes written to the target cluster. |
| CPU Usage | MirrorMaker 2 CPU usage. |
| JVM Memory | JVM memory usage. |
| Time spent in GC | JVM garbage collection pressure. |
| Record Age | Age of records waiting in MirrorSourceConnector. |
| Replication Latency | Replication delay from source to target. |
| Consumer Lag | Lag for replicated topics and partitions. |

## Alert Variables

Use these variables in alert templates:

| Variable | Meaning |
| --- | --- |
| `$namespace` | Namespace of the target Kafka and MirrorMaker 2 resources. |
| `$targetClusterName` | Target Kafka cluster name. |
| `$mm2ClusterName` | MirrorMaker 2 custom resource name. |
| `$topicName` | Optional topic filter. |

## Recommended Alerts

```promql
count(kafka_server_replicamanager_leadercount{namespace="$namespace",job="$targetClusterName"})
```

Target broker count.

```promql
avg(kubelet_volume_stats_used_bytes{namespace="$namespace",persistentvolumeclaim=~"data-$targetClusterName-.*"}) by (persistentvolumeclaim)
/
avg(kubelet_volume_stats_capacity_bytes{namespace="$namespace",persistentvolumeclaim=~"data-$targetClusterName-.*"}) by (persistentvolumeclaim)
```

Target Kafka PVC usage ratio.

```promql
sum(kafka_controller_kafkacontroller_activecontrollercount{job="$targetClusterName",namespace="$namespace"})
```

Active controller count. Normally exactly one controller should be active.

```promql
sum(kube_pod_container_status_ready{namespace="$namespace",pod=~"$mm2ClusterName-.*"})
```

MirrorMaker 2 ready pod count.

```promql
max(sum(kafka_consumer_fetch_manager_records_lag{namespace="$namespace",job="$mm2ClusterName",clientid!~"consumer-mirrormaker2-.*"}) by (topic, partition))
```

Maximum lag across replicated topics.

```promql
max(sum(kafka_connect_mirror_mirrorsourceconnector_replication_latency_ms{namespace="$namespace",job="$mm2ClusterName"}) by (partition, topic))
```

Maximum replication latency.

```promql
max(sum(kafka_connect_mirror_mirrorsourceconnector_record_age_ms{namespace="$namespace",job="$mm2ClusterName"}) by (partition, topic))
```

Maximum record age in MirrorSourceConnector.

```promql
sum(rate(container_cpu_usage_seconds_total{namespace="$namespace",pod=~"$mm2ClusterName-mirrormaker2-.+",container="$mm2ClusterName-mirrormaker2"}[5m])) by (pod)
```

MirrorMaker 2 CPU usage.

```promql
sum without(area)(jvm_memory_bytes_used{namespace="$namespace",job="$mm2ClusterName"})
```

MirrorMaker 2 JVM memory usage.

## RTO and RPO

RTO is the maximum time required to restore service after a failure. In this solution, RTO is mostly determined by manual failover decision time and application connection switching.

RPO is the maximum data loss after a failure. In MirrorMaker 2 DR, RPO depends on replication throughput, replication lag, and consumer group offset checkpoint timing. With sufficient capacity, RPO can be seconds, but it must be measured in drills.

## Important Considerations

- A healthy MirrorMaker 2 pod does not guarantee the target Kafka cluster is ready for failover. Monitor both sides.
- Alert on lag trends, not only absolute values, when traffic is bursty.
- Disk usage on the target cluster is part of DR readiness.
- Re-test alert expressions after Prometheus, VictoriaMetrics, or label conventions change.
