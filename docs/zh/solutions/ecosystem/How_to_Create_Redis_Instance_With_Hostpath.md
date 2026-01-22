---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
id: KB260100013
sourceSHA: 0f96d6302a006208b05138878c76e7bfcf6bd862123c635deb5234a45fcf043d
---

# 使用 HostPath 创建 Redis 实例

## 介绍

本指南解释了如何为 Alauda Cache Service 配置 Redis OSS 实例，以便将其数据存储在 Kubernetes 主机机器上的特定目录中。这是通过创建手动的 `StorageClass` 和 `PersistentVolume` (PV) 资源来实现的。当没有外部存储提供者时，这种方法非常有用。

> **注意**：本文档使用“Primary”一词来指代复制设置中的主要 Redis 节点。这是当前的标准术语，替代了之前使用的“Master”一词。

## 先决条件

1. **Alauda Cache Service for Redis OSS**：确保在您的集群中安装了 Redis Operator。
2. **主机目录**：在工作节点上创建目标目录并设置正确的权限。节点分布取决于部署模式和反亲和性设置。

### 对于 Sentinel 模式 (1 Primary + 1 Replica)

Alauda Redis (Sentinel) 镜像以 `UID 999` 和 `GID 1000` 运行。

> **重要**：对于 Sentinel 模式，Primary 和 Replica Pod 应该调度在 **不同的节点** 上以实现高可用性。每个目录应在 **单独的节点** 上创建。

**在节点 1 上**：

```bash
mkdir -p /cpaas/data/redis/redis-sentinel-0
chown 999:1000 /cpaas/data/redis/redis-sentinel-0
```

**在节点 2 上**：

```bash
mkdir -p /cpaas/data/redis/redis-sentinel-1
chown 999:1000 /cpaas/data/redis/redis-sentinel-1
```

### 对于 Cluster 模式 (每个 3 Primaries + 1 Replica)

Alauda Redis (Cluster) 镜像以 `UID 999` 和 `GID 1000` 运行。

目录分布取决于反亲和性模式：

#### 选项 A：AntiAffinityInSharding 模式

在此模式下，**同一分片**（Primary 及其 Replica）中的 Pod 被调度在不同的节点上，使用反亲和性。来自不同分片的 Pod 可以共存于同一节点。

**所需最小节点数**：2

| 节点   | 要创建的目录                                         |
| ------ | --------------------------------------------------- |
| 节点 1 | `redis-cluster-0-0`, `redis-cluster-1-0`, `redis-cluster-2-0` |
| 节点 2 | `redis-cluster-0-1`, `redis-cluster-1-1`, `redis-cluster-2-1` |

**在节点 1 上**：

```bash
mkdir -p /cpaas/data/redis/redis-cluster-0-0 \
         /cpaas/data/redis/redis-cluster-1-0 \
         /cpaas/data/redis/redis-cluster-2-0

chown 999:1000 /cpaas/data/redis/redis-cluster-0-0 \
               /cpaas/data/redis/redis-cluster-1-0 \
               /cpaas/data/redis/redis-cluster-2-0
```

**在节点 2 上**：

```bash
mkdir -p /cpaas/data/redis/redis-cluster-0-1 \
         /cpaas/data/redis/redis-cluster-1-1 \
         /cpaas/data/redis/redis-cluster-2-1

chown 999:1000 /cpaas/data/redis/redis-cluster-0-1 \
               /cpaas/data/redis/redis-cluster-1-1 \
               /cpaas/data/redis/redis-cluster-2-1
```

#### 选项 B：AntiAffinity 模式（完全反亲和性）

在此模式下，**所有 Pod** 都使用反亲和性规则调度在不同的节点上。每个 Pod 在专用节点上运行。

**所需最小节点数**：6

| 节点   | 要创建的目录 |
| ------ | ------------- |
| 节点 1 | `redis-cluster-0-0` |
| 节点 2 | `redis-cluster-0-1` |
| 节点 3 | `redis-cluster-1-0` |
| 节点 4 | `redis-cluster-1-1` |
| 节点 5 | `redis-cluster-2-0` |
| 节点 6 | `redis-cluster-2-1` |

在 **每个相应节点** 上执行以下操作：

```bash
# 将 <directory-name> 替换为每个节点的适当目录
mkdir -p /cpaas/data/redis/<directory-name>
chown 999:1000 /cpaas/data/redis/<directory-name>
```

例如，在节点 1 上：

```bash
mkdir -p /cpaas/data/redis/redis-cluster-0-0
chown 999:1000 /cpaas/data/redis/redis-cluster-0-0
```

## 操作步骤

### 1. 创建手动 StorageClass

