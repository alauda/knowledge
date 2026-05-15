---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Best Practices

:::info Applicable Versions
ACP 3.14.x and 3.15.x. Most architectural guidance also applies to later Kafka operator releases, but verify exact resource defaults against the operator version installed in your cluster.
:::

## Introduction

Kafka is a distributed streaming platform used for high-throughput event ingestion, message buffering, data pipelines, and stream processing. On Kubernetes, Alauda Application Services manages Kafka through the Kafka operator stack: an RDS-facing operator, the Strimzi cluster operator, the entity operator, and Kafka exporter.

Use this guide when planning production Kafka instances or reviewing an existing deployment.

## Core Terms

| Term | Description |
| --- | --- |
| Broker | A Kafka server process. A cluster contains multiple brokers. |
| Topic | A logical stream of records. Producers write to topics and consumers read from topics. |
| Partition | The storage and parallelism unit of a topic. Each topic has one or more partitions. |
| Producer | A client that writes records to topics. |
| Consumer | A client that reads records from topics. |
| Consumer group | A group of consumers that share topic partitions for load balancing. |
| Offset | The monotonically increasing record position in a partition. |
| Lag | The distance between the latest partition offset and the offset consumed by a consumer group. |
| Leader | The broker replica that handles reads and writes for a partition. |
| Follower | A replica that copies data from the leader and can take over after failure. |

## Operator Components

| Component | Responsibility |
| --- | --- |
| `rds-operator` | Handles product-layer configuration, UI integration, and RDS custom resources. |
| `cluster-operator` | Creates, updates, and deletes Kafka clusters from the generated Kafka resources. |
| `entity-operator` | Contains topic and user operators for managing Kafka topics and users. Each Kafka instance has its own entity operator. |
| `kafka-exporter` | Connects to brokers and exposes Kafka metrics for monitoring. |

## Resource Planning

### CPU

Kafka is usually I/O-intensive rather than CPU-intensive. CPU is mainly consumed by compression, decompression, TLS, request handling, and high fan-out between producers, consumers, and partitions. Prefer more cores over higher single-core frequency when brokers serve many topics and clients.

Tune these broker parameters based on CPU sizing and benchmark results:

```properties
num.network.threads=<network-thread-count>
num.io.threads=<io-thread-count>
```

### Memory

Kafka relies heavily on the operating system page cache. If consumers hit page cache, reads avoid disk I/O and throughput improves. Avoid co-locating Kafka brokers with memory-heavy workloads unless node capacity is reserved and validated.

For JVM heap, a common starting point is 6-8 GiB for large brokers. Keep enough memory outside the heap for page cache:

```yaml
spec:
  kafka:
    jvmOptions:
      -Xms: 6g
      -Xmx: 8g
```

### Disk

Use dedicated disks for Kafka data. Do not share the same disk path with the node system disk or ZooKeeper storage for production brokers.

Prefer SSD-backed storage for better latency and IOPS. Size disk capacity by message volume, average message size, replica count, retention period, and compression ratio. For example, 1 billion messages per day, 1 KiB average message size, 2 replicas, and 7-day retention requires roughly 14 TiB before adding operational headroom.

### Network

Network bandwidth is often a throughput bottleneck. Plan for peak producer and consumer traffic, inter-broker replication, MirrorMaker 2 replication, and client fan-out.

Useful broker-level parameters include:

```properties
socket.send.buffer.bytes=<bytes>
socket.receive.buffer.bytes=<bytes>
socket.request.max.bytes=<bytes>
```

Enable producer compression when network bandwidth is the limiting factor. Kafka supports codecs such as `gzip`, `snappy`, `lz4`, and `zstd`. Compression saves bandwidth but increases CPU usage.

## Operator Deployment Modes

