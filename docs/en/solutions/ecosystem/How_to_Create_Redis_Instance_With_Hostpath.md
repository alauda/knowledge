---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
---

# Create Redis Instances With HostPath

## Introduction

This guide explains how to configure an instance of Alauda Cache Service for Redis OSS to store its data in a specific directory on your Kubernetes host machine. This is achieved by creating manual `StorageClass` and `PersistentVolume` (PV) resources. This approach is useful when an external storage provisioner is not available.

> **Note**: This document uses the term "Primary" to refer to the main Redis node in a replication setup. This is the current standard terminology, replacing the previously used term "Master".

## Prerequisites

1. **Alauda Cache Service for Redis OSS**: Ensure the Redis Operator is installed in your cluster.
2. **Host Directory**: Create the target directories on your worker nodes and set the correct permissions. The node distribution depends on the deployment mode and anti-affinity settings.

### For Sentinel Mode (1 Primary + 1 Replica)

The Alauda Redis (Sentinel) image runs as `UID 999` and `GID 1000`.

> **Important**: For Sentinel mode, the Primary and Replica pods should be scheduled on **different nodes** for high availability. Create each directory on a **separate node**.

**On Node 1**:

```bash
mkdir -p /cpaas/data/redis/redis-sentinel-0
chown 999:1000 /cpaas/data/redis/redis-sentinel-0
```

**On Node 2**:

```bash
mkdir -p /cpaas/data/redis/redis-sentinel-1
chown 999:1000 /cpaas/data/redis/redis-sentinel-1
```

### For Cluster Mode (3 Primaries + 1 Replica each)

The Alauda Redis (Cluster) image runs as `UID 999` and `GID 1000`.

The directory distribution depends on the anti-affinity mode:

#### Option A: AntiAffinityInSharding Mode

In this mode, pods within the **same shard** (Primary and its Replica) are scheduled on different nodes using anti-affinity. Pods from different shards may co-locate on the same node.

**Minimum nodes required**: 2

| Node | Directories to Create |
|------|----------------------|
| Node 1 | `redis-cluster-0-0`, `redis-cluster-1-0`, `redis-cluster-2-0` |
| Node 2 | `redis-cluster-0-1`, `redis-cluster-1-1`, `redis-cluster-2-1` |

**On Node 1**:

```bash
mkdir -p /cpaas/data/redis/redis-cluster-0-0 \
         /cpaas/data/redis/redis-cluster-1-0 \
         /cpaas/data/redis/redis-cluster-2-0

chown 999:1000 /cpaas/data/redis/redis-cluster-0-0 \
               /cpaas/data/redis/redis-cluster-1-0 \
               /cpaas/data/redis/redis-cluster-2-0
```

**On Node 2**:

```bash
mkdir -p /cpaas/data/redis/redis-cluster-0-1 \
         /cpaas/data/redis/redis-cluster-1-1 \
         /cpaas/data/redis/redis-cluster-2-1

chown 999:1000 /cpaas/data/redis/redis-cluster-0-1 \
               /cpaas/data/redis/redis-cluster-1-1 \
               /cpaas/data/redis/redis-cluster-2-1
```

#### Option B: AntiAffinity Mode (Full Anti-Affinity)

In this mode, **all pods** are anti-affinity scheduled on different nodes. Each pod runs on a dedicated node.

**Minimum nodes required**: 6

| Node | Directory to Create |
|------|---------------------|
| Node 1 | `redis-cluster-0-0` |
| Node 2 | `redis-cluster-0-1` |
| Node 3 | `redis-cluster-1-0` |
| Node 4 | `redis-cluster-1-1` |
| Node 5 | `redis-cluster-2-0` |
| Node 6 | `redis-cluster-2-1` |

Execute the following on **each respective node**:

```bash
# Replace <directory-name> with the appropriate directory for each node
mkdir -p /cpaas/data/redis/<directory-name>
chown 999:1000 /cpaas/data/redis/<directory-name>
```

For example, on Node 1:

```bash
mkdir -p /cpaas/data/redis/redis-cluster-0-0
chown 999:1000 /cpaas/data/redis/redis-cluster-0-0
```

## Procedure

### 1. Create the Manual StorageClass

