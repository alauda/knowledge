---
kind:
  - Solution
products:
  - Alauda DevOps
ProductsVersion:
  - 4.x
id: KB251200003
sourceSHA: 93d5ce922c73debfb00b208ad5d2f330f19a3ed54f7117201e34b8408f881ab1
---

# 如何为 GitLab 执行灾难恢复

## 问题

本解决方案描述了如何基于 Ceph 和 PostgreSQL 灾难恢复能力构建 GitLab 灾难恢复解决方案。该解决方案实现了 **热数据，冷计算** 架构，其中数据通过 Ceph 和 PostgreSQL 灾难恢复机制持续同步到备用集群。当主集群发生故障时，部署备用 GitLab 实例，备用 GitLab 将快速启动使用灾难恢复数据并提供服务。该解决方案主要关注数据灾难恢复处理，用户需要实现自己的 GitLab 访问地址切换机制。

## 环境

GitLab CE Operator: >=v17.11.1

## 术语

| 术语                               | 描述                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **主 GitLab**                       | 处理正常业务操作和用户请求的活动 GitLab 实例。该实例完全可用，所有组件均在运行。                                                                                      |
| **备用 GitLab**                     | 计划在不同集群/地域中部署的备用 GitLab 实例，在灾难恢复场景中保持待命状态，直到被激活。                                                                               |
| **主 PostgreSQL**                   | 处理所有数据事务的活动 PostgreSQL 数据库集群，并作为数据复制到备用数据库的源。                                                                                      |
| **备用 PostgreSQL**                 | 接收来自主数据库的实时数据复制的热备用 PostgreSQL 数据库。它可以在故障转移期间提升为主角色。                                                                         |
| **主对象存储**                     | 存储所有 GitLab 附件数据的活动 S3 兼容对象存储系统，并作为对象存储复制的源。                                                                                       |
| **备用对象存储**                   | 接收来自主存储的数据复制的同步备份对象存储系统。它确保在灾难恢复期间数据的可用性。                                                                                 |
| **Gitaly**                         | 负责 Git 仓库存储。                                                                                                                                                  |
| **Rails Secret**                   | GitLab Rails 应用程序用于加密敏感数据的加密密钥。主 GitLab 和备用 GitLab 实例 **必须使用相同的密钥**。                                                              |
| **恢复点目标 (RPO)**               | 在时间上可接受的最大数据丢失量（例如，5 分钟，1 小时）。它定义了在灾难期间可以丢失多少数据，直到变得不可接受。                                                      |
| **恢复时间目标 (RTO)**             | 在时间上可接受的最大停机时间（例如，15 分钟，2 小时）。它定义了系统在灾难后必须多快恢复。                                                                            |
| **故障转移**                       | 当主系统不可用或故障时，从主系统切换到备用系统的过程。                                                                                                              |
| **数据同步**                       | 从主系统到备用系统持续复制数据的过程，以保持一致性并启用灾难恢复。                                                                                                |
| **热数据，冷计算**                 | 一种架构模式，其中数据持续同步（热），而计算资源保持不活动（冷），直到故障转移。                                                                                    |

## 架构

![gitlab dr](../../public/gitlab-disaster-recovery.drawio.svg)

GitLab 灾难恢复解决方案实现了 GitLab 服务的 **热数据，冷计算架构**。该架构通过近实时数据同步和手动 GitLab 服务故障转移程序提供灾难恢复能力。该架构由两个部署在不同集群或地域的 GitLab 实例组成，备用 GitLab 实例在灾难场景中激活之前不会提前部署，而数据库和存储层保持持续同步。

### 数据同步策略

该解决方案利用三种独立的数据同步机制：

1. **数据库层**：PostgreSQL 流复制确保主数据库和备用数据库之间的实时事务日志同步，包括 GitLab 应用数据库和 Praefect 元数据数据库。
2. **Gitaly 存储层**：通过 Ceph 灾难恢复机制的块存储复制确保 Git 仓库数据同步到备用集群。
3. **附件存储层**：对象存储复制维护主存储和备用存储系统之间的 GitLab 附件数据一致性。

::: tip
以下数据存储在附件存储中。如果您评估这些数据不重要，可以选择不执行灾难恢复。