| Mode | Description | Recommended Use | Constraint |
| --- | --- | --- | --- |
| Cluster mode | One operator manages instances across all namespaces. | Resource-constrained clusters or centralized operation. Keep the managed instance count moderate. | Operator must run in the platform default namespace. |
| Multi-namespace mode | One operator manages a selected set of namespaces. | Moderate isolation with lower operator overhead. | Do not deploy another operator into the same namespace. |
| Single-namespace mode | One operator manages only its own namespace. | Strong isolation between tenants or workloads. | Higher operator overhead. |

## Creating Instances

In the Data Services view, select **Kafka**, choose the project and namespace, then create a Kafka instance. For 3.x deployments, use the latest Kafka version supported by your operator unless your application requires a specific version.

### Reference Resource Sizes

| Component | Small Production Starting Point |
| --- | --- |
| Kafka broker | 2 vCPU / 4 GiB, 3 replicas |
| ZooKeeper | 1 vCPU / 2 GiB, 3 replicas |
| Kafka exporter | 300m CPU / 128 MiB |
| Topic operator | 500m CPU / 500 MiB or higher for many topics |
| User operator | 500m CPU / 500 MiB or higher for many users |

For heavier workloads, benchmark with production-like producers and consumers, then scale brokers, partitions, and disks together.

### Important Parameters

| Parameter | Recommended Default | Reason |
| --- | --- | --- |
| `auto.create.topics.enable` | `false` | Create topics explicitly so partition count, replica count, and retention are controlled. |
| `auto.leader.rebalance.enable` | `false` | Avoid unexpected leader movement in production. Rebalance leaders manually after planned maintenance when needed. |
| `log.message.format.version` | Match the Kafka version used by clients during upgrades. | Prevents wire-format compatibility surprises. |
| `offsets.topic.replication.factor` | `3` | Keeps internal consumer offsets highly available. |
| `transaction.state.log.replication.factor` | `3` | Required for reliable transactional workloads. |
| `transaction.state.log.min.isr` | `2` | Prevents acknowledged transactional writes when too few replicas are in sync. |

## Scheduling

Enable pod anti-affinity for Kafka and ZooKeeper pods so replicas are spread across nodes. A three-broker Kafka cluster and a three-node ZooKeeper ensemble require at least three schedulable nodes for hard anti-affinity.

Hard anti-affinity improves availability but can block scheduling when nodes are scarce. Use soft anti-affinity only when the cluster does not have enough dedicated nodes and the availability tradeoff is acceptable.

## Application Access

| Scenario | Recommended Access Mode |
| --- | --- |
| Application runs in the same Kubernetes cluster | Use the internal bootstrap service, for example `<cluster>-kafka-bootstrap:9092`. |
| Application runs outside the Kubernetes cluster | Use `NodePort` or `LoadBalancer` external listener, depending on the environment. |
| Applications require authenticated access | Enable SCRAM-SHA-512 on the listener and create `KafkaUser` or `RdsKafkaUser` resources. |

For Kafka clusters with external access, each broker must remain individually reachable by clients after metadata discovery. Do not expose only one broker endpoint unless a Kafka-aware proxy or supported load-balancer configuration is used.

## Operations

- Monitor broker availability, under-replicated partitions, ISR changes, disk usage, request latency, consumer lag, and controller count.
- Keep broker data disks below operational thresholds. Alert before retention or disk pressure affects availability.
- Re-evaluate partition count when scaling brokers. Adding brokers alone does not automatically move existing partition replicas.
- Use explicit topic configuration for retention, segment size, partition count, and replica count.
- Avoid underscores in custom resource names. Kubernetes resource names must satisfy RFC 1123 naming rules.

## Important Considerations

- Kafka throughput is constrained by the slowest of disk, network, CPU, and client configuration. Benchmark before committing sizing numbers.
- Keep ZooKeeper storage and Kafka broker storage separated.
- Plan memory for page cache, not only JVM heap.
- Use hard anti-affinity for production clusters when enough nodes are available.
- Explicitly create topics instead of relying on auto-creation.
- Review operator defaults after every platform or operator upgrade.