To bypass dynamic provisioning, create a StorageClass with the `no-provisioner` provisioner:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-storage
  labels:
    project.cpaas.io/<your-project-name>: "true" # Replace <your-project-name> with your actual project name
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
```

### 2. Create the PersistentVolumes (PV)

#### Option A: Sentinel Mode PVs

For a 1 Primary + 1 Replica Sentinel setup with 2Gi storage:

> **Important**: Replace `<node-1>` and `<node-2>` with actual node hostnames from `kubectl get nodes`.

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
    name: redis-data-rfr-<instance-name>-0  # Replace <instance-name> with your Redis instance name
    namespace: <namespace>                   # Replace <namespace> with your namespace
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
          - <node-1>  # Replace with the hostname of Node 1 where redis-sentinel-0 directory was created
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
    name: redis-data-rfr-<instance-name>-1  # Replace <instance-name> with your Redis instance name
    namespace: <namespace>                   # Replace <namespace> with your namespace
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
          - <node-2>  # Replace with the hostname of Node 2 where redis-sentinel-1 directory was created
```

#### Option B: Cluster Mode PVs

For a 3-shard Cluster setup (3 Primaries + 1 Replica each) with 2Gi storage.

> **Important**: Replace `<node-X>` placeholders with actual node hostnames from `kubectl get nodes`.

##### For AntiAffinityInSharding Mode (2 nodes)

In this mode, pods within the same shard are scheduled on different nodes. Pods from different shards may co-locate:
- `<node-1>`: PVs for pod index 0 of each shard (0-0, 1-0, 2-0)
- `<node-2>`: PVs for pod index 1 of each shard (0-1, 1-1, 2-1)

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
    name: redis-data-drc-<instance-name>-0-0  # Replace <instance-name> with your Redis instance name
    namespace: <namespace>                     # Replace <namespace> with your namespace
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

##### For Full AntiAffinity Mode (6 nodes)

In this mode, each pod runs on a dedicated node. Use separate node hostnames for each PV:

| PV Name | Node Affinity |
|---------|---------------|
| `pv-redis-cluster-0-0` | `<node-1>` |
| `pv-redis-cluster-0-1` | `<node-2>` |
| `pv-redis-cluster-1-0` | `<node-3>` |
| `pv-redis-cluster-1-1` | `<node-4>` |
| `pv-redis-cluster-2-0` | `<node-5>` |
| `pv-redis-cluster-2-1` | `<node-6>` |

Use the same YAML structure as above, but replace each `nodeAffinity.values` with the corresponding unique node hostname.

### 3. Create the Redis Instance

#### Sentinel Mode

Apply the following YAML to create a Sentinel mode Redis instance:

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>        # Replace with your instance name
  namespace: <namespace>       # Replace with your namespace
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
  passwordSecret: <default user password secret> # Optional
  persistent:
    storageClassName: local-storage
  persistentSize: 2Gi
  replicas:
    sentinel:
      master: 1
      slave: 1
  resources:
    limits:
      cpu: "1"
      memory: 1Gi
    requests:
      cpu: "1"
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

Refer to documentation: [Create Redis Instance](https://docs.alauda.io/redis/) for more instance creation details.

> **Note**: Ensure the `metadata.name` matches the `<instance-name>` used in your PV `claimRef` definitions. The PVC naming pattern is `redis-data-rfr-<instance-name>-<index>`.

#### Cluster Mode

Apply the following YAML to create a Cluster mode Redis instance:

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>        # Replace with your instance name
  namespace: <namespace>       # Replace with your namespace
spec:
  affinityPolicy: AntiAffinityInSharding
  arch: cluster
  customConfig:
    save: 60 10000 300 100 600 1
  exporter:
    enabled: true
  expose:
    type: NodePort
  passwordSecret: <default user password secret> # Optional
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

Refer to documentation: [Create Redis Instance](https://docs.alauda.io/redis/) for more instance creation details.

> **Note**: Ensure the `metadata.name` matches the `<instance-name>` used in your PV `claimRef` definitions. Ensure your PV `claimRef` names follow the pattern `redis-data-drc-<instance-name>-<shard>-<replica>`.

## Important Considerations

### PV Naming Convention

The PVC names generated by the Redis Operator follow specific patterns:

| Mode | PVC Name Pattern | Example |
|------|------------------|---------|
| Sentinel | `redis-data-rfr-<instance-name>-<index>` | `redis-data-rfr-my-redis-0` |
| Cluster | `redis-data-drc-<instance-name>-<shard>-<replica>` | `redis-data-drc-my-redis-0-0` |

Ensure your PV `claimRef` names match exactly.

### High Availability (HA)

- **Sentinel Mode**: Requires 2 PVs for 1 Primary + 1 Replica
- **Cluster Mode**: Requires 6 PVs for 3 shards with 1 replica each (3 Primaries + 3 Replicas)

Each PV must point to a **different** host directory.

### Reusability

When you delete the Redis instance, the `PersistentVolume` will go into a `Released` state (because of the `Retain` policy in this guide). To reuse storage for a new instance:

1. Delete the existing PV
2. Clean the host directory data if needed
3. Recreate the PV with the new `claimRef` values
