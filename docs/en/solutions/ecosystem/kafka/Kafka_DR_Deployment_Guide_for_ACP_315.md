---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Disaster Recovery Deployment Guide for ACP 3.15

:::info Applicable Versions
ACP 3.12 and later; validated for ACP 3.15.
:::

## Introduction

This guide describes the deployment side of a Kafka hot standby disaster recovery solution based on MirrorMaker 2. The source cluster is used for normal production and consumption. The target cluster receives replicated data and can be used after failover or by separate read-only workloads.

The solution targets same-city dual-site deployments where bandwidth and latency can be controlled.

## DR Characteristics

| Item | Value |
| --- | --- |
| DR level | Level 5 DR pattern |
| Replication engine | MirrorMaker 2 |
| Synchronization mode | Near-real-time asynchronous replication |
| RTO | Minutes, depending on manual failover speed |
| RPO | Seconds when replication is sized correctly |

## Risks and Limitations

- Data loss can occur because replication is asynchronous.
- Duplicate consumption can occur because consumer group offsets are synchronized periodically.
- Insufficient bandwidth or high latency increases replication lag.
- Failover requires manual judgment and connection switching.
- MirrorMaker 2 consumes CPU, memory, and network bandwidth. Size it separately from application consumers.

## Key MirrorMaker 2 Parameters

| Parameter | Description |
| --- | --- |
| `checkpointConnector.config.sync.group.offsets.enabled` | Enables consumer group offset synchronization. |
| `checkpointConnector.config.sync.group.offsets.interval.seconds` | Consumer group offset sync interval. Default is 60 seconds. |
| `checkpointConnector.config.refresh.groups.interval.seconds` | New consumer group discovery interval. Default is 10 minutes. |
| `sourceConnector.config.refresh.topics.interval.seconds` | New topic discovery interval. Default is 10 minutes. |
| `sourceConnector.config.replication.factor` | Replica count for replicated topics on the target cluster. |
| `topicsPattern` | Topic name pattern to replicate. |

## Prerequisites

- Source and target business clusters are upgraded to ACP 3.12 or later.
- Source and target Kafka instances use similar resource, storage, and parameter profiles.
- Network bandwidth between the two sites is higher than the source write traffic.
- Target storage capacity and performance match the source cluster.
- Prometheus is deployed if MirrorMaker 2 monitoring is required.

## Deploy Without Authentication

Create the MirrorMaker 2 metrics `ConfigMap` and the `KafkaMirrorMaker2` resource in the target Kafka namespace.

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

## Deploy With SCRAM-SHA-512 Authentication

### 1. Create a Source User

Create an `RdsKafkaUser` on the source cluster with `All` permissions for topics and groups:

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

### 2. Create a Password Secret in the Target Namespace

MirrorMaker 2 runs in the target namespace, so copy the source user's password there:

```bash
echo -n '<source-user-password>' > MY-PASSWORD.txt
kubectl -n <target-namespace> create secret generic sync-user-secret \
  --from-file=password=./MY-PASSWORD.txt
```

### 3. Create a Target User

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

### 4. Add Authentication to MirrorMaker 2

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

## Verify Deployment

```bash
kubectl -n <target-namespace> get kmm2
kubectl -n <target-namespace> get pod | grep mirrormaker2
```

The MirrorMaker 2 custom resource should become ready.

## Monitoring

Create a `PodMonitor` for MirrorMaker 2 metrics:

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

## Important Considerations

- Set `tasksMax` based on topic count, partition count, and replication lag.
- Keep `replication.policy.class` as `IdentityReplicationPolicy` for active-passive DR when topic names must remain unchanged.
- Use separate credentials for source reads and target writes.
- Validate topic sync, data sync, consumer group sync, and failover before using the DR environment for production.
