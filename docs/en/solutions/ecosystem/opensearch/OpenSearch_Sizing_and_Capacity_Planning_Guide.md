---
products:
  - Alauda Application Services
kind:
  - Solution
---

# OpenSearch Sizing and Capacity Planning Guide

:::info
Applicable Version: OpenSearch Operator ~= 2.8.x, OpenSearch ~= 2.19.3 / 3.3.1
:::

## Overview

Correctly sizing an OpenSearch cluster before deployment prevents both under-provisioning (leading to instability, slow queries, and rejected writes) and over-provisioning (wasting cluster resources). This guide provides a repeatable sizing methodology for clusters created with the OpenSearch Kubernetes Operator on the Alauda Container Platform.

Because OpenSearch on the operator runs on Kubernetes, cluster capacity is expressed as **node pool resource requests/limits and PVC disk sizes** (`spec.nodePools[]`). The sections below walk through storage, shards, and compute in turn.

> [!NOTE]
> Sizing is an **estimate, then measure** exercise. Use the formulas below to obtain a safe starting point, then benchmark with representative data and adjust. See [Testing and Iteration](#testing-and-iteration).

## The Sizing Workflow

Sizing an OpenSearch cluster follows three steps, in order:

1. **[Estimate storage](#step-1-estimate-storage-requirements)** — how much disk the data actually needs on the cluster, including replicas and overhead.
2. **[Choose shards](#step-2-choose-shard-count-and-size)** — how to split that storage into shards for even distribution and healthy performance.
3. **[Choose nodes and resources](#step-3-choose-node-count-and-resources)** — how many nodes and how much CPU / memory / disk per node pool.

## Step 1: Estimate Storage Requirements

The disk you must provision is always larger than your raw source data. OpenSearch stores replicas, an inverted index, and reserves space for internal operations, while Linux reserves space at the filesystem level.

### Storage Formula

```text
Minimum storage requirement =
    Source data
    × (1 + number of replicas)
    × (1 + indexing overhead)
    ÷ (1 - Linux reserved space)
    ÷ (1 - OpenSearch internal overhead)
```

| Factor | Typical value | Explanation |
|--------|---------------|-------------|
| Number of replicas | `1` (default, minimum for HA) | Each replica is a full copy of the primary data. |
| Indexing overhead | `10%` (`× 1.10`) | The on-disk inverted index is typically ~10% larger than the source. Can be higher with many indexed fields. |
| Linux reserved space | `5%` (`÷ 0.95`) | Linux reserves ~5% of each filesystem for the `root` user. |
| OpenSearch internal overhead | `20%` (`÷ 0.80`), capped at 20 GiB per node | Reserved for segment merges, logs, and internal operations. |

### Simplified Rule

For the common case (1 replica, default overheads), the factors collapse to a single multiplier of **~1.45**:

```text
Minimum storage requirement ≈ Source data × (1 + number of replicas) × 1.45
```

**Example** — 66 GiB of source data with 1 replica:

```text
66 × (1 + 1) × 1.10 ÷ 0.95 ÷ 0.80 = 191 GiB
# or, simplified:
66 × 2 × 1.45 ≈ 191 GiB
```

> [!NOTE]
> Always size for **future data**, not just today's. If the dataset is expected to grow (for example, log retention accumulating over N days), plug the projected total into `Source data`, or add explicit growth headroom.

## Step 2: Choose Shard Count and Size

Each index is split into **primary shards**; each primary can have **replica shards**. Shards are the unit of distribution and parallelism. Too few shards under-utilizes nodes; too many wastes CPU and heap on overhead.

### Target Shard Size

| Workload type | Recommended shard size | Rationale |
|---------------|------------------------|-----------|
| Search-heavy (latency-critical) | **10–30 GiB** | Smaller shards return results faster. |
| Log / write-heavy (e.g. observability, SIEM) | **30–50 GiB** | Larger shards reduce overhead for high-throughput ingest. |

Keep shards within **10–50 GiB**. Avoid shards larger than 50 GiB (slow recovery/rebalancing) and swarms of tiny shards (heap and CPU waste).

### Number of Primary Shards

```text
Approximate primary shards =
    (Source data + growth headroom) × (1 + indexing overhead) ÷ desired shard size
```

**Example** — 66 GiB today, expected to grow 4× over a year, targeting 30 GiB shards:

```text
(66 + 198) × 1.10 ÷ 30 ≈ 10 primary shards
```

### Shards Per Node Limit

The number of shards a node can hold is bounded by its **JVM heap**:

> **≤ 25 shards per 1 GiB of JVM heap** (primary + replica, across all indices on that node).

For example, a data node with 16 GiB heap should host at most **~400 shards**.

> [!NOTE]
> Self-managed OpenSearch (deployed by this operator) defaults to `cluster.max_shards_per_node = 1000` — a **flat 1,000 per node**, independent of heap size. The "1,000 per 16 GiB heap, up to 4,000 per node" behavior belongs to managed OpenSearch services and does **not** apply to self-managed clusters. In practice, keep targeting **≤ 25 shards per GiB of JVM heap**.

> [!WARNING]
> Shard count is cluster-wide state tracked by the cluster manager. A cluster with tens of thousands of tiny shards can become unstable regardless of data volume. Prefer fewer, larger shards within the 10–50 GiB band.

## Step 3: Choose Node Count and Resources

### Minimum Node Counts

| Component | Minimum | Recommendation |
|-----------|---------|----------------|
| Cluster manager (master) | 3 | Always an **odd number** (3, 5, 7) to maintain quorum and avoid split-brain. |
| Data nodes | 2 (with dedicated managers) | Scale horizontally with data volume; at least equal to your replica count + 1. |
| Dedicated cluster managers | — | Recommended once you have **> 5 data nodes** or run production workloads. |

> [!WARNING]
> The operator sets **no** pod anti-affinity by default. In production you **must** explicitly configure `affinity` (pod anti-affinity) or `topologySpreadConstraints` on each node pool to spread a pool's pods across different Kubernetes nodes / availability zones — otherwise all 3 `cluster_manager` pods may land on one node, and a single node failure loses quorum. This is critical with node-local storage (e.g. TopoLVM): volumes cannot migrate across nodes, so a permanently failed node relies on OpenSearch replicas to rebuild data. See [Reference Sizing Profiles](#reference-sizing-profiles) for an example.

### CPU and Memory Ratios

Compute needs scale with storage, shard count, and query complexity. Use storage-per-node to derive a starting compute allocation:

| Workload profile | Ratio (per 100 GiB of stored data on a node) |
|------------------|----------------------------------------------|
| Standard (log ingest, archival, simple queries) | **~1 vCPU + 4 GiB memory** |
| Heavy (many shards, frequent updates, aggregations, heavy search) | **~2 vCPU + 8 GiB memory** |

### JVM Heap

- Set the JVM heap (`spec.nodePools[].jvm`, e.g. `-Xmx8G -Xms8G`) to **50% of the container memory limit**.
- **Never exceed ~32 GiB** of heap — beyond this the JVM loses compressed object pointers, wasting memory. If a node needs more than 64 GiB of RAM, add nodes rather than growing heap.

### Storage Per Node

Divide the total storage requirement (Step 1) across data nodes:

```text
diskSize per data node = Minimum storage requirement ÷ number of data nodes
```

Keep per-node disk manageable (typically ≤ ~1.5–2 TiB per data node) so shard recovery and rebalancing stay fast.

## Reference Sizing Profiles

The following node-pool configurations are safe starting points. Adjust `diskSize`, `replicas`, and `resources` using the formulas above, then benchmark.

> [!NOTE]
> The YAML blocks below are **fragments** under `spec.nodePools[]`. They belong under the `spec:` of a full `OpenSearchCluster` resource and cannot be `apply`-ed as standalone manifests.
>
> For production, add a topology spread constraint to **every** pool so its pods are distributed across nodes / zones (per the [HA scheduling warning](#step-3-choose-node-count-and-resources) above):
>
> ```yaml
>     topologySpreadConstraints:
>       - maxSkew: 1
>         topologyKey: kubernetes.io/hostname   # or topology.kubernetes.io/zone
>         whenUnsatisfiable: DoNotSchedule
>         labelSelector:
>           matchLabels:
>             opensearch.role: <the pool's role, e.g. cluster_manager>
> ```

### Small — Development / Light Production

Up to ~180 GiB provisioned storage, low query load. Combined roles.

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

### Medium — Production

~1–3 TiB provisioned storage. Dedicated cluster managers, separate data nodes.

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

### Large — High-Scale Production

Multi-TiB, heavy search or high-throughput ingest. Full role separation with hot data and coordinating nodes.

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
    roles: []   # empty roles = coordinating-only
```

## Worked Example

**Requirement:** 2 TiB (2048 GiB) of source log data, 1 replica, log-heavy workload, expected to grow ~50% over the next year.

1. **Storage** — size for the projected total (2048 × 1.5 ≈ 3072 GiB):

   ```text
   3072 × 2 × 1.45 ≈ 8,909 GiB ≈ 8.7 TiB provisioned
   ```

2. **Shards** — log workload, target 40 GiB shards:

   ```text
   3072 × 1.10 ÷ 40 ≈ 85 primary shards (+ 85 replica = 170 total)
   ```

3. **Nodes** — spread 8.7 TiB across data nodes at ≤ ~1 TiB each → **9 data nodes** (round up for headroom to 10), each `diskSize: ~900Gi`.

   - Standard log profile: ~1 vCPU + 4 GiB per 100 GiB → each ~900 GiB node ≈ 9 vCPU / 36 GiB. Round to **8 vCPU / 32 GiB** (heap `-Xmx16G`).
   - Shards per node: 170 ÷ 10 = 17 shards/node, well under the 25-per-GiB-heap limit (16 GiB heap → 400 shard budget). ✓
   - Add **3 dedicated cluster managers**.

This yields a 3-manager + 10-data-node cluster — refine by benchmarking.

## Testing and Iteration

Formulas give a starting point; real workloads vary widely. After deploying your estimated cluster:

1. Load representative data with your real index mappings and shard counts.
2. Run representative query/ingest load — use [OpenSearch Benchmark](https://github.com/opensearch-project/opensearch-benchmark).
3. Monitor cluster health and per-node metrics:

   ```bash
   kubectl exec -n <namespace> <cluster>-<pool>-0 -- \
     curl -sk -u admin:<password> 'https://localhost:9200/_cluster/health?pretty'
   ```

4. If **CPU utilization** or **JVM memory pressure** stays high, scale up node `resources` or add data-node `replicas`. If nodes are idle, scale down for efficiency.

> [!TIP]
> Start slightly larger than the estimate, then scale down to an efficient configuration once you have measured real headroom — this is safer than under-provisioning a live cluster.

> [!WARNING]
> - Before **scaling down data nodes**, set `spec.confMgmt.smartScaler: true`. Otherwise the operator **removes nodes without draining shards first**, risking data loss or under-replication.
> - `diskSize` is **grow-only** (Kubernetes does not support PVC shrink), and expansion requires the StorageClass to set `allowVolumeExpansion: true`. `sc-topolvm` is an example StorageClass name — replace it with one that exists in your environment.

## Best Practices Summary

| Dimension | Guideline |
|-----------|-----------|
| Storage | Provision `source × (1 + replicas) × 1.45`; size for projected, not current, data. |
| Replicas | At least 1 for production high availability. |
| Shard size | 10–30 GiB (search) / 30–50 GiB (logs); keep within 10–50 GiB. |
| Shards per node | ≤ 25 shards per GiB of JVM heap. |
| Cluster managers | Odd count (3/5/7); dedicated once > 5 data nodes. |
| JVM heap | 50% of container memory, never above ~32 GiB. |
| Compute | ~1 vCPU + 4 GiB (standard) to ~2 vCPU + 8 GiB (heavy) per 100 GiB stored. |
| Per-node disk | Keep ≤ ~1.5–2 TiB for fast recovery/rebalancing. |
| Method | Estimate → benchmark → adjust. |

## References

1. [OpenSearch — Sizing your cluster](https://docs.opensearch.org/latest/tuning-your-cluster/)
2. [OpenSearch — Shard strategy and index management](https://docs.opensearch.org/latest/tuning-your-cluster/availability-and-recovery/index/)
3. [OpenSearch Installation Guide](./OpenSearch_Installation_Guide.md)
4. [OpenSearch Benchmark](https://github.com/opensearch-project/opensearch-benchmark)
