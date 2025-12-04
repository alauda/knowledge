---
kind:
  - Solution
products:
  - Alauda DevOps
ProductsVersion:
  - 4.x
id: KB251200004
sourceSHA: 3470ad902e70f1155c7256fa71c7b6f8ea7f401295fc82a6c58a5fcf69bcd3a6
---

# 如何为 Nexus 执行灾难恢复

## 问题

本解决方案描述了如何基于 Ceph 块存储的灾难恢复能力构建 Nexus 灾难恢复解决方案。该解决方案实现了 **热数据，冷计算** 架构，其中数据通过 Ceph 块存储灾难恢复机制持续同步到备用集群。当主集群发生故障时，部署一个备用 Nexus 实例，备用 Nexus 将快速开始使用灾难恢复数据并提供服务。该解决方案主要关注数据灾难恢复处理，用户需要实现自己的 Nexus 访问地址切换机制。

## 环境

Nexus Operator: >=v3.81.1

## 术语

| 术语                               | 描述                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **主 Nexus**                        | 处理正常业务操作和用户请求的活动 Nexus 实例。该实例完全运行，所有组件均在运行状态。                                                                                   |
| **备用 Nexus**                     | 计划在不同集群/地域中部署的备用 Nexus 实例，保持待命状态，直到在灾难恢复场景中被激活。                                                                                 |
| **主块存储**                       | 存储所有 Nexus 数据的活动块存储系统，作为块存储复制的源。                                                                                                           |
| **备用块存储**                     | 从主块存储接收数据复制的同步备份块存储系统。在灾难恢复期间确保数据可用性。                                                                                           |
| **恢复点目标 (RPO)**              | 可接受的数据丢失最大量，以时间衡量（例如，5分钟，1小时）。它定义了在灾难发生时可以丢失多少数据而不会变得不可接受。                                                   |
| **恢复时间目标 (RTO)**            | 可接受的最大停机时间，以时间衡量（例如，15分钟，2小时）。它定义了系统在灾难后必须多快恢复。                                                                          |
| **故障转移**                       | 当主系统不可用或发生故障时，从主系统切换到备用系统的过程。                                                                                                          |
| **数据同步**                       | 从主系统到备用系统的持续数据复制过程，以保持一致性并启用灾难恢复。                                                                                                  |
| **热数据，冷计算**                 | 一种架构模式，其中数据持续同步（热），而计算资源保持非活动状态（冷），直到发生故障转移。                                                                              |

## 架构

Nexus 灾难恢复解决方案实现了 **热数据，冷计算架构** 用于 Nexus 服务。该架构通过近实时数据同步和手动 Nexus 服务故障转移程序提供灾难恢复能力。该架构由两个部署在不同集群或地域的 Nexus 实例组成，备用 Nexus 实例在灾难场景中被激活之前不会提前部署，而存储层保持持续同步。

### 数据同步策略

该解决方案通过 Ceph RBD Mirror 块存储复制确保 Nexus 数据同步到备用集群。所有 Nexus 数据存储在 PVC 中，定期通过 Ceph RBD Mirror 机制同步到备用集群。

### 灾难恢复配置

1. **部署主 Nexus**：配置域访问，使用主块存储进行数据存储
2. **准备备用 Nexus 部署环境**：配置备用实例所需的 PV、PVC 和 Secret 资源，以便在发生灾难时快速恢复

### 故障转移程序

当发生灾难时，以下步骤确保切换到备用环境：

1. **验证主故障**：确认所有主 Nexus 组件不可用
2. **提升 Ceph RBD**：将备用 Ceph RBD 提升为主 Ceph RBD
3. **恢复 PVC 和 PV 资源**：根据 Ceph 块存储灾难恢复文档，恢复备用集群中 Nexus 使用的 PVC
4. **部署备用 Nexus**：快速使用灾难恢复数据在备用集群中部署 Nexus 实例
5. **更新路由**：切换外部访问地址以指向备用 Nexus 实例

