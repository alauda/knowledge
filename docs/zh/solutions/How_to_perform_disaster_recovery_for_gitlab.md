---
kind:
   - Solution
products:
  - Alauda DevOps
ProductsVersion:
   - 4.x
id: TODO
---

# 如何为 GitLab 执行灾难恢复

## 问题

本解决方案描述了如何基于 Ceph 和 PostgreSQL 的灾难恢复能力构建 GitLab 灾难恢复解决方案。该解决方案实现了**热数据、冷计算**架构，其中数据通过 Ceph 和 PostgreSQL 灾难恢复机制持续同步到备用集群，当主集群发生故障时部署备用 GitLab 实例，备用 GitLab 会使用容灾数据快速启动并提供服务。该解决方案主要关注数据灾难恢复处理，用户需要自行实现 GitLab 访问地址切换机制。

## 环境

GitLab CE Operator: >=v17.11.1

## 术语

| 术语                    | 描述                                                                 |
|-------------------------|-----------------------------------------------------------------------------|
| **主 GitLab**      | 处理正常业务操作和用户请求的活跃 GitLab 实例。该实例完全运行，所有组件都在运行。 |
| **备用 GitLab**    | 计划部署在不同集群/区域的备用 GitLab 实例，在灾难恢复场景激活之前保持休眠状态。 |
| **主 PostgreSQL**  | 处理所有数据事务的活跃 PostgreSQL 数据库集群，作为数据复制到备用数据库的源。 |
| **备用 PostgreSQL**| 从主数据库接收实时数据复制的热备用 PostgreSQL 数据库。它可以在故障转移期间提升为主角色。 |
| **主对象存储**| 存储所有 GitLab 附件数据的活跃 S3 兼容对象存储系统，作为对象存储复制的源。 |
| **备用对象存储**| 从主对象存储接收数据复制的同步备份对象存储系统。它确保在灾难恢复期间的数据可用性。 |
| **Gitaly**              | 负责 Git 仓库存储。 |
| **Rails Secret**| GitLab Rails 应用程序用于加密敏感数据的加密密钥。主 GitLab 和备用 GitLab 实例**必须使用相同的密钥**。 |
| **恢复点目标 (RPO)** | 以时间衡量的最大可接受数据丢失量（例如，5 分钟，1 小时）。它定义了在灾难发生前可以丢失多少数据才变得不可接受。 |
| **恢复时间目标 (RTO)** | 以时间衡量的最大可接受停机时间（例如，15 分钟，2 小时）。它定义了系统在灾难后必须恢复的速度。 |
| **故障转移**            | 当主系统变得不可用或失败时，从主系统切换到备用系统的过程。 |
| **数据同步**| 从主系统到备用系统持续复制数据以保持一致性并启用灾难恢复的过程。 |
| **热数据，冷计算**| 一种架构模式，其中数据持续同步（热），而计算资源保持非活动状态（冷），直到故障转移。 |

## 架构

![gitlab dr](../../public/gitlab-disaster-recovery.drawio.svg)

GitLab 灾难恢复解决方案为 GitLab 服务实现了**热数据、冷计算架构**。这种架构通过准实时数据同步和手动 GitLab 服务故障转移程序提供灾难恢复能力。架构由部署在不同集群或区域的两个 GitLab 实例组成，备用 GitLab 并不会提前部署，直到在灾难场景中激活，而数据库和存储层保持持续同步。

### 核心组件

- **主 GitLab**：处理正常业务操作和用户请求的活跃实例，所有组件都在运行（webservice、sidekiq、gitlab-shell、gitaly）
- **备用 GitLab**：所有组件副本数为零的备用实例，准备用于故障转移场景
- **主 PostgreSQL**：处理所有数据事务的活跃数据库，包括 GitLab 应用程序数据和 Praefect 元数据
- **备用 PostgreSQL**：从主数据库实时数据复制的热备用数据库
- **主对象存储**：用于 GitLab 附件和上传的活跃 S3 兼容存储
- **备用对象存储**：从主存储数据复制的同步备份存储
- **主 Gitaly 存储**：主集群上用于 Git 仓库数据的块存储
- **备用 Gitaly 存储**：通过 Ceph 灾难恢复机制同步的块存储

### 数据同步策略

该解决方案利用三种独立的数据同步机制：

