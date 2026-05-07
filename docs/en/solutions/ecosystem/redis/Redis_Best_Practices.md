---
products:
  - Alauda Application Services
kind:
  - Solution
---

# Redis Best Practices

:::info Applicable Versions
Alauda Container Platform **v3.18+** (the supported operator at the time of this update). Architectural recommendations and sizing guidance below were originally validated on v3.12–v3.14 and remain broadly applicable to current releases. Where specific numbers (parameter template names, container limits, benchmark figures) drift from current operator defaults, prefer the values shipped by your installed operator.
:::

## Introduction

Redis is a high-performance in-memory data store widely used as a cache, message broker, leaderboard, and more. Containerizing Redis on Kubernetes provides a consistent, portable, and reproducible runtime, but it also introduces new challenges around deployment, configuration, persistence, performance tuning, instance lifecycle management, and application integration.

This document collects the best practices we recommend for running Alauda Cache Service for Redis OSS on Kubernetes. Following these practices helps you achieve durable, highly available, and performant Redis instances while keeping operational overhead manageable.

## Architecture Overview

Alauda Cache Service for Redis OSS provides two managed architectures to fit different workloads.

### Sentinel Mode (Redis Sentinel)

Sentinel mode is a high-availability solution built on Redis primary-replica replication. Redis Sentinel monitors the instance state and automatically promotes a replica to primary when the primary fails.

Key characteristics:

- **Simple to operate.** Easier to deploy and manage than cluster mode.
- **Highly available.** Automatic failover keeps the service available when a node fails.
- **Limited scaling.** Only vertical scaling and read scaling via replicas. There is no native horizontal sharding.
- **Sentinel availability.** Sentinel processes themselves must be made highly available (run at least three Sentinel pods).

### Cluster Mode (Redis Cluster)

Cluster mode is the native horizontally scalable architecture in Redis. Data is sharded across multiple nodes using a hash slot algorithm, allowing the dataset to grow well beyond the memory of any single node.

Key characteristics:

- **High availability.** Replicas can take over for failed primaries automatically.
- **Horizontal scalability.** Shards (and the nodes that host them) can be added or removed online.
- **Load balancing.** Reads and writes are distributed across primaries.
- **Distributed dataset.** Avoids hot spots from large datasets being concentrated on a single node.
- **Higher complexity.** Sharding, hash slots, data migration, and rebalancing add operational complexity.

### Architecture Selection Matrix

|  | Needs unlimited horizontal scaling | Single-node or small footprint | Large dataset (>8 GB) | High availability |
| --- | :---: | :---: | :---: | :---: |
| Cluster mode | Yes | No | Yes | Yes |
| Sentinel mode | No | Yes | No | Yes |

## Resource Sizing

### Memory

Redis takes periodic snapshots of in-memory data to disk. This snapshotting model is fast, but data written between snapshots may be lost if Redis is killed.

For production deployments, we recommend keeping the memory of each Redis shard under **8 GB**. Two reasons drive this recommendation:

1. **Single-threaded event loop.** Redis processes network I/O and data operations in one thread. As the dataset grows, response time can increase, eventually causing client-visible latency or stalls.
2. **Persistence and backup overhead.** Larger datasets make RDB/AOF snapshots, replication, and backup/restore operations slower and more expensive.

If a single shard exceeds 8 GB, consider sharding the data with cluster mode instead of growing the shard further.

### CPU