| 对象类型         | 功能描述                                         | 默认桶名称             |
| ------------------- | ------------------------------------------------ | --------------------- |
| uploads             | 用户上传的文件（头像、附件等）                   | gitlab-uploads        |
| lfs                 | Git LFS 大文件对象                               | gitlab-lfs            |
| artifacts           | CI/CD 作业工件                                   | gitlab-artifacts      |
| packages            | 包管理数据（例如，PyPI、Maven、NuGet）           | gitlab-packages       |
| external_mr_diffs   | 合并请求差异数据                                 | gitlab-mr-diffs       |
| terraform_state     | Terraform 状态文件                               | gitlab-terraform-state |
| ci_secure_files     | CI 安全文件（敏感证书、密钥等）                 | gitlab-ci-secure-files |
| dependency_proxy     | 依赖代理缓存                                   | gitlab-dependency-proxy |
| pages               | GitLab Pages 内容                                | gitlab-pages          |

:::

### 灾难恢复配置

1. **部署主 GitLab**：以高可用模式配置主实例，配置域访问，连接到主 PostgreSQL 数据库（GitLab 和 Praefect 数据库），使用主对象存储进行附件存储，并配置 Gitaly 使用块存储。
2. **准备备用 GitLab 部署环境**：配置备用实例所需的 PV、PVC 和 Secret 资源，以便在发生灾难时快速恢复。

### 故障转移程序

当发生灾难时，以下步骤确保切换到备用环境：

1. **验证主故障**：确认所有主 GitLab 组件不可用。
2. **提升数据库**：使用数据库故障转移程序将备用 PostgreSQL 提升为主。
3. **提升对象存储**：将备用对象存储激活为主。
4. **提升 Ceph RBD**：将备用 Ceph RBD 提升为主。
5. **恢复 Gitaly 使用的 PVC**：根据 Ceph 块存储灾难恢复文档，恢复备用集群中 Gitaly 使用的 PVC。
6. **部署备用 GitLab**：使用灾难恢复数据快速部署备用集群中的 GitLab 实例。
7. **更新路由**：切换外部访问地址以指向备用 GitLab 实例。

## GitLab 灾难恢复配置

::: warning

为了简化配置过程并降低配置难度，建议在主环境和备用环境中使用一致的信息，包括：

- 一致的数据库实例名称和密码
- 一致的 Redis 实例名称和密码
- 一致的 Ceph 存储池名称和存储类名称
- 一致的 GitLab 实例名称
- 一致的命名空间名称

:::

### 前提条件

