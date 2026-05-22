---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Disaster Recovery and Data Migration with SCRAM-SHA-512

:::info Applicable Versions
ACP 3.x Kafka clusters using SCRAM-SHA-512 authentication.
:::

## Introduction

This guide describes how to use MirrorMaker 2 to replicate data from a source Kafka cluster to a target Kafka cluster when SCRAM-SHA-512 authentication is enabled. The same pattern can be used for hot standby disaster recovery or migration.

## Architecture

- Source cluster: the Kafka cluster currently used by applications.
- Target cluster: the Kafka cluster that receives replicated topics and data.
- MirrorMaker 2: runs in the target namespace, consumes from the source cluster, and produces to the target cluster.

## Procedure

### 1. Create the Target Cluster

Create the target Kafka cluster and enable SCRAM-SHA-512 authentication on the listener used by MirrorMaker 2.

### 2. Create a Source User

MirrorMaker 2 needs a source-side user with permission to read topics and consumer groups.

For an RDS-managed Kafka source cluster:

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

For a native Kafka source cluster, create SCRAM credentials and ACLs with Kafka scripts:

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

### 3. Create the Source Password Secret in the Target Namespace

MirrorMaker 2 reads the source password from a Kubernetes secret in the namespace where MirrorMaker 2 runs:

```bash
echo -n '<source-password>' > MY-PASSWORD.txt
kubectl -n <target-namespace> create secret generic sync-user-secret \
  --from-file=password=./MY-PASSWORD.txt
```

### 4. Create a Target User

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

The target user's generated password secret usually has the same name as the user.

### 5. Create MirrorMaker 2

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

## Verify Synchronization

Check topic synchronization:

```bash
kafka-topics.sh --bootstrap-server <target-bootstrap>:9092 --list
```

Check data synchronization by producing to the source and consuming from the target.

Monitor lag. Synchronization is complete for a cutover only when topic data is present and lag reaches zero or an acceptable business threshold.

## Important Considerations

- The source and target users must have `All` permissions for topics and groups used by MirrorMaker 2.
- MirrorMaker 2 runs in the target namespace, so required source credentials must be copied there.
- `IdentityReplicationPolicy` keeps topic names unchanged, which is normally required for active-passive DR.
- Replication is asynchronous. Freeze writes during final migration cutover when exact consistency is required.