为了绕过动态供应，创建一个使用 `no-provisioner` 供应者的 StorageClass：

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-storage
  labels:
    project.cpaas.io/<your-project-name>: "true" # 将 <your-project-name> 替换为您的实际项目名称
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
```

### 2. 创建 PersistentVolumes (PV)

#### 选项 A：Sentinel 模式 PV

对于 1 Primary + 1 Replica Sentinel 设置，存储为 2Gi：

> **重要**：将 `<node-1>` 和 `<node-2>` 替换为 `kubectl get nodes` 中的实际节点主机名。

```yaml
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-redis-sentinel-0
spec:
  storageClassName: "local-storage"
  accessModes:
  - ReadWriteOnce
  capacity:
    storage: 2Gi
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    name: redis-data-rfr-<instance-name>-0  # 将 <instance-name> 替换为您的 Redis 实例名称
    namespace: <namespace>                   # 将 <namespace> 替换为您的命名空间
  hostPath:
    path: /cpaas/data/redis/redis-sentinel-0
    type: DirectoryOrCreate
  persistentVolumeReclaimPolicy: Retain
  volumeMode: Filesystem
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - <node-1>  # 替换为创建 redis-sentinel-0 目录的节点 1 的主机名
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-redis-sentinel-1
spec:
  storageClassName: "local-storage"
  accessModes:
  - ReadWriteOnce
  capacity:
    storage: 2Gi
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    name: redis-data-rfr-<instance-name>-1  # 将 <instance-name> 替换为您的 Redis 实例名称
    namespace: <namespace>                   # 将 <namespace> 替换为您的命名空间
  hostPath:
    path: /cpaas/data/redis/redis-sentinel-1
    type: DirectoryOrCreate
  persistentVolumeReclaimPolicy: Retain
  volumeMode: Filesystem
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - <node-2>  # 替换为创建 redis-sentinel-1 目录的节点 2 的主机名
```

#### 选项 B：Cluster 模式 PV

对于 3 分片 Cluster 设置（每个 3 Primaries + 1 Replica），存储为 2Gi。

> **重要**：将 `<node-X>` 占位符替换为 `kubectl get nodes` 中的实际节点主机名。

##### 对于 AntiAffinityInSharding 模式（2 个节点）

在此模式下，同一分片中的 Pod 被调度在不同的节点上。来自不同分片的 Pod 可以共存：

- `<node-1>`：每个分片的 Pod 索引 0 的 PV（0-0, 1-0, 2-0）
- `<node-2>`：每个分片的 Pod 索引 1 的 PV（0-1, 1-1, 2-1）

```yaml
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-redis-cluster-0-0
spec:
  storageClassName: "local-storage"
  accessModes:
  - ReadWriteOnce
  capacity:
    storage: 2Gi
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    name: redis-data-drc-<instance-name>-0-0  # 将 <instance-name> 替换为您的 Redis 实例名称
    namespace: <namespace>                     # 将 <namespace> 替换为您的命名空间
  hostPath:
    path: /cpaas/data/redis/redis-cluster-0-0
    type: DirectoryOrCreate
  persistentVolumeReclaimPolicy: Retain
  volumeMode: Filesystem
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - <node-1>
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-redis-cluster-0-1
spec:
  storageClassName: "local-storage"
  accessModes:
  - ReadWriteOnce
  capacity:
    storage: 2Gi
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    name: redis-data-drc-<instance-name>-0-1
    namespace: <namespace>
  hostPath:
    path: /cpaas/data/redis/redis-cluster-0-1
    type: DirectoryOrCreate
  persistentVolumeReclaimPolicy: Retain
  volumeMode: Filesystem
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - <node-2>
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-redis-cluster-1-0
spec:
  storageClassName: "local-storage"
  accessModes:
  - ReadWriteOnce
  capacity:
    storage: 2Gi
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    name: redis-data-drc-<instance-name>-1-0
    namespace: <namespace>
  hostPath:
    path: /cpaas/data/redis/redis-cluster-1-0
    type: DirectoryOrCreate
  persistentVolumeReclaimPolicy: Retain
  volumeMode: Filesystem
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - <node-1>
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-redis-cluster-1-1
spec:
  storageClassName: "local-storage"
  accessModes:
  - ReadWriteOnce
  capacity:
    storage: 2Gi
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    name: redis-data-drc-<instance-name>-1-1
    namespace: <namespace>
  hostPath:
    path: /cpaas/data/redis/redis-cluster-1-1
    type: DirectoryOrCreate
  persistentVolumeReclaimPolicy: Retain
  volumeMode: Filesystem
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - <node-2>
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-redis-cluster-2-0
spec:
  storageClassName: "local-storage"
  accessModes:
  - ReadWriteOnce
  capacity:
    storage: 2Gi
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    name: redis-data-drc-<instance-name>-2-0
    namespace: <namespace>
  hostPath:
    path: /cpaas/data/redis/redis-cluster-2-0
    type: DirectoryOrCreate
  persistentVolumeReclaimPolicy: Retain
  volumeMode: Filesystem
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - <node-1>
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-redis-cluster-2-1
spec:
  storageClassName: "local-storage"
  accessModes:
  - ReadWriteOnce
  capacity:
    storage: 2Gi
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    name: redis-data-drc-<instance-name>-2-1
    namespace: <namespace>
  hostPath:
    path: /cpaas/data/redis/redis-cluster-2-1
    type: DirectoryOrCreate
  persistentVolumeReclaimPolicy: Retain
  volumeMode: Filesystem
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - <node-2>
```

##### 对于完全反亲和性模式（6 个节点）

在此模式下，每个 Pod 在专用节点上运行。为每个 PV 使用不同的节点主机名：

| PV 名称                | 节点亲和性 |
| ---------------------- | ----------- |
| `pv-redis-cluster-0-0` | `<node-1>`  |
| `pv-redis-cluster-0-1` | `<node-2>`  |
| `pv-redis-cluster-1-0` | `<node-3>`  |
| `pv-redis-cluster-1-1` | `<node-4>`  |
| `pv-redis-cluster-2-0` | `<node-5>`  |
| `pv-redis-cluster-2-1` | `<node-6>`  |

使用与上述相同的 YAML 结构，但将每个 `nodeAffinity.values` 替换为相应的唯一节点主机名。

### 3. 创建 Redis 实例

#### Sentinel 模式

应用以下 YAML 创建 Sentinel 模式 Redis 实例：

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>        # 替换为您的实例名称
  namespace: <namespace>       # 替换为您的命名空间
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchExpressions:
          - key: app.kubernetes.io/component
            operator: In
            values:
            - redis
          - key: redisfailovers.databases.spotahome.com/name
            operator: In
            values:
            - <instance-name>
        topologyKey: kubernetes.io/hostname
  arch: sentinel
  customConfig:
    save: 60 10000 300 100 600 1
  exporter:
    enabled: true
    resources:
      limits:
        cpu: 100m
        memory: 384Mi
      requests:
        cpu: 50m
        memory: 128Mi
  expose:
    type: NodePort
  passwordSecret: <default user password secret> # 可选
  persistent:
    storageClassName: local-storage
  persistentSize: 2Gi
  replicas:
    sentinel:
      master: 1
      slave: 1
  resources:
    limits:
      cpu: 1
      memory: 1Gi
    requests:
      cpu: 1
      memory: 1Gi
  sentinel:
    affinity:
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
            - key: app.kubernetes.io/component
              operator: In
              values:
              - sentinel
            - key: redissentinels.databases.spotahome.com/name
              operator: In
              values:
              - <instance-name>
          topologyKey: kubernetes.io/hostname
    expose:
      type: NodePort
    replicas: 3
  version: "6.0"
```