In Kubernetes, you can opt in to dedicated CPU cores using the kubelet's static CPU manager:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
```

After updating the kubelet configuration, restart kubelet:

```bash
systemctl restart kubelet
```

With `cpuManagerPolicy: static`, pods that request integer CPU values get exclusive cores, which is helpful for CPU-sensitive Redis workloads. Use this selectively — over-allocating exclusive CPUs wastes capacity.

#### Single-threaded vs. multi-threaded sizing

Redis is fundamentally single-threaded for command execution. During persistence Redis uses `fork()` to create a child process that writes the RDB file; the parent continues serving requests on its single thread. Setting the per-shard CPU limit to **2 cores** ensures the foreground thread keeps serving traffic during persistence.

If you enable Redis I/O threads (Redis 6.0+), I/O can be parallelized across additional cores. Keep in mind that only some operations (network I/O, certain Lua paths) benefit from threads — most command execution remains single-threaded. Sizing CPUs above 2 cores helps only for workloads with heavy I/O concurrency.

#### Reference benchmark — single-threaded

The figures below are **historical reference numbers** captured on Redis 6.0 with operator v3.14. They illustrate the shape of single-thread vs I/O-thread scaling; absolute throughput on current hardware and Redis 7.x will be higher. **Re-run `redis-benchmark` against your actual instance before sizing.**

A Redis instance without I/O threads, exercised with `redis-benchmark` (100 concurrent connections, 100,000 requests each, 50% SET / 50% GET):

| CPU cores | Throughput (ops/sec) |
| --- | --- |
| 1 | 47,760 |
| 2 | 50,143 |
| 4 | 51,443 |
| 8 | 50,440 |

Beyond 2 cores there is essentially no improvement.

#### Reference benchmark — I/O threads enabled

Same workload, 4 vCPU / 8 GB instance, varying the number of I/O threads:

| Threads | Throughput (ops/sec) |
| --- | --- |
| 1 | 51,847 |
| 2 | 77,374 |
| 4 | 115,934 |
| 8 | 138,089 |

I/O threads can substantially raise throughput, but real-world gains depend on workload, payload size, and network. Validate with your own benchmarks.

:::tip
Pin per-shard CPU at 2 cores by default. Increase it only when you have benchmarked your workload with I/O threads enabled and confirmed the gain.
:::

### Disk

By default, the operator sets the persistent volume size to twice `maxmemory`. This is a reasonable starting point but does **not** guarantee enough space for every workload. RDB and AOF file sizes depend on actual memory usage and write patterns, not on the `maxmemory` cap.

If memory utilization is high, the persistence files grow correspondingly. Watch your disk usage and either increase the PVC size or adjust the data model (TTLs, more efficient encodings) before disk pressure causes outages.

#### RDB load and save reference

Historical reference data (Redis 6.0, operator v3.14) — measured on an HDD with sequential read 1117 MiB/s and write 772 MiB/s. Use the table to estimate the **shape** of load/save time as a function of dataset size. SSD-backed storage and Redis 7.x both reduce these times substantially; benchmark on your own storage before relying on absolute values:

| RDB size | Load time | Save time |
| --- | --- | --- |
| 7.6 GB (8.77 GB used memory) | 52.83 s | 59.77 s |
| 6.7 GB (7.10 GB used memory) | 27.66 s | 52.72 s |
| 5.7 GB | 24.05 s | 43.09 s |
| 4.8 GB | 18.61 s | 36.84 s |
| 3.8 GB | 14.51 s | 29.86 s |
| 2.9 GB | 10.78 s | 22.24 s |

Use these numbers to size your pod startup probe delays and `preStop` grace periods. For example, with an RDB around 7.6 GB, allow at least 60 seconds for the pod to load and another 60 seconds before forced termination so Redis can persist its dataset cleanly. Scale these values up as your dataset grows.

## Deployment

### Operator Topology

Redis Operator can be deployed in two modes:

- **Cluster mode.** A single operator manages instances in any namespace.
- **Namespace mode.** Operator instances are scoped to specific namespaces, useful for strong tenant isolation.

Pick the mode that matches your tenancy model.

### Creating Instances

In **Data Services**, choose **Redis**, select your **project** and **namespace**, then click **Create Redis Instance** and configure for your workload. The current operator ships Redis 6.0 and Redis 7.x; choose the latest version your applications support.

#### Choosing a Parameter Template

The platform ships three families of parameter templates (one per Redis minor version) for the most common workload patterns. The names below use a `<persistence>-<redis-version>-<topology>` convention — for example `rdb-redis-6.0-sentinel`, `aof-redis-7.2-cluster`. Match the Redis version of your instance to the template version.

| Family | Description | `save` | `appendonly` | `repl-backlog-size` | `appendfsync` |
| --- | --- | --- | --- | --- | --- |
| `rdb-*` | RDB persistence. Periodic binary snapshots. Suitable when resources are limited but you can tolerate up to a few minutes of data loss. Redis can serve as the source of truth. | `60 10000 300 100 600 1` | `no` | | |
| `diskless-*` | Persistence disabled. Redis is used purely as a cache, all data lives in memory and is lost on restart. Best for high-throughput, ephemeral workloads. | — | `no` | `50mb` | |
| `aof-*` | AOF persistence. Every write is appended to a log, then replayed on restart. Suitable for resource-rich workloads where data durability is the priority. | — | `yes` | | `everysec` |

#### Resource Specification Reference

The following table summarizes recommended resource sizing across architectures, persistence modes, and instance sizes. The numbers below were last validated on operator **v3.14**; container limits shipped by current releases (v3.18+) may differ slightly. Treat the values as a starting point and verify against your installed operator's defaults.

| Architecture | Persistence | Template | Instance size | Replicas | Sentinel | Shards | redis-exporter limits | Sentinel container limits | Redis container limits | Backup container | Total resources | Instance storage | Auto backup storage (7 retained) | Manual backup storage (7 retained) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sentinel | AOF | aof-redis-6.0-sentinel | 2c4g | 1 | 3 | / | 100m / 128Mi | 100m / 200Mi | 2c4g | unlimited (reserve capacity) | 4.5c / 4.8g | sized to write volume | | |
| Sentinel | AOF | aof-redis-6.0-sentinel | 4c8g | 1 | 3 | / | 100m / 128Mi | 100m / 200Mi | 4c8g | unlimited (reserve capacity) | 8.5c / 8.8g | sized to write volume | | |
| Sentinel | RDB | rdb-redis-6.0-sentinel | 2c4g | 1 | 3 | / | 100m / 128Mi | 100m / 200Mi | 2c4g | unlimited (reserve capacity) | 4.5c / 4.8g | 8 GB | 28 GB | 28 GB |
| Sentinel | RDB | rdb-redis-6.0-sentinel | 4c8g | 1 | 3 | / | 100m / 128Mi | 100m / 200Mi | 4c8g | unlimited (reserve capacity) | 8.5c / 8.64g | 16 GB | 56 GB | 56 GB |
| Sentinel | Diskless | diskless-redis-6.0-sentinel | 2c4g | 1 | 3 | / | 100m / 128Mi | 100m / 200Mi | 2c4g | / | 4.5c / 4.8g | / | 28 GB | 28 GB |
| Sentinel | Diskless | diskless-redis-6.0-sentinel | 4c8g | 1 | 3 | / | 100m / 128Mi | 100m / 200Mi | 4c8g | / | 8.5c / 8.8g | / | 56 GB | 56 GB |
| Cluster | AOF | aof-redis-6.0-cluster | 2c4g | / | 3 | / | 100m / 300Mi | / | 2c4g | unlimited (reserve capacity) | 12.6c / 25.8g | sized to write volume | | |
| Cluster | AOF | aof-redis-6.0-cluster | 4c8g | / | 3 | / | 100m / 300Mi | / | 4c8g | unlimited (reserve capacity) | 24.6c / 49.8g | sized to write volume | | |
| Cluster | RDB | rdb-redis-6.0-cluster | 2c4g | / | 3 | / | 100m / 300Mi | / | 2c4g | unlimited (reserve capacity) | 12.6c / 25.8g | 24 GB | 84 GB | 84 GB |
| Cluster | RDB | rdb-redis-6.0-cluster | 4c8g | / | 3 | / | 100m / 300Mi | / | 4c8g | unlimited (reserve capacity) | 24.6c / 49.8g | 48 GB | 168 GB | 168 GB |
| Cluster | Diskless | diskless-redis-6.0-cluster | 2c4g | / | 3 | / | 100m / 300Mi | / | 2c4g | / | 12.6c / 25.8g | / | 84 GB | 84 GB |
| Cluster | Diskless | diskless-redis-6.0-cluster | 4c8g | / | 3 | / | 100m / 300Mi | / | 4c8g | / | 24.6c / 49.8g | / | 168 GB | 168 GB |

#### Scheduling and Anti-Affinity

Cluster mode supports three recommended anti-affinity strategies:

- **All-pod hard anti-affinity.** Every Redis pod must run on a different node. Provides the strongest fault isolation but requires at least as many nodes as pods. Deployment fails when nodes are insufficient.
- **In-shard hard anti-affinity.** Primary and replica of the same shard must run on different nodes; pods from different shards may co-locate. Protects against single-node failures while requiring fewer nodes.
- **In-shard soft anti-affinity.** Primary and replica should run on different nodes when possible, but may co-locate when resources are tight. Maximizes deployability at the cost of weaker isolation.

| Strategy | Description | Pros | Cons | Self-healing on single failure | Data integrity on node failure |
| --- | --- | --- | --- | --- | --- |
| All-pod hard anti-affinity | All pods must be on different nodes | Best HA and load balance | Deployment fails when nodes are scarce | Guaranteed | Intact when failed nodes < replicas |
| In-shard hard anti-affinity | Primary and replica of same shard must be on different nodes | Strong fault isolation per shard | Deployment fails when nodes are scarce | Possible | Intact when failed nodes < replicas |
| In-shard soft anti-affinity | Primary and replica should be on different nodes; co-location allowed if needed | Adapts to limited capacity | Weaker isolation when co-located | Possible | Possibly intact |

In sentinel mode, the default scheduling strategy is **in-shard soft anti-affinity** — primary and replica are spread across nodes when possible but may co-locate to allow deployment on smaller clusters. For production sentinel workloads, prefer hard anti-affinity if your node capacity allows.

## Application Integration

### Access Modes

Pick the connection mode that matches your topology.

| Architecture | Access mode | Recommended endpoint | Notes |
| --- | --- | --- | --- |
| Sentinel | In-cluster access | Sentinel address | Clients connect to the Sentinel address (default port `26379`) and discover the data nodes through Sentinel. |
| Sentinel | External access | NodePort on data nodes + NodePort on Sentinel | Sentinel only handles discovery, so the data-node ports must also be exposed. Clients connect to the Sentinel NodePort. |
| Cluster | In-cluster access | Headless Service (per-node) | Clients use the Service DNS to discover all cluster nodes (default port `6379`). Connections may resolve to any pod, so the client must be cluster-aware to follow `MOVED` redirects. |
| Cluster | External access (no proxy) | NodePort on each data node | Clients connect directly to the data nodes using multiple NodePorts. Provides resilience without a proxy, but the client must be cluster-aware and configured with multiple endpoints. |

### Client Configuration Example

The reference client used in our internal tests is the `jedis` Java client:

```xml
<dependency>
  <groupId>redis.clients</groupId>
  <artifactId>jedis</artifactId>
  <version>3.7.0</version>
