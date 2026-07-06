---
products:
  - Alauda Application Services
kind:
  - Solution
id: KB260700005
sourceSHA: aeddae179c76f350b873471630da9d4254d81ba485534dcb8dcb86be0170dcdd
---

# OpenSearch 尺寸和容量规划指南

:::info
适用版本：OpenSearch Operator \~= 2.8.x, OpenSearch \~= 2.19.3 / 3.3.1
:::

## 概述

在部署之前正确地确定 OpenSearch 集群的大小可以防止资源不足（导致不稳定、查询缓慢和写入被拒绝）和资源过剩（浪费集群资源）。本指南提供了一种可重复的尺寸方法，适用于在 Alauda 容器平台上使用 OpenSearch Kubernetes Operator 创建的集群。

由于 Operator 上的 OpenSearch 运行在 Kubernetes 上，集群容量以 **节点池资源请求/限制和 PVC 磁盘大小** (`spec.nodePools[]`) 表示。以下部分依次介绍存储、分片和计算。

> \[!NOTE]
> 尺寸确定是一个 **估算，然后测量** 的过程。使用下面的公式获得一个安全的起始点，然后使用代表性数据进行基准测试并进行调整。请参见 [测试和迭代](#testing-and-iteration)。

## 尺寸工作流程

确定 OpenSearch 集群的大小遵循三个步骤，按顺序进行：

1. **[估算存储](#step-1-estimate-storage-requirements)** — 集群上数据实际需要多少磁盘，包括副本和开销。
2. **[选择分片](#step-2-choose-shard-count-and-size)** — 如何将存储分割成分片以实现均匀分布和健康性能。
3. **[选择节点和资源](#step-3-choose-node-count-and-resources)** — 每个节点池需要多少节点以及每个节点的 CPU / 内存 / 磁盘。

## 第一步：估算存储需求

您必须提供的磁盘总是大于原始源数据。OpenSearch 存储副本、倒排索引，并为内部操作保留空间，而 Linux 在文件系统级别保留空间。

### 存储公式

```text
最低存储要求 =
    源数据
    × (1 + 副本数量)
    × (1 + 索引开销)
    ÷ (1 - Linux 保留空间)
    ÷ (1 - 保留余量)
```

| 因素                 | 典型值                     | 说明                                                                                                                                                                                               |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 副本数量             | `1`（默认，HA 的最低值）    | 每个副本是主数据的完整副本。                                                                                                                                                                      |
| 索引开销             | `10%`（`× 1.10`）          | 磁盘上的倒排索引通常比源数据大约 \~10%。如果有许多索引字段，可能会更高。                                                                                                                         |
| Linux 保留空间      | `5%`（`÷ 0.95`）           | Linux 为 `root` 用户保留每个文件系统的 \~5%。                                                                                                                                                     |
| 保留余量             | `20%`（`÷ 0.80`）          | 一旦节点的磁盘超过 **低水位线**（默认 85%），OpenSearch 将停止在该节点上放置分片；段合并也需要临时的可用空间。预算 \~20% 可以保持节点远离水位线。 |

### 简化规则

对于常见情况（1 个副本，默认开销），这些因素简化为一个乘数 **\~1.45**：

```text
最低存储要求 ≈ 源数据 × (1 + 副本数量) × 1.45
```

**示例** — 66 GiB 的源数据，1 个副本：

```text
66 × (1 + 1) × 1.10 ÷ 0.95 ÷ 0.80 = 191 GiB
# 或者，简化为：
66 × 2 × 1.45 ≈ 191 GiB
```

> \[!NOTE]
> 始终为 **未来数据** 进行尺寸规划，而不仅仅是今天的数据。如果预计数据集会增长（例如，日志保留在 N 天内累积），请将预计总量插入 `源数据`，或添加明确的增长余量。

## 第二步：选择分片数量和大小

每个索引被分割成 **主分片**；每个主分片可以有 **副本分片**。分片是分布和并行的单位。分片过少会导致节点利用不足；分片过多会浪费 CPU 和堆内存。

### 目标分片大小

| 工作负载类型                                | 推荐分片大小           | 原因                                                     |
| -------------------------------------------- | ---------------------- | -------------------------------------------------------- |
| 搜索密集型（延迟敏感）                        | **10–30 GiB**          | 较小的分片返回结果更快。                                 |
| 日志/写入密集型（例如可观察性、SIEM）        | **30–50 GiB**          | 较大的分片减少高吞吐量摄取的开销。                       |

保持分片在 **10–50 GiB** 之间。避免大于 50 GiB 的分片（恢复/重平衡缓慢）和大量小分片（堆内存和 CPU 浪费）。

### 主分片数量

```text
近似主分片数量 =
    (源数据 + 增长余量) × (1 + 索引开销) ÷ 目标分片大小
```

**示例** — 今天 66 GiB，预计在一年内增长 4 倍，目标 30 GiB 分片：

```text
(66 + 198) × 1.10 ÷ 30 ≈ 10 个主分片
```

### 每节点分片限制

节点可以容纳的分片数量受其 **JVM 堆** 限制：

> **≤ 每 1 GiB JVM 堆 25 个分片**（主分片 + 副本，跨所有索引）。

例如，具有 16 GiB 堆的数据节点最多应承载 **\~400 个分片**。

> \[!NOTE]
> 自管理的 OpenSearch（由此 Operator 部署）默认设置为 `cluster.max_shards_per_node = 1000` — 每个节点 **固定 1,000**，与堆大小无关。“每 16 GiB 堆 1,000，最多 4,000 个分片”的行为适用于托管的 OpenSearch 服务，不适用于自管理的集群。实际上，保持目标 **≤ 每 GiB JVM 堆 25 个分片**。

> \[!WARNING]
> 分片数量是由集群管理器跟踪的集群范围状态。具有数万个小分片的集群可能会变得不稳定，无论数据量如何。更倾向于在 10–50 GiB 范围内使用较少的较大分片。

## 第三步：选择节点数量和资源

### 最小节点数量

| 组件                      | 最小                       | 推荐                                                         |
| ------------------------- | -------------------------- | ------------------------------------------------------------ |
| 集群管理器（主节点）      | 3                          | 始终为 **奇数**（3、5、7），以维持法定人数并避免脑裂。       |
| 数据节点                  | 2（具有专用管理器）        | 随着数据量水平扩展；至少等于您的副本数量 + 1。               |
| 专用集群管理器            | —                          | 一旦您有 **> 5 个数据节点** 或运行生产工作负载时推荐。      |

> \[!WARNING]
> 默认情况下，Operator 不设置任何 Pod 反亲和性。在生产环境中，您 **必须** 明确配置每个节点池的 `affinity`（Pod 反亲和性）或 `topologySpreadConstraints`，以将池的 Pods 分散到不同的 Kubernetes 节点/可用区 — 否则所有 3 个 `cluster_manager` Pods 可能会落在一个节点上，单个节点故障会失去法定人数。这在节点本地存储（例如 TopoLVM）中至关重要：卷无法跨节点迁移，因此一个永久故障的节点依赖 OpenSearch 副本重建数据。请参见 [参考尺寸配置文件](#reference-sizing-profiles) 以获取示例。

### CPU 和内存比例

计算需求随着存储、分片数量和查询复杂性而增加。使用每节点存储量推导出起始计算分配：

| 工作负载配置                                                  | 比例（每 100 GiB 存储数据的节点） |
| ------------------------------------------------------------ | ---------------------------------- |
| 标准（日志摄取、归档、简单查询）                              | **\~1 vCPU + 4 GiB 内存**         |
| 重型（许多分片、频繁更新、聚合、重搜索）                      | **\~2 vCPU + 8 GiB 内存**         |

> \[!TIP]
> 参考配置将 CPU `limit == request` 设置为可预测的 QoS。对于这种延迟敏感的工作负载，严格的 CPU **限制** 可能会在突发查询负载下导致 CFS 限流。如果您观察到限流，请考虑 **提高或移除 CPU `limit`**，同时保持内存 `limit == request`（内存必须保持有界以避免 OOM 驱逐）。

### JVM 堆

- 设置 JVM 堆 (`spec.nodePools[].jvm`，例如 `-Xmx8G -Xms8G`) 为 **池内存的 50%**。如果 `jvm` 未设置，Operator 会自动计算堆为 **内存 `request` ÷ 2** — 因此请保持内存 `request` 等于 `limit`（如下面的每个配置所示），以便这也为限制的一半。
- **绝不要超过 \~32 GiB** 的堆 — 超过此限制，JVM 将失去压缩对象指针，浪费内存。如果节点需要超过 64 GiB 的 RAM，请添加节点而不是增加堆。

### 每节点存储

将总存储需求（第一步）分配到数据节点：

```text
每个数据节点的磁盘大小 = 最低存储要求 ÷ 数据节点数量
```

保持每节点磁盘可管理（通常 ≤ \~1.5–2 TiB 每个数据节点），以便分片恢复和重平衡保持快速。

## 参考尺寸配置文件

以下节点池配置是安全的起始点。使用上述公式调整 `diskSize`、`replicas` 和 `resources`，然后进行基准测试。

> \[!NOTE]
> **主机前提条件：** OpenSearch 在每个工作节点上需要 `vm.max_map_count = 262144`。默认情况下，Operator 的初始化容器会自动设置此值；在限制的 Pod 安全准入环境中，如果该初始化容器被禁用，请提前在主机上设置（请参见 OpenSearch 安装指南）。

> \[!NOTE]
> 下面的 YAML 块是 `spec.nodePools[]` 下的 **片段**。它们属于完整的 `OpenSearchCluster` 资源的 `spec:` 下，不能作为独立清单进行 `apply`。
>
> 对于生产环境，向 **每个** 池添加拓扑扩展约束，以便其 Pods 分布在节点/区域之间（根据上面的 [HA 调度警告](#step-3-choose-node-count-and-resources)）：
>
> ```yaml
>     topologySpreadConstraints:
>       - maxSkew: 1
>         topologyKey: kubernetes.io/hostname   # 或 topology.kubernetes.io/zone
>         whenUnsatisfiable: DoNotSchedule
>         labelSelector:
>           matchLabels:
>             # Operator 将每个 Pod 标记为其节点池（组件）和集群。
>             opster.io/opensearch-nodepool: <池的组件，例如 masters / data / hot-data / coordinators>
>             opster.io/opensearch-cluster: <集群名称>   # 可选；当集群共享命名空间时的范围
> ```
>
> 通过 `opster.io/opensearch-nodepool` 标签（设置在 **每个** Pod 上）选择 Pods，而不是 `opensearch.role` — Operator 仅将 `opensearch.role` 应用于主 Pods，因此基于角色的选择器将默默匹配数据/摄取/协调池中的内容并使其未分散。

### 小型 — 开发/轻量生产

\~270 GiB 总提供磁盘（3 × 90 GiB），查询负载低。组合角色。

```yaml
nodePools:
  - component: nodes
    replicas: 3
    diskSize: "90Gi"
    persistence:
      pvc:
        accessModes: ["ReadWriteOnce"]
        storageClass: sc-topolvm
    jvm: -Xmx4G -Xms4G
    resources:
      requests: { memory: "8Gi", cpu: "2000m" }
      limits:   { memory: "8Gi", cpu: "2000m" }
    roles:
      - "cluster_manager"
      - "data"
      - "ingest"
```

### 中型 — 生产

\~1–3 TiB 提供存储。专用集群管理器，单独的数据节点。

```yaml
nodePools:
  - component: masters
    replicas: 3
    diskSize: "20Gi"
    persistence:
      pvc:
        accessModes: ["ReadWriteOnce"]
        storageClass: sc-topolvm
    jvm: -Xmx2G -Xms2G
    resources:
      requests: { memory: "4Gi", cpu: "1000m" }
      limits:   { memory: "4Gi", cpu: "1000m" }
    roles:
      - "cluster_manager"

  - component: data
    replicas: 6
    diskSize: "500Gi"
    persistence:
      pvc:
        accessModes: ["ReadWriteOnce"]
        storageClass: sc-topolvm
    jvm: -Xmx16G -Xms16G
    resources:
      requests: { memory: "32Gi", cpu: "8000m" }
      limits:   { memory: "32Gi", cpu: "8000m" }
    roles:
      - "data"
      - "ingest"
```

### 大型 — 高规模生产

多 TiB，重搜索或高吞吐量摄取。完全角色分离，具有热数据和协调节点。

```yaml
nodePools:
  - component: masters
    replicas: 3
    diskSize: "30Gi"
    persistence:
      pvc:
        accessModes: ["ReadWriteOnce"]
        storageClass: sc-topolvm
    jvm: -Xmx4G -Xms4G
    resources:
      requests: { memory: "8Gi", cpu: "2000m" }
      limits:   { memory: "8Gi", cpu: "2000m" }
    roles:
      - "cluster_manager"

  - component: hot-data
    replicas: 12
    diskSize: "1Ti"
    persistence:
      pvc:
        accessModes: ["ReadWriteOnce"]
        storageClass: sc-topolvm
    jvm: -Xmx31G -Xms31G
    resources:
      requests: { memory: "64Gi", cpu: "16000m" }
      limits:   { memory: "64Gi", cpu: "16000m" }
    roles:
      - "data"
      - "ingest"

  - component: coordinators
    replicas: 3
    diskSize: "20Gi"
    persistence:
      pvc:
        accessModes: ["ReadWriteOnce"]
        storageClass: sc-topolvm
    jvm: -Xmx8G -Xms8G
    resources:
      requests: { memory: "16Gi", cpu: "8000m" }
      limits:   { memory: "16Gi", cpu: "8000m" }
    roles: []   # 空角色 = 仅协调
```

## 实例分析

**需求：** 2 TiB（2048 GiB）的源日志数据，1 个副本，日志密集型工作负载，预计在下一年增长 \~50%。

1. **存储** — 根据预计总量进行尺寸规划（2048 × 1.5 ≈ 3072 GiB）：

   ```text
   3072 × 2 × 1.45 ≈ 8,909 GiB ≈ 8.7 TiB 提供
   ```

2. **分片** — 日志工作负载，目标 40 GiB 分片：

   ```text
   3072 × 1.10 ÷ 40 ≈ 85 个主分片（+ 85 个副本 = 170 个总分片）
   ```

3. **节点** — 将 8.7 TiB 分散到每个 ≤ \~1 TiB 的数据节点 → **9 个数据节点**（向上取整以留出余量至 10），每个 `diskSize: ~900Gi`。

   - 标准日志配置：每 100 GiB \~1 vCPU + 4 GiB → 每个 \~900 GiB 节点约 \~9 vCPU / 36 GiB。四舍五入至 **8 vCPU / 32 GiB**（堆 `-Xmx16G`）。
   - 每节点分片：170 ÷ 10 = 17 个分片/节点，远低于每 GiB 堆 25 个分片的限制（16 GiB 堆 → 400 个分片预算）。✓
   - 添加 **3 个专用集群管理器**。

这将产生一个 3 个管理器 + 10 个数据节点的集群 — 通过基准测试进行细化。

## 测试和迭代

公式提供了一个起始点；实际工作负载差异很大。在部署估算的集群后：

1. 使用您的实际索引映射和分片数量加载代表性数据。

2. 运行代表性的查询/摄取负载 — 使用 [OpenSearch Benchmark](https://github.com/opensearch-project/opensearch-benchmark)。

3. 监控集群健康和每节点指标。通过 Operator 创建的 `<cluster>-admin-password` 密钥读取管理员密码，而不是硬编码：

   ```bash
   PASSWORD=$(kubectl get secret <cluster>-admin-password -n <namespace> \
     -o jsonpath='{.data.password}' | base64 -d)

   kubectl exec -n <namespace> <cluster>-<component>-0 -- \
     curl -sk -u "admin:${PASSWORD}" 'https://localhost:9200/_cluster/health?pretty'
   ```

   > `-k` 在这里是安全的 — 它仅跳过对 Pod 自签名证书的验证。

4. 如果 **CPU 利用率** 或 **JVM 内存压力** 保持高位，请增加节点 `resources` 或添加数据节点 `replicas`。如果节点处于空闲状态，请缩减以提高效率。

> \[!TIP]
> 开始时略大于估算值，然后在测量到实际余量后缩减至高效配置 — 这比在实时集群中资源不足更安全。

> \[!WARNING]
>
> - 在 **缩减数据节点** 之前，设置 `spec.confMgmt.smartScaler: true`。否则，Operator **在未先排空分片的情况下删除节点**，可能导致数据丢失或副本不足。
> - `diskSize` 是 **仅增长**（Kubernetes 不支持 PVC 缩小），扩展需要 StorageClass 设置 `allowVolumeExpansion: true`。`sc-topolvm` 是一个示例 StorageClass 名称 — 请将其替换为您环境中存在的名称。

## 最佳实践总结

| 维度              | 指导原则                                                                          |
| ------------------ | --------------------------------------------------------------------------------- |
| 存储              | 提供 `source × (1 + replicas) × 1.45`；为预计数据而非当前数据进行尺寸规划。      |
| 副本              | 生产高可用性至少 1 个。                                                           |
| 分片大小          | 10–30 GiB（搜索）/ 30–50 GiB（日志）；保持在 10–50 GiB 之间。                    |
| 每节点分片        | ≤ 每 GiB JVM 堆 25 个分片。                                                       |
| 集群管理器        | 奇数数量（3/5/7）；当数据节点 > 5 时专用。                                        |
| JVM 堆            | 容器内存的 50%，绝不要超过 \~32 GiB。                                             |
| 计算              | 每 100 GiB 存储 \~1 vCPU + 4 GiB（标准）到 \~2 vCPU + 8 GiB（重型）。              |
| 每节点磁盘        | 保持 ≤ \~1.5–2 TiB，以便快速恢复/重平衡。                                        |
| 方法              | 估算 → 基准测试 → 调整。                                                          |

## 参考文献

1. [OpenSearch — 确定您的集群大小](https://docs.opensearch.org/latest/tuning-your-cluster/)
2. [OpenSearch — 分片策略和索引管理](https://docs.opensearch.org/latest/tuning-your-cluster/availability-and-recovery/index/)
3. [OpenSearch 安装指南](./OpenSearch_Installation_Guide.md)
4. [OpenSearch 基准测试](https://github.com/opensearch-project/opensearch-benchmark)