1. 提前准备一个主集群和一个灾难恢复集群（或包含不同地域的集群）。
2. 完成 `Alauda support for PostgreSQL` 灾难恢复配置的部署。
3. 完成 `Alauda Build of Rook-Ceph` 对象存储灾难恢复配置的部署（[如果条件满足则可选](#data-synchronization-strategy)）。
4. 完成 `Alauda Build of Rook-Ceph` 块存储灾难恢复配置的部署。

:::warning
对于 `Alauda Build of Rook-Ceph` 块存储灾难恢复配置，您需要设置合理的 [同步间隔](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#create-volumereplicationclass)，这直接影响灾难恢复的 RPO 指标。
:::

### 使用 `Alauda support for PostgreSQL` 构建 PostgreSQL 灾难恢复集群

参考 `PostgreSQL Hot Standby Cluster Configuration Guide` 使用 `Alauda support for PostgreSQL` 构建灾难恢复集群。

确保主 PostgreSQL 和备用 PostgreSQL 在不同的集群（或不同的地域）中。

您可以在 [Alauda Knowledge](https://cloud.alauda.io/knowledges#/) 上搜索 `PostgreSQL Hot Standby Cluster Configuration Guide` 以获取该文档。

:::warning

`PostgreSQL Hot Standby Cluster Configuration Guide` 是一份描述如何使用 `Alauda support for PostgreSQL` 构建灾难恢复集群的文档。请确保在使用此配置时与适当的 ACP 版本兼容。

:::

### 使用 `Alauda Build of Rook-Ceph` 构建块存储灾难恢复集群

使用 `Alauda Build of Rook-Ceph` 构建块存储灾难恢复集群。参考 [块存储灾难恢复](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html) 文档以构建灾难恢复集群。

### 使用 `Alauda Build of Rook-Ceph` 构建对象存储灾难恢复集群

使用 `Alauda Build of Rook-Ceph` 构建对象存储灾难恢复集群。参考 [对象存储灾难恢复](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html) 文档以构建对象存储灾难恢复集群。

您需要提前创建一个 CephObjectStoreUser 以获取对象存储的访问凭证，并在主对象存储上准备一个 GitLab 对象存储桶：

1. 在主对象存储上创建一个 CephObjectStoreUser 以获取访问凭证：[创建 CephObjectStoreUser](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/create_object_user.html)。

   :::info
   您只需在主对象存储上创建 CephObjectStoreUser。用户信息将通过灾难恢复复制机制自动同步到备用对象存储。
   :::

2. 获取对象存储访问地址 `PRIMARY_OBJECT_STORAGE_ADDRESS`。您可以从 `对象存储灾难恢复` 的步骤 [配置主区域的外部访问](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html#configure-external-access-for-primary-zone) 中获取。

   ```bash
   $ mc alias set primary-s3 <PRIMARY_OBJECT_STORAGE_ADDRESS> <PRIMARY_OBJECT_STORAGE_ACCESS_KEY> <PRIMARY_OBJECT_STORAGE_SECRET_KEY>
   Added `primary-s3` successfully.
   $ mc alias list
   primary-s3
     URL       : <PRIMARY_OBJECT_STORAGE_ADDRESS>
     AccessKey : <PRIMARY_OBJECT_STORAGE_ACCESS_KEY>
     SecretKey : <PRIMARY_OBJECT_STORAGE_SECRET_KEY>
     API       : s3v4
     Path      : auto
     Src       : /home/demo/.mc/config.json
   ```

3. 使用 mc 在主对象存储上创建 GitLab 对象存储桶。在此示例中，创建了两个桶 `gitlab-uploads` 和 `gitlab-lfs`。

   ```bash
   # 创建
   mc mb primary-s3/gitlab-uploads
   mc mb primary-s3/gitlab-lfs

   # 检查
   mc ls primary-s3/gitlab-uploads
   mc ls primary-s3/gitlab-lfs
   ```

   :::info
   根据使用的 GitLab 功能，您可能还需要使用 [其他桶](#data-synchronization-strategy)，可以根据需要创建。
   :::

### 设置主 GitLab

按照 [GitLab 实例部署](https://docs.alauda.io/alauda-build-of-gitlab/17.11/en/install/03_gitlab_deploy.html#deploying-from-the-gitlab-high-availability-template) 指南部署主 GitLab 实例。以高可用模式配置，配置域访问，连接到主 PostgreSQL 数据库（GitLab 应用数据库和 Praefect 数据库），使用主对象存储进行附件存储，并配置 Gitaly 使用主块存储。

配置示例（仅包括与灾难恢复相关的配置项，完整配置项请参见产品文档）：

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: GitlabOfficial
metadata:
  name: <GITLAB_NAME>
  namespace: <GITLAB_NAMESPACE>
spec:
  externalURL: http://gitlab-ha.example.com # GitLab 访问域
  helmValues:
    gitlab:
      gitaly:
        persistence: # 配置 gitaly 存储，使用 ceph RBD 存储类，高可用模式将自动创建 3 个副本
          enabled: true
          size: 5Gi
          storageClass: ceph-rdb # 存储类名称，指定为灾难恢复配置的存储类
      webservice:
        ingress:
          enabled: true
    global:
      appConfig:
        object_store:
          connection: # 配置对象存储，连接到主对象存储
            secret: gitlab-object-storage
            key: connection
          enabled: true
      praefect: # 配置 praefect 数据库，连接到主 PostgreSQL 数据库
        dbSecret:
          key: password
          secret: gitlab-pg-prefact
        enabled: true
        psql:
          dbName: gitlab_prefact
          host: acid-gitlab.test.svc
          port: 5432
          sslMode: require
          user: postgres
        virtualStorages:
          - gitalyReplicas: 3
            maxUnavailable: 1
            name: default
      psql: # 配置应用数据库，连接到主 PostgreSQL 数据库
        database: gitlab
        host: acid-gitlab.test.svc
        password:
          key: password
          secret: gitlab-pg
        port: 5432
        username: postgres
```

在部署主 GitLab 后，您需要为 Gitaly 组件使用的 PVC 配置 RBD 镜像。配置后，PVC 数据将定期同步到备用 Ceph 集群。有关具体参数配置，请参考 [Ceph RBD 镜像](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#enable-mirror-for-pvc)。

```bash
cat << EOF | kubectl apply -f -
apiVersion: replication.storage.openshift.io/v1alpha1
kind: VolumeReplication
metadata:
  name: <GITALY_PVC_NAME>
  namespace: <GITLAB_NAMESPACE>
spec:
  autoResync: true # 自动重新同步
  volumeReplicationClass: rbd-volumereplicationclass
  replicationState: primary # 标记为主集群
  dataSource:
    apiGroup: ""
    kind: PersistentVolumeClaim
    name: <GITALY_PVC_NAME>
EOF
```

检查 Ceph RBD 镜像状态。您可以看到 Gitaly 的所有三个 PVC 已配置为 Ceph RBD 镜像。

```bash
❯ kubectl -n $GITLAB_NAMESPACE get volumereplication
NAME                                      AGE   VOLUMEREPLICATIONCLASS       PVCNAME                                   DESIREDSTATE   CURRENTSTATE
repo-data-dr-gitlab-ha-gitaly-default-0   15s   rbd-volumereplicationclass   repo-data-dr-gitlab-ha-gitaly-default-0   primary        Primary
repo-data-dr-gitlab-ha-gitaly-default-1   15s   rbd-volumereplicationclass   repo-data-dr-gitlab-ha-gitaly-default-1   primary        Primary
repo-data-dr-gitlab-ha-gitaly-default-2   14s   rbd-volumereplicationclass   repo-data-dr-gitlab-ha-gitaly-default-2   primary        Primary
```

从 Ceph 侧检查 Ceph RBD 镜像状态。`CEPH_BLOCK_POOL` 是 Ceph RBD 存储池的名称。`SCHEDULE` 列指示同步频率（下面的示例显示每 1 分钟同步一次）。

```bash
❯ kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- rbd mirror snapshot schedule ls --pool $CEPH_BLOCK_POOL --recursive
POOL     NAMESPACE  IMAGE                                         SCHEDULE
myblock             csi-vol-135ec569-0a3a-49c1-a0b1-46d669510200  every 1m
myblock             csi-vol-459e6f28-a158-4ae9-b5da-163448c35119  every 1m
myblock             csi-vol-7f13040d-d543-40ed-b416-3ecf639cf4c9  every 1m
```

检查 Ceph RBD 镜像状态。状态为 `up+stopped`（主集群正常）和 peer_sites.state 为 `up+replaying`（备用集群正常）表示同步正常。

```bash
❯ kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- rbd mirror image status $CEPH_BLOCK_POOL/$GITALY_BLOCK_IMAGE_NAME
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

### 设置备用 GitLab

:::warning
当 Ceph RBD 处于备用状态时，同步的存储块无法挂载，因此备用集群中的 GitLab 无法成功部署。

如果您需要验证备用集群中的 GitLab 是否可以成功部署，您可以暂时将备用集群的 Ceph RBD 提升为主，测试完成后再将其设置回备用状态。同时，您需要删除测试期间创建的所有 gitlabofficial、PV 和 PVC 资源。
:::

1. 备份主 GitLab 使用的 Secrets。
2. 备份主集群 GitLab Gitaly 组件的 PVC 和 PV 资源 YAML（注意：高可用模式将至少有 3 个 PVC 和 PV 资源）。
3. 备份主集群 GitLab gitlabofficial 资源 YAML。
4. 部署备用 GitLab 使用的 Redis 实例。

#### 备份主 GitLab 使用的 Secrets

获取主 GitLab 使用的 PostgreSQL Secret YAML，并在备用集群中以相同的命名空间名称创建该 Secret。

```bash
export GITLAB_NAMESPACE=<ns-of-gitlab-instance>
export GITLAB_NAME=<name-of-gitlab-instance>
```

```bash
# PostgreSQL Secret
PG_SECRET=$(kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -o jsonpath='{.spec.helmValues.global.psql.password.secret}')
[[ -n "$PG_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$PG_SECRET" -o yaml > pg-secret.yaml

# Praefect PostgreSQL Secret
PRAEFECT_PG_SECRET=$(kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -o jsonpath='{.spec.helmValues.global.praefect.dbSecret.secret}')
[[ -n "$PRAEFECT_PG_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$PRAEFECT_PG_SECRET" -o yaml > praefect-secret.yaml

# Rails Secret
RAILS_SECRET=$(kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -o jsonpath='{.spec.helmValues.global.railsSecrets.secret}' || echo "${GITLAB_NAME}-rails-secret")
[[ -z "$RAILS_SECRET" ]] && export RAILS_SECRET="${GITLAB_NAME}-rails-secret" # 如果未找到则使用默认密钥名称
[[ -n "$RAILS_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$RAILS_SECRET" -o yaml > rails-secret.yaml

# 对象存储 Secret
OBJECT_STORAGE_SECRET=$(kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -o jsonpath='{.spec.helmValues.global.appConfig.object_store.connection.secret}')
[[ -n "$OBJECT_STORAGE_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$OBJECT_STORAGE_SECRET" -o yaml > object-storage-secret.yaml

# Root 密码 Secret
ROOT_USER_SECRET=$(kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -o jsonpath='{.spec.helmValues.global.initialRootPassword.secret}')
[[ -n "$ROOT_USER_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$ROOT_USER_SECRET" -o yaml > root-user-secret.yaml
```

对备份的文件进行以下修改：

- pg-secret.yaml：将 `host` 和 `password` 字段更改为备用集群的 PostgreSQL 连接地址和密码。
- praefect-secret.yaml：将 `host` 和 `password` 字段更改为备用集群的 Praefect PostgreSQL 连接地址和密码。
- object-storage-secret.yaml：将 `connection` 中的 `endpoint` 字段更改为备用集群的对象存储连接地址。

在灾难恢复环境中以相同的命名空间名称创建备份的 YAML 文件。

#### 备份主 GitLab Gitaly 组件的 PVC 和 PV 资源

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

执行以下命令将主 GitLab Gitaly 组件的 PVC 和 PV 资源备份到当前目录（如果使用了其他 PVC，则需要手动备份）：

```bash
kubectl -n "$GITLAB_NAMESPACE" \
  get pvc -l app=gitaly,release="$GITLAB_NAME" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' \
| while read -r pvc; do

  echo "=>  Exporting PVC $pvc"

  # 导出 PVC
  kubectl -n "$GITLAB_NAMESPACE" get pvc "$pvc" -o yaml > "pvc-${pvc}.yaml"

  # 获取 PV
  PV=$(kubectl -n "$GITLAB_NAMESPACE" get pvc "$pvc" -o jsonpath='{.spec.volumeName}')

  if [[ -n "$PV" ]]; then
    echo "   ↳ Exporting PV $PV"
    kubectl get pv "$PV" -o yaml > "pv-${PV}.yaml"
  fi

  echo ""
done
```

修改三个备份的 PV 文件，并删除 YAML 中所有的 `spec.claimRef` 字段。

在灾难恢复环境中直接创建备份的 PVC 和 PV YAML 文件，使用相同的命名空间名称。

#### 备份主 GitLab 实例 YAML

```bash
kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -oyaml > gitlabofficial.yaml
```

根据灾难恢复环境的实际情况修改 `gitlabofficial.yaml` 中的信息，包括 PostgreSQL 连接地址、Redis 连接地址等。

:::warning
`GitlabOfficial` 资源 **不需要** 立即在灾难恢复环境中创建。仅在发生灾难并执行灾难恢复切换时，才需要在备用集群中创建。
:::

:::warning
如果您需要进行灾难恢复演练，可以按照 [灾难场景中的主-备用切换程序](#primary-secondary-switchover-procedure-in-disaster-scenarios) 的步骤进行演练。演练完成后，您需要在灾难恢复环境中执行以下清理操作：

- 删除灾难恢复环境中的 `GitlabOfficial` 实例
- 删除创建的 PVC 和 PV
- 将 PostgreSQL 集群切换为备用状态
- 将 Ceph 对象存储切换为备用状态
- 将 Ceph RBD 切换为备用状态

:::

#### 部署备用 GitLab 使用的 Redis 实例

参考主集群的 Redis 实例配置，在灾难恢复环境中使用相同的实例名称和密码部署 Redis 实例，并使用相同的命名空间名称。

### 恢复目标

#### 恢复点目标 (RPO)

RPO 表示在灾难恢复场景中可接受的最大数据丢失。 在此 GitLab 灾难恢复解决方案中：

- **数据库层**：由于 PostgreSQL 热备用流复制，数据丢失接近零（适用于 GitLab 应用数据库和 Praefect 元数据数据库）。
- **附件存储层**：由于 GitLab 附件存储使用的对象存储流复制，数据丢失接近零。
- **Gitaly 存储层**：由于 Ceph RBD 块存储复制用于 Git 仓库数据，通过计划快照同步，数据丢失取决于同步间隔，可以 [配置](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#create-volumereplicationclass)。
- **整体 RPO**：整体 RPO 取决于 Ceph RBD 块存储复制的同步间隔。

#### 恢复时间目标 (RTO)

RTO 表示在灾难恢复期间可接受的最大停机时间。该解决方案提供：

- **手动组件**：GitLab 服务激活和外部路由更新需要手动干预。
- **典型 RTO**：完整服务恢复需要 6-16 分钟。

**RTO 细分：**

- 数据库故障转移：1-2 分钟（手动）
- 对象存储故障转移：1-2 分钟（手动）
- Ceph RBD 故障转移：1-2 分钟（手动）
- GitLab 服务激活：2-5 分钟（手动）
- 外部路由更新：1-5 分钟（手动，取决于 DNS 传播）

## 灾难场景中的主-备用切换程序

1. **确认主 GitLab 故障**：确认所有主 GitLab 组件处于非工作状态，否则首先停止所有主 GitLab 组件。

2. **提升备用 PostgreSQL**：将备用 PostgreSQL 提升为主 PostgreSQL。参考 `PostgreSQL Hot Standby Cluster Configuration Guide` 中的切换程序。

3. **提升备用对象存储**：将备用对象存储提升为主对象存储。参考 [Alauda Build of Rook-Ceph 故障转移](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html#procedures-1) 中的切换程序。

4. **提升备用 Ceph RBD**：将备用 Ceph RBD 提升为主 Ceph RBD。参考 [Alauda Build of Rook-Ceph 故障转移](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#procedures-1) 中的切换程序。

5. **恢复 PVC 和 PV 资源**：将备份的 PVC 和 PV 资源恢复到灾难恢复环境中，使用相同的命名空间名称，并检查备用集群中的 PVC 状态是否为 `Bound`：

   ```bash
   ❯ kubectl -n $GITLAB_NAMESPACE get pvc,pv
   NAME                                                            STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   VOLUMEATTRIBUTESCLASS   AGE
   persistentvolumeclaim/repo-data-dr-gitlab-ha-gitaly-default-0   Bound    pvc-231a9021-2548-433e-8583-f7b56d74aca7   5Gi        RWO            ceph-rdb       <unset>                 45s
   persistentvolumeclaim/repo-data-dr-gitlab-ha-gitaly-default-1   Bound    pvc-2995a8a7-648c-4e99-a3d3-c73a483a601b   5Gi        RWO            ceph-rdb       <unset>                 30s
   persistentvolumeclaim/repo-data-dr-gitlab-ha-gitaly-default-2   Bound    pvc-e4a94d84-d5e2-419f-bbbd-285fa88b6b5e   5Gi        RWO            ceph-rdb       <unset>                 19s

   NAME                                                        CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM                                             STORAGECLASS   VOLUMEATTRIBUTESCLASS   REASON   AGE
   persistentvolume/pvc-231a9021-2548-433e-8583-f7b56d74aca7   5Gi        RWO            Delete           Bound    fm-1-ns/repo-data-dr-gitlab-ha-gitaly-default-0   ceph-rdb       <unset>                          63s
   persistentvolume/pvc-2995a8a7-648c-4e99-a3d3-c73a483a601b   5Gi        RWO            Delete           Bound    fm-1-ns/repo-data-dr-gitlab-ha-gitaly-default-1   ceph-rdb       <unset>                          30s
   persistentvolume/pvc-e4a94d84-d5e2-419f-bbbd-285fa88b6b5e   5Gi        RWO            Delete           Bound    fm-1-ns/repo-data-dr-gitlab-ha-gitaly-default-2   ceph-rdb       <unset>                          19s
   ```

6. **部署备用 GitLab**：将备份的 `gitlabofficial.yaml` 恢复到灾难恢复环境中，使用相同的命名空间名称。GitLab 将自动开始使用灾难恢复数据。

7. **验证 GitLab 组件**：验证所有 GitLab 组件是否正在运行并健康。测试 GitLab 功能（仓库访问、CI/CD 管道、用户身份验证）以验证 GitLab 是否正常工作。

8. **切换访问地址**：切换外部访问地址以指向备用 GitLab。

## 使用其他对象存储和 PostgreSQL 构建 GitLab 灾难恢复解决方案

操作步骤与使用 `Alauda Build of Rook-Ceph` 和 `Alauda support for PostgreSQL` 构建 GitLab 灾难恢复解决方案类似。只需将存储和 PostgreSQL 替换为支持灾难恢复的其他对象存储和 PostgreSQL 解决方案。

:::warning
确保所选的存储和 PostgreSQL 解决方案支持灾难恢复能力，并在生产环境中使用之前进行充分的灾难恢复演练。
:::
