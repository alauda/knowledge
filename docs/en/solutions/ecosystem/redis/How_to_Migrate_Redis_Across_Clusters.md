---
products:
  - Alauda Application Services
kind:
  - Solution
---

# Migrate Redis Data Across Kubernetes Clusters

:::info Applicable Versions
- Platform: **3.8.x – 3.16.x** (image table below stops at 3.16.2)
:::

## Introduction

This guide explains how to migrate data between Redis instances running in different Kubernetes clusters using the platform's built-in **RedisShake**-based migration feature. The procedure supports the following source/target architecture combinations:

| Architecture | Description |
| --- | --- |
| `standalone` | Single-node Redis |
| `sentinel` | Sentinel-based primary/replica instance |
| `cluster` | Sharded Redis Cluster |

RedisShake performs continuous replication: as long as the source keeps accepting writes, those writes are propagated to the target. Synchronization does not stop on its own.

## Glossary

| Term | Meaning |
| --- | --- |
| Source | The Redis instance whose data is being migrated. |
| Target | The Redis instance that receives the migrated data. |

## Prerequisites

1. **Capacity check.** Ensure the target has enough memory to hold the source dataset:
   - Target is sentinel: target memory should be at least **5/4 of source dataset size**.
   - Target is cluster, source is standalone: target memory should be at least **5/4 of source dataset size**.
   - Target is cluster, source is cluster: target memory should be at least **5/4 of the largest source shard's dataset size**.
   - For acceptable performance, allocate **2-8 vCPU** per RedisShake pod (4 vCPU recommended).
