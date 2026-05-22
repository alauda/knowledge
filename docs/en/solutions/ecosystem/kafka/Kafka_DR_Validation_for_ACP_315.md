---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Disaster Recovery Validation for ACP 3.15

:::info Applicable Versions
ACP 3.15.
:::

## Introduction

After deploying Kafka hot standby disaster recovery with MirrorMaker 2, validate topic replication, data replication, consumer group synchronization, monitoring, and failover behavior.

## Prerequisites

- The source Kafka cluster, target Kafka cluster, and MirrorMaker 2 instance are deployed.
- The MirrorMaker 2 custom resource is ready.
- Monitoring is configured if alert and dashboard validation is required.
- You have a test topic and test producer/consumer tools available.

## Validate Topic Synchronization

1. Create a topic on the source cluster.
2. Check whether the topic appears on the target cluster.

New topics are not synchronized immediately by default. MirrorMaker 2 discovers new topics based on `refresh.topics.interval.seconds`, which is commonly set to 600 seconds. Lower this value for testing if faster discovery is required.

## Validate Data Synchronization

1. Produce test records to the source topic.
2. Consume from the corresponding topic on the target cluster.
3. Confirm the target topic receives the expected records.

Example producer and consumer commands:

```bash
kafka-console-producer.sh \
  --bootstrap-server <source-bootstrap>:9092 \
  --topic my-topic

kafka-console-consumer.sh \
  --bootstrap-server <target-bootstrap>:9092 \
  --topic my-topic \
  --from-beginning
```

## Validate Consumer Group Synchronization

1. Produce records to a source topic.
2. Consume part of the records on the source cluster with a fixed group, for example `group1`.
3. Stop the source consumer.
4. Continue producing records to the source topic.
5. Check the target cluster for the synchronized consumer group.
6. Start a consumer with the same group on the target cluster and confirm it continues from the synchronized offset rather than always starting from the beginning.

Consumer group offsets are synchronized periodically, not in real time. Some duplicate consumption can occur after failover if the source cluster fails before the latest offset checkpoint reaches the target cluster.

## Validate Monitoring

1. Produce traffic to the source topic.
2. Open the MirrorMaker 2 dashboard.
3. Confirm that replicated topics and traffic appear in the panels.
4. Check lag, replication latency, record age, CPU, JVM memory, and task count.

## Validate Failover

1. Produce and consume records on the source cluster with a fixed consumer group.
2. Stop the source consumer after it has consumed part of the records.
3. Continue producing several more records.
4. Simulate source cluster failure by stopping the Kafka operator or broker workloads in a controlled test environment.
5. Switch application bootstrap addresses to the target cluster.
6. Produce and consume on the target cluster.
7. Confirm that the consumer group can continue from the synchronized offset.
8. Restore the source cluster and test the planned switch-back procedure separately.

## Important Considerations

- Run failover validation only in a non-production or approved DR drill window.
- Duplicate consumption is expected in some failure timings. Applications must be idempotent or otherwise tolerate duplicate messages.
- Topic creation and consumer group synchronization use separate refresh intervals.
- Record the observed RTO and RPO from the drill instead of relying only on theoretical values.
