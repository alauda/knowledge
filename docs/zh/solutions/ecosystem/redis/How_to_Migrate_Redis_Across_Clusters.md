---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500095
sourceSHA: 17d794a44095f6bc32371f8fdcf2387b7c1fad87834cc0bd16707f61f6b62bfa
---

# 在 Kubernetes 集群之间迁移 Redis 数据

:::info 适用版本

- 平台: **3.8.x – 3.16.x**（下表中的镜像截至 3.16.2）
  :::

## 介绍

本指南解释了如何使用平台内置的 **RedisShake** 迁移功能在不同 Kubernetes 集群中运行的 Redis 实例之间迁移数据。该操作步骤支持以下源/目标架构组合：

| 架构        | 描述                                   |
| ----------- | -------------------------------------- |
| `standalone` | 单节点 Redis                          |
| `sentinel`   | 基于 Sentinel 的主/从实例            |
| `cluster`    | 分片 Redis 集群                       |

RedisShake 执行持续复制：只要源实例继续接受写入，这些写入就会传播到目标实例。同步不会自动停止。

## 术语表

| 术语   | 释义                                               |
| ------ | -------------------------------------------------- |
| Source | 正在迁移数据的 Redis 实例。                        |
| Target | 接收迁移数据的 Redis 实例。                        |

## 先决条件

1. **容量检查。** 确保目标实例有足够的内存来容纳源数据集：
   - 目标为 Sentinel：目标内存应至少为 **源数据集大小的 5/4**。
   - 目标为集群，源为单节点：目标内存应至少为 **源数据集大小的 5/4**。
   - 目标为集群，源为集群：目标内存应至少为 **最大源分片的数据集大小的 5/4**。
   - 为了获得可接受的性能，为每个 RedisShake pod 分配 **2-8 vCPU**（推荐 4 vCPU）。
2. **减少或暂停** 源实例上的写入，以降低复制压力。
3. **选择正确的 RedisShake 镜像** 以匹配您的平台版本（请参见 [附录](#appendix-redisshake-image-by-platform-version)）。
4. **网络连接。** RedisShake pod 必须能够通过稳定的 IPv4 网络访问源和目标实例。
5. **Redis 版本。** 当前的 RedisShake 镜像 **不支持 Redis 7.x**。仅在 Redis 5.x 或 6.x 源/目标实例上使用此方法。

### 已知问题

- 在平台版本 **3.16.0** 和 **3.16.1** 中，当源为 Sentinel 实例时，源实例状态可能会错误地报告为 `Processing`，即使实例是健康的。状态报告在 **3.16.2** 中已修复。

## 迁移操作步骤

对于下面的每种场景，您需要创建一个单独的 `RedisShake` 自定义资源。更新镜像、源/目标地址和密码 Secrets 以匹配您的环境，然后使用 `kubectl` 或平台 UI 应用该资源。要在部署后更改配置，请删除现有资源并创建一个新资源——不支持就地编辑。

### 1. 创建密码 Secrets

如果任一方受密码保护，请为每一方创建一个 Kubernetes Secret。Secret 必须使用数据键 `password`。

```bash
kubectl -n <namespace> create secret generic <secret-name> \
  --from-literal=password=<password>
```

### 2. 从单节点到 Sentinel

```yaml
apiVersion: middle.alauda.cn/v1alpha1
kind: RedisShake
metadata:
  name: standalone-to-sentinel
spec:
  image: <redisshake-image>           # 请参见附录以获取适合您版本的正确镜像
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
当 **源或目标是 Sentinel 实例** 时，地址必须以 `mymaster@` 为前缀，值应为 Sentinel 访问端点。在 **数据服务 > 实例详情 > 访问方式 > 集群内访问 / 外部访问** 中找到它。
:::

### 3. 从 Sentinel 到 Sentinel

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

### 4. 从单节点到集群

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
对于集群目标，地址可以是 **集群访问端点中的任意一个**。在 **数据服务 > 实例详情 > 访问方式 > 集群内访问 / 外部访问** 中找到它们。
:::

### 5. 从 Sentinel 到集群

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

### 6. 从集群到集群

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

- 当 **源是集群** 时，地址前缀为 `master@`。目标集群地址 **不需要** 此前缀。
- 对于源和目标集群，任意一个集群端点即可——RedisShake 会自动发现其余拓扑。
  :::

## 验证同步

RedisShake 执行持续复制。即使初始数据集已复制，复制仍会继续，直到您删除 `RedisShake` 资源。因此，您必须手动验证完成情况。

### 平台版本低于 3.10

这些版本没有监控面板。使用键计数比较：

1. 在源上运行 `DBSIZE`。对于集群源，计算所有主节点的 `DBSIZE` 之和。
2. 在目标上运行 `DBSIZE`。对于集群目标，计算所有主节点的总和。
3. 在源上暂停写入时，当同步完成时，总数应匹配。

对于集群模式，以下一行命令返回所有主节点的总键计数：

```bash
redis-cli -a <password> --cluster call <host>:<port> dbsize --cluster-only-masters
```

### 平台版本 3.10.2 及以上

键计数方法仍然有效。此外，在 **平台管理 > 操作中心 > 监控 > Grafana > 仪表板** 下提供了 **"Redis Shake Dashboard"**。

#### Sentinel 源

- `SyncProcessPercent` — 当初始同步完成时达到 `100`。
- `SlaveDelayOffset` — 定期下降到 `0` 表示目标已赶上。来自复制 ping 数据包的短暂峰值是预期的，而不是数据。

#### 集群源

- `SyncProcessPercent` — 每个源分片一个进度系列。所有分片达到完成标记表示初始同步完成。
- `SlaveDelayOffset` — 当偏移量达到 `0` 时，复制已更新。

## 附录：按平台版本的 RedisShake 镜像

使用与您的平台版本匹配的 RedisShake 镜像：

| ACP 版本         | RedisShake 镜像                                                |
| ---------------- | ------------------------------------------------------------- |
| 3.8.1 - 3.8.3    | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2`        |
| 3.10.1           | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2`        |
| 3.10.2, 3.10.3   | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.3`        |
| 3.12.1 - 3.12.3  | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-5ad6d091` |
| 3.14.1, 3.14.2   | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-063e3b5d` |
| 3.16.1           | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-9bb65a7b` |
| 3.16.2           | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-3777a73b` |

## 重要注意事项

- **不支持 Redis 7.x。** 对于 Redis 7.x 源或目标，请使用其他迁移路径（例如 RDB 导出/导入）。
- **复制不会自动停止。** 在切换之前始终验证完成情况，并在迁移完成后删除 `RedisShake` 资源。
- **在切换期间暂停写入。** 源上的短暂冻结允许偏移量在应用程序重新指向之前达到零。
- **CR 是不可变的。** 要更改配置，请删除并重新创建 `RedisShake` 资源。
- **Sentinel 和集群地址格式。** Sentinel 地址需要 `mymaster@` 前缀；集群源地址需要 `master@` 前缀；集群目标地址不需要。
- **网络稳定性。** 源和目标之间的持续网络不稳定会导致复制重启和堆积量增加。在开始迁移之前确保连接稳定。