## Nexus 灾难恢复配置

::: warning

为了简化配置过程并降低配置难度，建议在主环境和备用环境中使用一致的信息，包括：

- 一致的 Ceph 存储池名称和存储类名称
- 一致的 Nexus 实例名称
- 一致的命名空间名称

:::

### 先决条件

1. 提前准备一个主集群和一个灾难恢复集群（或包含不同地域的集群）。
2. 完成 `Alauda Build of Rook-Ceph` 块存储灾难恢复配置的部署。

:::warning
`Alauda Build of Rook-Ceph` 块存储灾难恢复配置需要设置合理的 [同步间隔](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#create-volumereplicationclass)，这直接影响灾难恢复的 RPO 指标。
:::

### 使用 `Alauda Build of Rook-Ceph` 构建块存储灾难恢复集群

使用 `Alauda Build of Rook-Ceph` 构建块存储灾难恢复集群。请参考 [块存储灾难恢复](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html) 文档以构建灾难恢复集群。

### 设置主 Nexus

按照 Nexus 实例部署指南部署主 Nexus 实例。配置域访问，使用主块存储进行数据存储。

配置示例（仅包括与灾难恢复相关的配置项，完整配置项请参见产品文档）：

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: Nexus
metadata:
  name: <NEXUS_NAME>
  namespace: <NEXUS_NAMESPACE>
spec:
  externalURL: http://nexus-ddrs.alaudatech.net
  helmValues:
    pvc:
      storage: 5Gi
      volumeClaimTemplate:
        enabled: true
    storageClass:
      name: ceph-rdb # 设置配置的存储类名称
```

在部署主 Nexus 后，您需要为 Nexus 组件使用的 PVC 配置 RBD Mirror。配置后，PVC 数据将定期同步到备用 Ceph 集群。有关具体参数配置，请参见 [Ceph RBD Mirror](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#enable-mirror-for-pvc)。

```bash
export NEXUS_NAMESPACE=<ns-of-nexus-instance>
export NEXUS_NAME=<name-of-nexus-instance>
export NEXUS_PVC_NAME=nexus-data-${NEXUS_NAME}-nxrm-ha-0

cat << EOF | kubectl apply -f -
apiVersion: replication.storage.openshift.io/v1alpha1
kind: VolumeReplication
metadata:
  name: ${NEXUS_PVC_NAME}
  namespace: ${NEXUS_NAMESPACE}
spec:
  autoResync: true # 自动同步
  volumeReplicationClass: rbd-volumereplicationclass
  replicationState: primary # 标记为主集群
  dataSource:
    apiGroup: ""
    kind: PersistentVolumeClaim
    name: ${NEXUS_PVC_NAME}
EOF
```

检查 Ceph RBD Mirror 状态，以查看 Nexus PVC 是否已配置 Ceph RBD Mirror。

```bash
❯ kubectl -n $NEXUS_NAMESPACE get volumereplication
NAME                                      AGE   VOLUMEREPLICATIONCLASS       PVCNAME                                   DESIREDSTATE   CURRENTSTATE
nexus-data-nexus-ddrs-nxrm-ha-0           15s   rbd-volumereplicationclass   nexus-data-nexus-ddrs-nxrm-ha-0           primary        Primary
```

从 Ceph 侧查看 Ceph RBD Mirror 状态。`CEPH_BLOCK_POOL` 是 Ceph RBD 存储池的名称。`SCHEDULE` 列指示同步频率（下面的示例显示每 1 分钟同步一次）。

```bash
❯ kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- rbd mirror snapshot schedule ls --pool $CEPH_BLOCK_POOL --recursive
POOL     NAMESPACE  IMAGE                                         SCHEDULE
myblock             csi-vol-459e6f28-a158-4ae9-b5da-163448c35119  every 1m
```

检查 Ceph RBD Mirror 状态。当状态为 `up+stopped`（主集群正常）且 peer_sites.state 为 `up+replaying`（备用集群正常）时，表示同步正常。

```bash
❯ kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- rbd mirror image status $CEPH_BLOCK_POOL/$NEXUS_BLOCK_IMAGE_NAME
csi-vol-459e6f28-a158-4ae9-b5da-163448c35119:
  global_id:   98bbf3bf-7c61-42b4-810b-cb2a7cd6d6b1
  state:       up+stopped
  description: local image is primary
  service:     a on 192.168.129.233
  last_update: 2025-11-19 01:42:07
  peer_sites:
    name: ecf558fa-1e8a-43f1-bf6b-1478e73f272e
    state: up+replaying
    description: replaying, {"bytes_per_second":0.0,"bytes_per_snapshot":5742592.0,"last_snapshot_bytes":5742592,"last_snapshot_sync_seconds":0,"local_snapshot_timestamp":1763516344,"remote_snapshot_timestamp":1763516344,"replay_state":"idle"}
    last_update: 2025-11-19 01:42:27
  snapshots:
    75 .mirror.primary.98bbf3bf-7c61-42b4-810b-cb2a7cd6d6b1.3d3402a5-f298-4048-8c50-84979949355d (peer_uuids:[66d8fb19-c610-438c-ae73-42a95ea4e86e])
```

### 设置备用 Nexus

:::warning
当 Ceph RBD 处于备用状态时，同步的存储块无法挂载，因此备用集群中的 Nexus 无法成功部署。

如果您需要验证备用集群中的 Nexus 是否可以成功部署，可以暂时将备用集群的 Ceph RBD 提升为主状态，测试完成后再将其设置回备用状态。同时，您需要删除测试期间创建的所有 Nexus、PV 和 PVC 资源。
:::

1. 备份主 Nexus 使用的 Secrets
2. 备份主 Nexus 组件的 PVC 和 PV 资源 YAML
3. 备份主 Nexus 实例 YAML

#### 备份主 Nexus 使用的 Secrets

获取主 Nexus 使用的密码 Secret YAML，并在备用集群中创建同名命名空间的 Secret。

```bash
apiVersion: v1
data:
  password: xxxxxx
kind: Secret
metadata:
  name: nexus-root-password
  namespace: nexus-dr
type: Opaque
```

#### 备份主 Nexus 组件的 PVC 和 PV 资源

:::tip
PV 资源包含卷属性信息，这是灾难恢复恢复的重要信息，需要妥善备份。

```bash
    volumeAttributes:
      clusterID: rook-ceph
      imageFeatures: layering
      imageFormat: "2"
      imageName: csi-vol-459e6f28-a158-4ae9-b5da-163448c35119
      journalPool: myblock
      pool: myblock
      storage.kubernetes.io/csiProvisionerIdentity: 1763446982673-7963-rook-ceph.rbd.csi.ceph.com
```

:::

执行以下命令将主 Nexus 组件的 PVC 和 PV 资源备份到当前目录：

```bash
export NEXUS_PVC_NAME=<PVC_NAME>

echo "=>  导出 PVC $NEXUS_PVC_NAME"

# 导出 PVC
kubectl -n "$NEXUS_NAMESPACE" get pvc "$NEXUS_PVC_NAME" -o yaml > "pvc-${NEXUS_PVC_NAME}.yaml"

# 获取 PV
PV=$(kubectl -n "$NEXUS_NAMESPACE" get pvc "$NEXUS_PVC_NAME" -o jsonpath='{.spec.volumeName}')

if [[ -n "$PV" ]]; then
  echo "   ↳ 导出 PV $PV"
  kubectl get pv "$PV" -o yaml > "pv-${PV}.yaml"
fi
```

修改备份的 PV 文件，删除 YAML 中所有的 `spec.claimRef` 字段。

在灾难恢复环境中直接使用相同的命名空间名称创建备份的 PVC 和 PV YAML 文件。

#### 备份主 Nexus 实例 YAML

```bash
kubectl -n "$NEXUS_NAMESPACE" get nexus "$NEXUS_NAME" -oyaml > nexus.yaml
```

根据灾难恢复环境的实际情况修改 `nexus.yaml` 中的信息。

:::warning
在灾难恢复环境中 **不需要** 立即创建 `Nexus` 资源。仅在发生灾难并执行灾难恢复切换时，才需要在备用集群中创建。
:::

:::warning
如果您需要进行灾难恢复演练，可以按照 [灾难切换](#disaster-switchover) 中的步骤进行演练。演练完成后，您需要在灾难恢复环境中执行以下清理操作：

- 删除灾难恢复环境中的 `Nexus` 实例
- 删除创建的 PVC 和 PV
- 将 Ceph RBD 切换回备用状态

:::

### 恢复目标

#### 恢复点目标 (RPO)

RPO 表示在灾难恢复场景中可接受的最大数据丢失。在此 Nexus 灾难恢复解决方案中：

- **存储层**：由于 Ceph RBD 块存储对 Nexus 数据的复制，通过定期快照同步，数据丢失取决于同步间隔，可以 [配置](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#create-volumereplicationclass)
- **整体 RPO**：整体 RPO 取决于 Ceph RBD 块存储复制的同步间隔。

#### 恢复时间目标 (RTO)

RTO 表示灾难恢复期间可接受的最大停机时间。该解决方案提供：

- **手动组件**：Nexus 服务激活和外部路由更新需要手动干预
- **典型 RTO**：完整服务恢复需要 4-10 分钟

**RTO 分解：**

- Ceph RBD 故障转移：1-2 分钟（手动）
- Nexus 服务激活：2-5 分钟（手动）
- 外部路由更新：1-3 分钟（手动，取决于 DNS 传播）

## 灾难切换

1. **确认主 Nexus 故障**：确认所有主 Nexus 组件处于非工作状态，否则先停止所有主 Nexus 组件。

2. **提升备用 Ceph RBD**：将备用 Ceph RBD 提升为主 Ceph RBD。请参考 [Alauda Build of Rook-Ceph 故障转移](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#procedures-1) 中的切换程序。

3. **恢复 PVC 和 PV 资源**：将备份的 PVC 和 PV 资源恢复到灾难恢复环境中，使用相同的命名空间名称，并检查备用集群中的 PVC 状态是否为 `Bound`：

   ```bash
   ❯ kubectl -n $NEXUS_NAMESPACE get pvc,pv
   NAME                                                            STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   VOLUMEATTRIBUTESCLASS   AGE
   persistentvolumeclaim/nexus-data-nexus-ddrs-nxrm-ha-0          Bound    pvc-231a9021-2548-433e-8583-f7b56d74aca7   5Gi        RWO            ceph-rdb       <unset>                 45s

   NAME                                                        CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM                                             STORAGECLASS   VOLUMEATTRIBUTESCLASS   REASON   AGE
   persistentvolume/pvc-231a9021-2548-433e-8583-f7b56d74aca7   5Gi        RWO            Delete           Bound    nexus-dr/nexus-data-nexus-ddrs-nxrm-ha-0   ceph-rdb       <unset>                          63s
   ```

4. **部署备用 Nexus**：将备份的 `nexus.yaml` 恢复到灾难恢复环境中，使用相同的命名空间名称。Nexus 将自动开始使用灾难恢复数据。

5. **验证 Nexus 组件**：验证所有 Nexus 组件是否正常运行并健康。测试 Nexus 功能（仓库访问、包上传/下载、用户身份验证）以验证 Nexus 是否正常工作。

6. **切换访问地址**：切换外部访问地址到备用 Nexus。

## 使用其他块存储构建 Nexus 灾难恢复解决方案

操作步骤与使用 `Alauda Build of Rook-Ceph` 构建 Nexus 灾难恢复解决方案类似。只需将块存储替换为其他支持灾难恢复的块存储解决方案。

:::warning
确保所选的块存储解决方案支持灾难恢复能力，并在生产环境中使用之前进行充分的灾难恢复演练。
:::