1. **数据库层**：通过 PostgreSQL 流式复制确保主数据库和备用数据库之间的实时事务日志同步，包括 GitLab 应用程序数据库和 Praefect 元数据数据库
2. **Gitaly 存储层**：通过 Ceph 灾难恢复机制的块存储复制确保 Git 仓库数据同步到备用集群
3. **附件存储层**：通过对象存储复制保持主存储和备用存储系统之间 GitLab 附件数据一致性

::: tip
附件存储中保存以下数据，如果评估这些数据不重要，可以选择不进行容灾。

| 对象类型           | 功能说明 | 默认 bucket 名称 |
|--------------------|----------|--------------------|
| uploads            | 用户上传文件（头像、附件等） | gitlab-uploads |
| lfs                | Git LFS 大文件对象 | gitlab-lfs |
| artifacts          | CI/CD Job 产物（artifacts） | gitlab-artifacts |
| packages           | 包管理数据（如 PyPI、Maven、NuGet） | gitlab-packages |
| external_mr_diffs     | Merge Request 差异数据 | gitlab-mr-diffs |
| terraform_state    | Terraform 状态文件 | gitlab-terraform-state |
| ci_secure_files    | CI 安全文件（敏感证书、密钥等） | gitlab-ci-secure-files |
| dependency_proxy   | 依赖代理缓存 | gitlab-dependency-proxy |
| pages              | GitLab Pages 内容 | gitlab-pages |

:::

### 灾难恢复配置

1. **部署主 GitLab**：在高可用模式下配置主实例，配置域名访问，连接到主 PostgreSQL 数据库（GitLab 和 Praefect 数据库），使用主对象存储存储附件，并配置 Gitaly 使用块存储
2. **准备备用 GitLab 部署环境**：配置备用实例所需要的 pv、pvc 和 secret 资源，以便于灾难发生时快速恢复

### 故障转移程序

当发生灾难时，以下步骤确保转换到备用环境：

1. **验证主故障**：确认所有主 GitLab 组件都不可用
2. **提升数据库**：使用数据库故障转移程序将备用 PostgreSQL 提升为主
3. **提升对象存储**：将备用对象存储激活为主
4. **提升 Ceph RBD**：将备用 Ceph RBD 提升为主
5. **恢复 Gitaly 所使用的 PVC**：根据 Ceph 块存储灾难恢复文档，将 Gitaly 所使用的 PVC 在备集群恢复
6. **部署备用 GitLab**：在备集群使用灾备数据快速部署 GitLab 实例
7. **更新路由**：将外部访问地址切换到指向备用 GitLab 实例

## GitLab 容灾配置

::: warning

为了简化配置过程，降低配置难度，推荐主备两个环境中使用一致的信息，包括：

- 一致的数据库实例名称和密码
- 一致的 Redis 实例名称和密码
- 一致的 Ceph 存储池名称和存储类名称
- 一致的 GitLab 实例名称
- 一致的命名空间名称

:::

### 前置条件

