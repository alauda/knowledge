---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Hot Standby Disaster Recovery with MirrorMaker 2

:::info Applicable Versions
ACP 3.8 and later. ACP 3.12+ deployments should prefer the newer KafkaMirrorMaker2 API examples from the ACP 3.15 deployment guide.
:::

## Introduction

A hot standby Kafka disaster recovery architecture uses two Kafka clusters in different sites or availability zones. The source cluster handles normal production and consumption. The target cluster receives replicated data and can be used after a failure or for read-only analytics workloads with separate consumer groups.

Replication is performed by Kafka MirrorMaker 2, which is deployed near the target cluster.

## Architecture

MirrorMaker 2 creates consumers connected to the source cluster and producers connected to the target cluster. It reads records from selected source topics and writes them to the target cluster.

MirrorMaker 2 also uses checkpoint topics to synchronize consumer group offsets. A checkpoint record contains the consumer group, topic, partition, upstream offset, downstream offset, metadata, and timestamp.

## Limitations

Kafka 2.5 and earlier do not automatically translate checkpoint offsets into the target cluster's `__consumer_offsets` topic. After failover, applications may need to translate offsets manually before continuing consumption on the target cluster.

For Java clients, the Kafka source code includes `RemoteClusterUtils.translateOffsets()` for this purpose. Non-Java clients need equivalent logic.

## Basic Deployment Flow

1. Create the source Kafka cluster.
2. Create the target Kafka cluster.
3. Deploy `KafkaMirrorMaker2` in the target cluster namespace.
4. Verify the MirrorMaker 2 pod and custom resource are ready.
5. Create a topic in the source cluster.
6. Verify that the topic appears in the target cluster.
7. Produce data to the source topic.
8. Verify that data appears in the target topic.
9. Test consumer group failover before declaring the DR procedure ready.

## Example MirrorMaker 2 Resource

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
          checkpoints.topic.replication.factor: 1
          emit.checkpoints.interval.seconds: 60
          sync.group.offsets.enabled: "true"
          sync.group.offsets.interval.seconds: 60
          refresh.groups.interval.seconds: 600
          replication.policy.class: "io.strimzi.kafka.connect.mirror.IdentityReplicationPolicy"
      heartbeatConnector:
        config:
          heartbeats.topic.replication.factor: 1
      sourceConnector:
        config:
          offset-syncs.topic.replication.factor: 1
          refresh.topics.interval.seconds: 600
          replication.factor: 2
          sync.topic.acls.enabled: "false"
          replication.policy.class: "io.strimzi.kafka.connect.mirror.IdentityReplicationPolicy"
  replicas: 1
  version: 2.7.0
```

## Failover Notes

- New topics are not always synchronized immediately. The default refresh interval is 10 minutes and can be changed with `refresh.topics.interval.seconds`.
- Consumer group offsets are synchronized periodically. If the source cluster fails before the latest offset checkpoint is replicated, consumers may reprocess some records after failover.
- Applications should tolerate duplicate consumption during DR failover.

## Important Considerations

- MirrorMaker 2 replication is asynchronous. RPO depends on replication throughput and lag.
- Network bandwidth between sites must exceed the normal write traffic, plus replication overhead.
- Keep source and target cluster sizing, storage capacity, and topic retention aligned.
- Failover requires manual decision-making and application connection changes unless the application has its own routing layer.
