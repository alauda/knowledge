---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - '3.x,4.x'
id: KB260100003
sourceSHA: 0949ef645846f91025eba54b0ee638b5f0bdf98ee55a0d39690329e84c817507
---

# 使用 Hostpath PV 创建 PostgreSQL 实例，无需外部供应器

## 介绍

本指南解释了如何配置 Alauda 对 PostgreSQL 的支持，以便将其数据存储在 Kubernetes 主机机器上的特定目录中。这是通过创建手动 `StorageClass` 和 `PersistentVolume` (PV) 来实现的。当没有外部存储供应器时，此方法非常有用。

## 先决条件

1. **Postgres Operator**: 确保在您的集群中安装了 Alauda 对 PostgreSQL Operator 的支持。
2. **主机目录**: 在您的工作节点上创建目标目录并设置正确的权限。Alauda 对 PostgreSQL (Spilo) 镜像以 `UID 101` 和 `GID 103` 运行。

```bash
# 在您的主机机器上运行这些命令
sudo mkdir -p /mnt/data/postgres-1
sudo chown -R 101:103 /mnt/data/postgres-1
```

## 操作步骤

### 1. 创建手动 StorageClass

为了绕过动态供应，创建一个使用 "no-provisioner" 供应器的 StorageClass。这表示存储卷 (PVs) 将手动供应。

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: manual-hostpath
  labels:
    project.cpaas.io/<your-project-name>: "true" # 将 <your-project-name> 替换为您的实际项目名称
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
```

### 2. 创建 PersistentVolume (PV)

PersistentVolume (PV) 代表主机目录上的存储。它必须引用前一步中定义的 `storageClassName`。

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: postgres-pv-1
spec:
  capacity:
    storage: 10Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: manual-hostpath
  hostPath:
    path: "/mnt/data/postgres-1" # 主机机器上的路径
  nodeAffinity: # 可选但推荐：固定到特定节点
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - your-node-name # 替换为您的实际节点名称
```

### 3. 定义 PostgreSQL 实例

在您的 `postgresql` 清单中，将 `volume.storageClass` 设置为之前创建的手动 StorageClass。有关其他配置选项，请参阅 [创建实例](https://docs.alauda.io/postgresql/4.1/functions/01_create_instance.html)。

```yaml
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: pg-single
spec:
  ipFamilyPrefer: ""
  teamId: ACID
  enableExporter: true
  enablePgpool2: false
  spiloPrivileged: false
  spiloRunAsGroup: 103
  spiloRunAsUser: 101
  spiloAllowPrivilegeEscalation: false
  enableReadinessProbe: true
  # restrictedPsaEnabled: true # 对于 ACP 4.2，打开此选项
  postgresql:
    parameters:
      log_directory: /var/log/pg_log
    version: "16"
  numberOfInstances: 1 # 对于 hostPath，最好从 1 开始
  resources:
    requests:
      cpu: "1"
      memory: 2Gi
    limits:
      cpu: "1"
      memory: 2Gi
  volume:
    size: 10Gi
    storageClass: manual-hostpath
```

## 重要考虑事项

### 高可用性 (HA)

如果您将 `numberOfInstances` 设置为 2 或更多，操作员将尝试创建多个 `PersistentVolumeClaims`。您必须创建相应数量的 `PersistentVolumes` (例如 `postgres-pv-1`, `postgres-pv-2`)，指向 **不同** 的主机目录。

### 故障排除

如果 Pod 保持在 `Pending` 状态，请检查事件：

```bash
kubectl describe pod <postgres-pod-name>
```

常见问题包括：

- **StorageClass 不匹配**: PV 中的 `storageClassName` 必须与 StorageClass 和 PostgreSQL 清单中的完全匹配。
- **容量**: PV 容量必须等于或大于 PostgreSQL 清单中请求的 `volume.size`。
- **权限**: 如果 Pod 启动但因日志中的 "Permission Denied" 错误崩溃，请验证主机目录上的 `chown -R 101:103` 步骤。
- **Admission Webhook 拒绝**: 如果您看到类似 `admission webhook "pvc-validator.cpaas.io" denied the request` 的错误，请检查 `StorageClass` 标签中的 `<your-project-name>` 是否与 PostgreSQL 实例部署的项目名称匹配。
- **调度失败 (节点亲和性)**: 如果 PV 为 `Available` 但 Pod 失败并显示 `didn't find available persistent volumes to bind`，请检查 PV 的 `nodeAffinity`。您可能忘记将 `your-node-name` 替换为 `kubectl get nodes` 中的真实节点主机名。

### 可重用性

当您删除 PostgreSQL 实例时，`PersistentVolume` 将进入 `Released` 状态（由于 `Retain` 策略）。要将其用于新数据库，您必须手动删除 PV 并重新创建它，或清除 PV 元数据中的 `spec.claimRef` 字段。