1. 提前准备一个主集群和一个灾难恢复集群（或包含不同区域的集群）。
2. 完成 `Alauda support for PostgreSQL` 灾难恢复配置的部署。
3. 完成 `Alauda Build of Rook-Ceph` 对象存储的灾难恢复配置的部署（[满足条件可选](#数据同步策略)）。
4. 完成 `Alauda Build of Rook-Ceph` 块存储的灾难恢复配置的部署。

:::warning
`Alauda Build of Rook-Ceph` 块存储的灾难恢复配置，需要设置合理的[同步间隔时间](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#create-volumereplicationclass)，这会直接影响容灾的 RPO 指标。
:::

### 使用 `Alauda support for PostgreSQL` 构建 PostgreSQL 灾难恢复集群

参考 `PostgreSQL 热备用集群配置指南`，使用 `Alauda support for PostgreSQL` 构建灾难恢复集群。

确保主 PostgreSQL 和备用 PostgreSQL 位于不同的集群（或不同的区域）。

您可以在 [Alauda Knowledge](https://cloud.alauda.io/knowledges#/) 上搜索 `PostgreSQL 热备用集群配置指南` 来获取它。

:::warning

`PostgreSQL 热备用集群配置指南` 是一份描述如何使用 `Alauda support for PostgreSQL` 构建灾难恢复集群的文档。使用此配置时，请确保与相应的 ACP 版本兼容。

:::

### 使用 `Alauda Build of Rook-Ceph` 构建块存储灾难恢复集群

使用 `Alauda Build of Rook-Ceph` 构建块存储灾难恢复集群。参考 [块存储灾难恢复](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html) 文档构建灾难恢复集群。

### 使用 `Alauda Build of Rook-Ceph` 构建对象存储灾难恢复集群

使用 `Alauda Build of Rook-Ceph` 构建对象存储灾难恢复集群。参考 [对象存储灾难恢复](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html) 文档构建对象存储灾难恢复集群。

您需要提前创建一个 CephObjectStoreUser 以获取对象存储的访问凭据，并在主对象存储上准备一个 GitLab 对象存储桶：

1. 在主对象存储上创建一个 CephObjectStoreUser 以获取访问凭据：[创建 CephObjectStoreUser](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/create_object_user.html)。

   :::info
   您只需要在主对象存储上创建 CephObjectStoreUser。用户信息将通过灾难恢复复制机制自动同步到备用对象存储。
   :::

2. 获取对象存储的访问地址 `PRIMARY_OBJECT_STORAGE_ADDRESS`，您可以从 `对象存储灾难恢复` 的步骤 [为主区域配置外部访问](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html#configure-external-access-for-primary-zone) 中获取。

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

3. 使用 mc 在主对象存储上创建 GitLab 对象存储桶，在此示例中，创建了 `gitlab-uploads` 和 `gitlab-lfs` 两个存储桶。

    ```bash
    # 创建
    mc mb primary-s3/gitlab-uploads
    mc mb primary-s3/gitlab-lfs

    # 检查
    mc ls primary-s3/gitlab-uploads
    mc ls primary-s3/gitlab-lfs
    ```

    :::info
    根据使用的 GitLab 功能不同，可能还需要使用到[其他存储桶](#数据同步策略)，可按照需要创建。
    :::

### 设置主 GitLab

按照 [GitLab 实例部署](https://docs.alauda.cn/alauda-build-of-gitlab/17.11/en/install/03_gitlab_deploy.html#deploying-from-the-gitlab-high-availability-template) 指南部署主 GitLab 实例。在高可用模式下配置它，配置域名访问，连接到主 PostgreSQL 数据库（GitLab 应用程序数据库和 Praefect 数据库），使用主对象存储存储附件，并配置 Gitaly 使用主块存储。

配置示例（仅包含了容灾关注的配置项，完整配置项见产品文档）：

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: GitlabOfficial
metadata:
  name: <GITLAB_NAME>
  namespace: <GITLAB_NAMESPACE>
spec:
  externalURL: http://gitlab-ha.example.com # GitLab 访问域名
  helmValues:
    gitlab:
      gitaly:
        persistence: # 配置 gitaly 存储，使用 ceph RBD 存储类，因为是高可用模式，会自动创建3个副本
          enabled: true
          size: 5Gi
          storageClass: ceph-rdb # 存储类名称，指定为配置到好了容灾的存储类
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

部署主 GitLab 后，需要为 Gitaly 组件使用的 PVC 配置 RBD Mirror，配置后才会将 PVC 数据定时同步到备 Ceph 集群。具体参数配置参考 [Ceph RBD Mirror](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#enable-mirror-for-pvc)。

```bash
cat << EOF | kubectl apply -f -
apiVersion: replication.storage.openshift.io/v1alpha1
kind: VolumeReplication
metadata:
  name: <GITALY_PVC_NAME>
  namespace: <GITLAB_NAMESPACE>
spec:
  autoResync: true # 自动同步
  volumeReplicationClass: rbd-volumereplicationclass
  replicationState: primary # 标记为主集群
  dataSource:
    apiGroup: ""
    kind: PersistentVolumeClaim
    name: <GITALY_PVC_NAME>
EOF
```

检查 Ceph RBD Mirror 状态，可以看到 Gitaly 的三个 pvc 都已经配置了 Ceph RBD Mirror。

```bash
❯ kubectl -n $GITLAB_NAMESPACE get volumereplication
NAME                                      AGE   VOLUMEREPLICATIONCLASS       PVCNAME                                   DESIREDSTATE   CURRENTSTATE
repo-data-dr-gitlab-ha-gitaly-default-0   15s   rbd-volumereplicationclass   repo-data-dr-gitlab-ha-gitaly-default-0   primary        Primary
repo-data-dr-gitlab-ha-gitaly-default-1   15s   rbd-volumereplicationclass   repo-data-dr-gitlab-ha-gitaly-default-1   primary        Primary
repo-data-dr-gitlab-ha-gitaly-default-2   14s   rbd-volumereplicationclass   repo-data-dr-gitlab-ha-gitaly-default-2   primary        Primary
```

从 Ceph 端查看 Ceph RBD Mirror 状态，`CEPH_BLOCK_POOL` 是 Ceph RBD 存储池的名称。`SCHEDULE` 列标识了同步的频率（下面的示例是 1 分钟同步一次）。

```bash
❯ kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- rbd mirror snapshot schedule ls --pool $CEPH_BLOCK_POOL --recursive
POOL     NAMESPACE  IMAGE                                         SCHEDULE
myblock             csi-vol-135ec569-0a3a-49c1-a0b1-46d669510200  every 1m
myblock             csi-vol-459e6f28-a158-4ae9-b5da-163448c35119  every 1m
myblock             csi-vol-7f13040d-d543-40ed-b416-3ecf639cf4c9  every 1m
```

检查 Ceph RBD Mirror 状态，state 为 `up+stopped`（主集群正常）并且 peer_sites.state 为 `up+replaying`（备集群正常）表示同步正常。

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
当 Ceph RBD 处于备用状态时，同步过来的存储块无法挂载，因此备集群的 GitLab 无法部署成功。

如需验证备集群 GitLab 是否可以部署成功，可以临时将备集群的 Ceph RBD 提升为主集群，测试完成后再设置回备用状态。同时需要将测试过程中创建的 gitlabofficial、PV 和 PVC 资源都删除。
:::

1. 备份主 GitLab 使用的 Secret
2. 备份主集群 GitLab Gitaly 组件的 PVC 和 PV 资源 YAML（注意，高可用模式至少会有3个 PVC 和 PV 资源）
3. 备份主集群 GitLab 的 gitlabofficial 资源 YAML
4. 部署备 GitLab 使用的 Redis 实例

#### 备份主 GitLab 使用的 Secret

获取主 GitLab 使用的 PostgreSQL Secret YAML，并将 Secret 创建到备集群同名命名空间中。

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
[[ -z "$RAILS_SECRET" ]] && export RAILS_SECRET="${GITLAB_NAME}-rails-secret" # use default secret name if not found
[[ -n "$RAILS_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$RAILS_SECRET" -o yaml > rails-secret.yaml

# Object Storage Secret
OBJECT_STORAGE_SECRET=$(kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -o jsonpath='{.spec.helmValues.global.appConfig.object_store.connection.secret}')
[[ -n "$OBJECT_STORAGE_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$OBJECT_STORAGE_SECRET" -o yaml > object-storage-secret.yaml

# Root Password Secret
ROOT_USER_SECRET=$(kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -o jsonpath='{.spec.helmValues.global.initialRootPassword.secret}')
[[ -n "$ROOT_USER_SECRET" ]] && kubectl -n "$GITLAB_NAMESPACE" get secret "$ROOT_USER_SECRET" -o yaml > root-user-secret.yaml
```

对备份出来的文件做如下修改：

- pg-secret.yaml：将 `host` 和 `password` 字段改成备集群的 PostgreSQL 连接地址和密码
- praefect-secret.yaml：将 `host` 和 `password` 字段改成备集群的 Praefect PostgreSQL 连接地址和密码
- object-storage-secret.yaml：将 `connection` 中的 `endpoint` 字段改成备集群的对象存储连接地址

将备份的 YAML 文件在容灾环境同名命名空间中创建。

#### 备份主 GitLab Gitaly 组件的 PVC 和 PV 资源

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

执行以下命令将主 GitLab Gitaly 组件的 PVC 和 PV 资源备份到当前目录（如果使用的是其他 PVC，需要手动备份）：

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

修改备份出来的三个 pv 文件，将 yaml 中的 `spec.claimRef` 字段全部删除。

将备份出来的 PVC 和 PV YAML 文件直接创建到容灾环境同名命名空间中。

#### 备份主 GitLab 实例 YAML

```bash
kubectl -n "$GITLAB_NAMESPACE" get gitlabofficial "$GITLAB_NAME" -oyaml > gitlabofficial.yaml
```

根据容灾环境实际情况修改 `gitlabofficial.yaml` 中的信息，包括 PostgreSQL 连接地址、Redis 连接地址等。

:::warning
`GitlabOfficial` 资源**不需要**立即创建在容灾环境，只需要在灾难发生时，执行容灾切换时创建到备集群即可。
:::

:::warning
如需进行容灾演练，可以按照 [灾难切换](#灾难切换) 中的步骤进行演练。演练完毕后需要在容灾环境完成以下清理操作：

- 将容灾环境中的 `GitlabOfficial` 实例删除
- 将创建的 PVC 和 PV 删除
- 将 PostgreSQL 集群切换为备用状态
- 将 Ceph 对象存储切换为备用状态
- 将 Ceph RBD 切换为备用状态

:::

#### 部署备 GitLab 使用的 Redis 实例

参考主集群的 redis 实例配置，使用相同的实例名称和密码在容灾环境同名命名空间部署 Redis 实例。

### 恢复目标

#### 恢复点目标 (RPO)

RPO 表示在灾难恢复场景中最大可接受的数据丢失。在此 GitLab 灾难恢复解决方案中：

- **数据库层**：由于 PostgreSQL 热备用流式复制（适用于 GitLab 应用程序数据库和 Praefect 元数据数据库），数据丢失接近零
- **附件存储层**：由于 GitLab 附件存储使用的对象存储流式复制，数据丢失接近零
- **Gitaly 存储层**：由于 Git 仓库数据的 Ceph RBD 块存储复制，通过快照定时同步，数据丢失情况取决于同步间隔，间隔时间可以[配置](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#create-volumereplicationclass)
- **总体 RPO**：总体 RPO 取决 Ceph RBD 块存储复制的同步间隔时间。

#### 恢复时间目标 (RTO)

RTO 表示在灾难恢复期间最大可接受的停机时间。此解决方案提供：

- **手动组件**：GitLab 服务激活和外部路由更新需要手动干预
- **典型 RTO**：完整服务恢复需要 6-16 分钟

**RTO 分解：**

- 数据库故障转移：1-2 分钟（手动）
- 对象存储故障转移：1-2 分钟（手动）
- Ceph RBD 故障转移：1-2 分钟（手动）
- GitLab 服务激活：2-5 分钟（手动）
- 外部路由更新：1-5 分钟（手动，取决于 DNS 传播）

## 灾难切换

1. **确认主 GitLab 故障**：确认所有主 GitLab 组件都处于非工作状态，否则先停止所有主 GitLab 组件。

2. **提升备用 PostgreSQL**：将备用 PostgreSQL 提升为主 PostgreSQL。参考 `PostgreSQL 热备用集群配置指南` 的切换程序。

3. **提升备用对象存储**：将备用对象存储提升为主对象存储。参考 [Alauda Build of Rook-Ceph 故障转移](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_object.html#procedures-1) 的切换程序。

4. **提升备用 Ceph RBD**：将备用 Ceph RBD 提升为主 Ceph RBD。参考 [Alauda Build of Rook-Ceph 故障转移](https://docs.alauda.cn/container_platform/4.1/storage/storagesystem_ceph/how_to/disaster_recovery/dr_block.html#procedures-1) 的切换程序。

5. **恢复 PVC 和 PV 资源**：恢复备份的 PVC 和 PV 资源到容灾环境同名命名空间中，并检查备集群 PVC 状态是否为 `Bound` 状态：

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

6. **部署备用 GitLab**：恢复备份的 `gitlabofficial.yaml` 到容灾环境同名命名空间中。GitLab 会利用容灾数据自动启动。

7. **验证 GitLab 组件**：验证所有 GitLab 组件正在运行且健康。测试 GitLab 功能（仓库访问、CI/CD 流水线、用户认证）以验证 GitLab 是否正常工作。

8. **切换访问地址**：将外部访问地址切换到备用 GitLab。



## 使用其他对象存储和 PostgreSQL 构建 GitLab 灾难恢复解决方案

操作步骤与使用 `Alauda Build of Rook-Ceph` 和 `Alauda support for PostgreSQL` 构建 GitLab 灾难恢复解决方案类似。只需将存储和 PostgreSQL 替换为其他支持灾难恢复的存储和 PostgreSQL 解决方案。

:::warning
确保所选存储和 PostgreSQL 解决方案支持灾难恢复能力，并在生产环境使用前进行充分的容灾演练。
:::