参考文档：[创建 Redis 实例](https://docs.alauda.io/redis/) 获取更多实例创建细节。

> **注意**：确保 `metadata.name` 与您在 PV `claimRef` 定义中使用的 `<instance-name>` 匹配。PVC 命名模式为 `redis-data-rfr-<instance-name>-<index>`。

#### Cluster 模式

应用以下 YAML 创建 Cluster 模式 Redis 实例：

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>        # 替换为您的实例名称
  namespace: <namespace>       # 替换为您的命名空间
spec:
  affinityPolicy: AntiAffinityInSharding
  arch: cluster
  customConfig:
    save: 60 10000 300 100 600 1
  exporter:
    enabled: true
  expose:
    type: NodePort
  passwordSecret: <default user password secret> # 可选
  persistent:
    storageClassName: local-storage
  persistentSize: 2Gi
  replicas:
    cluster:
      shard: 3
      slave: 1
  resources:
    limits:
      cpu: 1
      memory: 1Gi
    requests:
      cpu: 1
      memory: 1Gi
  version: "6.0"
```

参考文档：[创建 Redis 实例](https://docs.alauda.io/redis/) 获取更多实例创建细节。

> **注意**：确保 `metadata.name` 与您在 PV `claimRef` 定义中使用的 `<instance-name>` 匹配。确保您的 PV `claimRef` 名称遵循模式 `redis-data-drc-<instance-name>-<shard>-<replica>`。

## 重要考虑事项

### PV 命名约定

Redis Operator 生成的 PVC 名称遵循特定模式：

| 模式     | PVC 名称模式                                   | 示例                       |
| -------- | ---------------------------------------------- | -------------------------- |
| Sentinel | `redis-data-rfr-<instance-name>-<index>`       | `redis-data-rfr-my-redis-0` |
| Cluster  | `redis-data-drc-<instance-name>-<shard>-<replica>` | `redis-data-drc-my-redis-0-0` |

确保您的 PV `claimRef` 名称完全匹配。

### 高可用性 (HA)

- **Sentinel 模式**：需要 2 个 PV 以支持 1 Primary + 1 Replica
- **Cluster 模式**：需要 6 个 PV 以支持 3 个分片，每个分片 1 个副本（3 Primaries + 3 Replicas）

每个 PV 必须指向 **不同** 的主机目录。

### 可重用性

当您删除 Redis 实例时，`PersistentVolume` 将进入 `Released` 状态（因为本指南中的 `Retain` 策略）。要为新实例重用存储：

1. 删除现有 PV
2. 如有必要，清理主机目录数据
3. 使用新的 `claimRef` 值重新创建 PV