2. **Reduce or pause writes** on the source to lower replication pressure.
3. **Pick the correct RedisShake image** for your platform version (see the [appendix](#appendix-redisshake-image-by-platform-version)).
4. **Network connectivity.** The source and target instances must be reachable from the RedisShake pod over a stable IPv4 network.
5. **Redis version.** The current RedisShake image **does not support Redis 7.x**. Use this method only with Redis 5.x or 6.x source/target instances.

### Known Issues

- On platform versions **3.16.0** and **3.16.1**, when the source is a Sentinel instance, the source instance status may be incorrectly reported as `Processing` even though the instance is healthy. The status reporting is fixed in **3.16.2**.

## Migration Procedure

For every scenario below, you create a single `RedisShake` custom resource. Update the image, source/target addresses, and password Secrets to match your environment, then apply the resource using `kubectl` or the platform UI. To change a configuration after deployment, delete the existing resource and create a new one — in-place edits are not supported.

### 1. Create Password Secrets

If either side is password-protected, create a Kubernetes Secret per side. The Secret must use the data key `password`.

```bash
kubectl -n <namespace> create secret generic <secret-name> \
  --from-literal=password=<password>
```

### 2. Standalone to Sentinel

```yaml
apiVersion: middle.alauda.cn/v1alpha1
kind: RedisShake
metadata:
  name: standalone-to-sentinel
spec:
  image: <redisshake-image>           # See appendix for the right image for your version
  keyExists: rewrite
  modelType: sync
  replicas: 1
  source:
    address:
      - "<source-host>:<source-port>"
    passwordSecret: <source-password-secret>
    type: standalone
  target:
    address:
      - "mymaster@<target-host>:<target-port>"
    passwordSecret: <target-password-secret>
    type: sentinel
```

:::warning
When the **source or target is a Sentinel instance**, the address must be prefixed with `mymaster@`, and the value should be the Sentinel access endpoint. Find it in **Data Services > Instance Detail > Access Method > In-cluster Access / External Access**.
:::

### 3. Sentinel to Sentinel

```yaml
apiVersion: middle.alauda.cn/v1alpha1
kind: RedisShake
metadata:
  name: sentinel-to-sentinel
spec:
  image: <redisshake-image>
  keyExists: rewrite
  modelType: sync
  replicas: 1
  source:
    address:
      - "mymaster@<source-host>:<source-port>"
    passwordSecret: <source-password-secret>
    type: sentinel
  target:
    address:
      - "mymaster@<target-host>:<target-port>"
    passwordSecret: <target-password-secret>
    type: sentinel
```

### 4. Standalone to Cluster

```yaml
apiVersion: middle.alauda.cn/v1alpha1
kind: RedisShake
metadata:
  name: standalone-to-cluster
spec:
  image: <redisshake-image>
  keyExists: rewrite
  modelType: sync
  replicas: 1
  source:
    address:
      - "<source-host>:<source-port>"
    passwordSecret: <source-password-secret>
    type: standalone
  target:
    address:
      - "<target-host>:<target-port>"
    passwordSecret: <target-password-secret>
    type: cluster
```

:::note
For a cluster target, the address can be **any one** of the cluster access endpoints. Find them in **Data Services > Instance Detail > Access Method > In-cluster Access / External Access**.
:::

### 5. Sentinel to Cluster

```yaml
apiVersion: middle.alauda.cn/v1alpha1
kind: RedisShake
metadata:
  name: sentinel-to-cluster
spec:
  image: <redisshake-image>
  keyExists: rewrite
  modelType: sync
  replicas: 1
  resumeFromBreakPoint: false
  source:
    address:
      - "mymaster@<source-host>:<source-port>"
    passwordSecret: <source-password-secret>
    type: sentinel
  target:
    address:
      - "<target-host>:<target-port>"
    passwordSecret: <target-password-secret>
    type: cluster
```

### 6. Cluster to Cluster

```yaml
apiVersion: middle.alauda.cn/v1alpha1
kind: RedisShake
metadata:
  name: cluster-to-cluster
spec:
  image: <redisshake-image>
  keyExists: rewrite
  modelType: sync
  replicas: 1
  source:
    address:
      - "master@<source-host>:<source-port>"
    passwordSecret: <source-password-secret>
    type: cluster
  target:
    address:
      - "<target-host>:<target-port>"
    passwordSecret: <target-password-secret>
    type: cluster
```

:::warning
- When the **source is a cluster**, prefix the address with `master@`. The target cluster address does **not** need this prefix.
- For both source and target clusters, any one of the cluster endpoints is sufficient — RedisShake discovers the rest of the topology automatically.
:::

## Verifying Synchronization

RedisShake performs continuous replication. Even after the initial dataset is copied, replication continues until you delete the `RedisShake` resource. You must therefore verify completion manually.

### Platform Version Below 3.10

There is no monitoring dashboard on these versions. Use a key-count comparison:

1. Run `DBSIZE` on the source. For cluster sources, sum `DBSIZE` across all primaries.
2. Run `DBSIZE` on the target. For cluster targets, sum across all primaries.
3. With writes paused on the source, the totals should match when synchronization is complete.

For cluster mode, the following one-liner returns the total key count across all primaries:

```bash
redis-cli -a <password> --cluster call <host>:<port> dbsize --cluster-only-masters
```

### Platform Version 3.10.2 and Later

The key-count method still works. In addition, a Grafana dashboard **"Redis Shake Dashboard"** is available under **Platform Management > Operations Center > Monitoring > Grafana > Dashboards**.

#### Sentinel Source

- `SyncProcessPercent` — reaches `100` when the initial sync is complete.
- `SlaveDelayOffset` — periodic dips to `0` indicate that the target has caught up. Brief spikes from replication ping packets are expected and not data.

#### Cluster Source

- `SyncProcessPercent` — one progress series per source shard. All shards reaching the completion mark indicates initial sync is done.
- `SlaveDelayOffset` — when the offset reaches `0`, replication is up to date.

## Appendix: RedisShake Image by Platform Version

Use the RedisShake image matching your platform version:

| ACP Version | RedisShake Image |
| --- | --- |
| 3.8.1 - 3.8.3 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2` |
| 3.10.1 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2` |
| 3.10.2, 3.10.3 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.3` |
| 3.12.1 - 3.12.3 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-5ad6d091` |
| 3.14.1, 3.14.2 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-063e3b5d` |
| 3.16.1 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-9bb65a7b` |
| 3.16.2 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-3777a73b` |

## Important Considerations

- **No Redis 7.x support.** Use a different migration path (for example RDB export/import) for Redis 7.x source or target.
- **Replication never stops automatically.** Always validate completion before cutover and delete the `RedisShake` resource when migration is finished.
- **Pause writes during cutover.** A short freeze on the source allows the offset to reach zero before applications are repointed.
- **CR is immutable.** To change the configuration, delete and recreate the `RedisShake` resource.
- **Sentinel and cluster address format.** Sentinel addresses require the `mymaster@` prefix; cluster source addresses require the `master@` prefix; cluster target addresses do not.
- **Network stability.** Persistent network instability between source and target leads to replication restarts and increased lag. Ensure stable connectivity before kicking off migration.