</dependency>
```

When connecting to a Redis Cluster, configure the client in cluster mode and provide all cluster endpoints — for example with Spring Boot:

```yaml
spring:
  redis:
    cluster:
      nodes: <node-1-host>:<port>,<node-2-host>:<port>,<node-3-host>:<port>
```

A non-cluster-aware client connecting to a Cluster instance fails with errors such as `ERR SELECT is not allowed in cluster mode` or `MOVED <slot> <host:port>`. See the troubleshooting article for cluster mode connection errors.

## Operations

### Backup

The platform Backup Center provides a unified place to schedule, run, and manage backups across Redis instances. It supports external S3 storage as a backup destination, scheduled and on-demand backups, restore from history, and retention management. See the backup-and-restore solutions for the procedure for each architecture.

### Common Issues

Check the platform knowledge base for known issues and FAQs covering topics such as cluster mode connectivity, monitoring, crash recovery, taint tolerance, and deployment optimization.

## References

- Redis memory optimization: https://docs.redis.com/latest/ri/memory-optimizations/
- Redis architecture deep dive: https://architecturenotes.co/redis/
- Redis documentation: https://redis.io/docs/

## Important Considerations

- **Cap shard memory at 8 GB.** Above this point Redis tail latency degrades and persistence operations become expensive.
- **Match parameter template to durability needs.** Use RDB as the default; switch to AOF only when you cannot tolerate any data loss; use diskless when Redis is purely a cache.
- **Plan disk for actual usage, not `maxmemory`.** Twice `maxmemory` is a starting point; monitor real consumption.
- **Choose anti-affinity according to node capacity.** Hard anti-affinity is the safer default but requires enough nodes; soft is acceptable when capacity is the binding constraint.
- **Cluster mode requires cluster-aware clients.** Confirm the client and connection string before going live to avoid `MOVED` and `SELECT` errors.
- **Use Sentinel addresses, not data-node addresses, for sentinel-mode clients.** Otherwise failover will not be transparent.
