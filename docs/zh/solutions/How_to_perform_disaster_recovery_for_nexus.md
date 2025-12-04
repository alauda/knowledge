---
kind:
   - Solution
products:
  - Alauda DevOps
ProductsVersion:
   - 4.x
id: KB251200004
---

# 如何为 Nexus 执行灾难恢复

## 问题

本解决方案描述了如何基于 Ceph 块存储的灾难恢复能力构建 Nexus 灾难恢复解决方案。该解决方案实现了**热数据、冷计算**架构，其中数据通过 Ceph 块存储灾难恢复机制持续同步到备用集群，当主集群发生故障时部署备用 Nexus 实例，备用 Nexus 会使用容灾数据快速启动并提供服务。该解决方案主要关注数据灾难恢复处理，用户需要自行实现 Nexus 访问地址切换机制。

## 环境

Nexus Operator: >=v3.81.1

## 术语

| 术语                    | 描述                                                                 |
|-------------------------|-----------------------------------------------------------------------------|
| **主 Nexus**      | 处理正常业务操作和用户请求的活跃 Nexus 实例。该实例完全运行，所有组件都在运行。 |
| **备用 Nexus**    | 计划部署在不同集群/区域的备用 Nexus 实例，在灾难恢复场景激活之前保持休眠状态。 |
| **主块存储**| 存储所有 Nexus 数据的活跃块存储系统，作为块存储复制的源。 |
| **备用块存储**| 从主块存储接收数据复制的同步备份块存储系统。它确保在灾难恢复期间的数据可用性。 |
| **恢复点目标 (RPO)** | 以时间衡量的最大可接受数据丢失量（例如，5 分钟，1 小时）。它定义了在灾难发生前可以丢失多少数据才变得不可接受。 |
| **恢复时间目标 (RTO)** | 以时间衡量的最大可接受停机时间（例如，15 分钟，2 小时）。它定义了系统在灾难后必须恢复的速度。 |
| **故障转移**            | 当主系统变得不可用或失败时，从主系统切换到备用系统的过程。 |
| **数据同步**| 从主系统到备用系统持续复制数据以保持一致性并启用灾难恢复的过程。 |
| **热数据，冷计算**| 一种架构模式，其中数据持续同步（热），而计算资源保持非活动状态（冷），直到故障转移。 |

## 架构

Nexus 灾难恢复解决方案为 Nexus 服务实现了**热数据、冷计算架构**。这种架构通过准实时数据同步和手动 Nexus 服务故障转移程序提供灾难恢复能力。架构由部署在不同集群或区域的两个 Nexus 实例组成，备用 Nexus 并不会提前部署，直到在灾难场景中激活，而存储层保持持续同步。

### 数据同步策略

该解决方案通过 Ceph RBD Mirror 块存储复制确保 Nexus 数据同步到备用集群。Nexus 的所有数据都存储在 PVC 中，通过 Ceph RBD Mirror 机制定时同步到备用集群。

### 灾难恢复配置

1. **部署主 Nexus**：配置域名访问，使用主块存储存储数据
2. **准备备用 Nexus 部署环境**：配置备用实例所需要的 pv、pvc 和 secret 资源，以便于灾难发生时快速恢复

### 故障转移程序

当发生灾难时，以下步骤确保转换到备用环境：

1. **验证主故障**：确认所有主 Nexus 组件都不可用
2. **提升 Ceph RBD**：将备用 Ceph RBD 提升为主 Ceph RBD
3. **恢复 PVC 和 PV 资源**：根据 Ceph 块存储灾难恢复文档，将 Nexus 所使用的 PVC 在备集群恢复
4. **部署备用 Nexus**：在备集群使用灾备数据快速部署 Nexus 实例
5. **更新路由**：将外部访问地址切换到指向备用 Nexus 实例

## Nexus 容灾配置

::: warning

为了简化配置过程，降低配置难度，推荐主备两个环境中使用一致的信息，包括：

- 一致的 Ceph 存储池名称和存储类名称
- 一致的 Nexus 实例名称
- 一致的命名空间名称

:::

### 前置条件

1. 提前准备一个主集群和一个灾难恢复集群（或包含不同区域的集群）。
2. 完成 `Alauda Build of Rook-Ceph` 块存储的灾难恢复配置的部署。

:::warning
`Alauda Build of Rook-Ceph` 块存储的灾难恢复配置，需要设置合理的[同步间隔时间](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#create-volumereplicationclass)，这会直接影响容灾的 RPO 指标。
:::

### 使用 `Alauda Build of Rook-Ceph` 构建块存储灾难恢复集群

使用 `Alauda Build of Rook-Ceph` 构建块存储灾难恢复集群。参考 [块存储灾难恢复](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html) 文档构建灾难恢复集群。

### 设置主 Nexus

按照 Nexus 实例部署指南部署主 Nexus 实例。配置域名访问，使用主块存储存储数据。

配置示例（仅包含了容灾关注的配置项，完整配置项见产品文档）：

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
      name: ceph-rdb # 设置已经配置了存储类名称
```

部署主 Nexus 后，需要为 Nexus 组件使用的 PVC 配置 RBD Mirror，配置后才会将 PVC 数据定时同步到备 Ceph 集群。具体参数配置参考 [Ceph RBD Mirror](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#enable-mirror-for-pvc)。

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

检查 Ceph RBD Mirror 状态，可以看到 Nexus 的 PVC 已经配置了 Ceph RBD Mirror。

```bash
❯ kubectl -n $NEXUS_NAMESPACE get volumereplication
NAME                                      AGE   VOLUMEREPLICATIONCLASS       PVCNAME                                   DESIREDSTATE   CURRENTSTATE
nexus-data-nexus-ddrs-nxrm-ha-0           15s   rbd-volumereplicationclass   nexus-data-nexus-ddrs-nxrm-ha-0           primary        Primary
```

从 Ceph 端查看 Ceph RBD Mirror 状态，`CEPH_BLOCK_POOL` 是 Ceph RBD 存储池的名称。`SCHEDULE` 列标识了同步的频率（下面的示例是 1 分钟同步一次）。

```bash
❯ kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- rbd mirror snapshot schedule ls --pool $CEPH_BLOCK_POOL --recursive
POOL     NAMESPACE  IMAGE                                         SCHEDULE
myblock             csi-vol-459e6f28-a158-4ae9-b5da-163448c35119  every 1m
```

检查 Ceph RBD Mirror 状态，state 为 `up+stopped`（主集群正常）并且 peer_sites.state 为 `up+replaying`（备集群正常）表示同步正常。

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
当 Ceph RBD 处于备用状态时，同步过来的存储块无法挂载，因此备集群的 Nexus 无法部署成功。

如需验证备集群 Nexus 是否可以部署成功，可以临时将备集群的 Ceph RBD 提升为主集群，测试完成后再设置回备用状态。同时需要将测试过程中创建的 Nexus、PV 和 PVC 资源都删除。
:::

1. 备份主 Nexus 使用的 Secret
2. 备份主集群 Nexus 组件的 PVC 和 PV 资源 YAML
3. 备份主集群 Nexus 的 Nexus 资源 YAML

#### 备份主 Nexus 使用的 Secret

获取主 Nexus 使用的 Password Secret YAML，并将 Secret 创建到备集群同名命名空间中。

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
PV 资源中保存了 volume 属性信息，这些信息是容灾恢复时的关键信息，需要备份好。

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

echo "=>  Exporting PVC $NEXUS_PVC_NAME"

# 导出 PVC
kubectl -n "$NEXUS_NAMESPACE" get pvc "$NEXUS_PVC_NAME" -o yaml > "pvc-${NEXUS_PVC_NAME}.yaml"

# 获取 PV
PV=$(kubectl -n "$NEXUS_NAMESPACE" get pvc "$NEXUS_PVC_NAME" -o jsonpath='{.spec.volumeName}')

if [[ -n "$PV" ]]; then
  echo "   ↳ Exporting PV $PV"
  kubectl get pv "$PV" -o yaml > "pv-${PV}.yaml"
fi
```

修改备份出来的 PV 文件，将 yaml 中的 `spec.claimRef` 字段全部删除。

将备份出来的 PVC 和 PV YAML 文件直接创建到容灾环境同名命名空间中。

#### 备份主 Nexus 实例 YAML

```bash
kubectl -n "$NEXUS_NAMESPACE" get nexus "$NEXUS_NAME" -oyaml > nexus.yaml
```

根据容灾环境实际情况修改 `nexus.yaml` 中的信息。

:::warning
`Nexus` 资源**不需要**立即创建在容灾环境，只需要在灾难发生时，执行容灾切换时创建到备集群即可。
:::

:::warning
如需进行容灾演练，可以按照 [灾难切换](#灾难切换) 中的步骤进行演练。演练完毕后需要在容灾环境完成以下清理操作：

- 将容灾环境中的 `Nexus` 实例删除
- 将创建的 PVC 和 PV 删除
- 将 Ceph RBD 切换为备用状态

:::

### 恢复目标

#### 恢复点目标 (RPO)

RPO 表示在灾难恢复场景中最大可接受的数据丢失。在此 Nexus 灾难恢复解决方案中：

- **存储层**：由于 Nexus 数据的 Ceph RBD 块存储复制，通过快照定时同步，数据丢失情况取决于同步间隔，间隔时间可以[配置](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#create-volumereplicationclass)
- **总体 RPO**：总体 RPO 取决于 Ceph RBD 块存储复制的同步间隔时间。

#### 恢复时间目标 (RTO)

RTO 表示在灾难恢复期间最大可接受的停机时间。此解决方案提供：

- **手动组件**：Nexus 服务激活和外部路由更新需要手动干预
- **典型 RTO**：完整服务恢复需要 4-10 分钟

**RTO 分解：**

- Ceph RBD 故障转移：1-2 分钟（手动）
- Nexus 服务激活：2-5 分钟（手动）
- 外部路由更新：1-3 分钟（手动，取决于 DNS 传播）

## 灾难切换

1. **确认主 Nexus 故障**：确认所有主 Nexus 组件都处于非工作状态，否则先停止所有主 Nexus 组件。

2. **提升备用 Ceph RBD**：将备用 Ceph RBD 提升为主 Ceph RBD。参考 [Alauda Build of Rook-Ceph 故障转移](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#procedures-1) 的切换程序。

3. **恢复 PVC 和 PV 资源**：恢复备份的 PVC 和 PV 资源到容灾环境同名命名空间中，并检查备集群 PVC 状态是否为 `Bound` 状态：

   ```bash
   ❯ kubectl -n $NEXUS_NAMESPACE get pvc,pv
   NAME                                                            STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   VOLUMEATTRIBUTESCLASS   AGE
   persistentvolumeclaim/nexus-data-nexus-ddrs-nxrm-ha-0          Bound    pvc-231a9021-2548-433e-8583-f7b56d74aca7   5Gi        RWO            ceph-rdb       <unset>                 45s

   NAME                                                        CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM                                             STORAGECLASS   VOLUMEATTRIBUTESCLASS   REASON   AGE
   persistentvolume/pvc-231a9021-2548-433e-8583-f7b56d74aca7   5Gi        RWO            Delete           Bound    nexus-dr/nexus-data-nexus-ddrs-nxrm-ha-0   ceph-rdb       <unset>                          63s
   ```

4. **部署备用 Nexus**：恢复备份的 `nexus.yaml` 到容灾环境同名命名空间中。Nexus 会利用容灾数据自动启动。

5. **验证 Nexus 组件**：验证所有 Nexus 组件正在运行且健康。测试 Nexus 功能（仓库访问、包上传下载、用户认证）以验证 Nexus 是否正常工作。

6. **切换访问地址**：将外部访问地址切换到备用 Nexus。

## 使用其他块存储构建 Nexus 灾难恢复解决方案

操作步骤与使用 `Alauda Build of Rook-Ceph` 构建 Nexus 灾难恢复解决方案类似。只需将块存储替换为其他支持灾难恢复的块存储解决方案。

:::warning
确保所选块存储解决方案支持灾难恢复能力，并在生产环境使用前进行充分的容灾演练。
:::

