---
products:
  - Alauda Application Services
kind:
  - Solution
id: KB260100026
sourceSHA: 8f45ee4b20ca52b02da848088b78831080d8a2a5933fcd08ef089161097faabc
---

# 如何从 Elasticsearch 迁移到 OpenSearch

:::info
适用版本：OpenSearch Operator ~= 2.8.*，OpenSearch ~= 2.x / 3.x
:::

本文档提供从 Elasticsearch（ES）迁移到 OpenSearch 的详细指导。

## 迁移策略概览

迁移机制有两种。请先选择机制，再按照对应的章节操作。

| 源版本 | 目标版本 | 迁移方法 | 说明 |
| :--- | :--- | :--- | :--- |
| **ES 7.10** | **OS 2.x** | Snapshot & Restore | ✅ 支持直接恢复 |
| **ES 7.10** | **OS 3.x** | Snapshot & Restore → Reindex → 升级 | ⚠️ 必须先恢复到 OS 2.x，在其上 reindex，然后再升级 |
| **ES 7.10** | **OS 3.x** | Reindex from Remote | ✅ 单步完成，无需中间 2.x 集群 |
| **ES 8.x** | **OS 3.x** | Reindex from Remote | ✅ 支持直接迁移 |

### 选择迁移方法

**Snapshot & Restore** 复制的是索引文件本身。对于大数据量它的速度快得多，并且能
精确保留索引的 settings、mappings 和别名。它的限制在于版本兼容性：
OpenSearch 3.x 只能打开由 OpenSearch 2.0.0 或更高版本创建的索引，因此 ES 7.10 的索引必须
先落地到 OpenSearch 2.x 并在其上完成 reindex，之后才能升级集群。此外它还需要一个
源、目标两个集群都能访问的快照仓库。

**Reindex from Remote** 通过 HTTP 从源集群读取文档，并把它们作为新
文档写入目标集群。由于每个文档都会重新建立索引，源集群的文件格式
无关紧要——这就是它可以从 ES 7.10 直达 OpenSearch 3.x 的原因，也是它是
ES 8.x 唯一可选方案的原因。代价是每个文档都要付出完整的索引开销（在大规模场景下
远慢于直接恢复文件），需要 OpenSearch 到源集群的网络连通性，并且
它**只复制文档**——索引 settings、mappings 和别名不会被带过来，必须
事先在目标集群上创建。

:::warning 关键兼容性说明

- **不支持 ES 7.10 → OS 3.x 直接恢复**。OpenSearch 3.x 要求索引由 OpenSearch 2.0.0+ 创建。强行尝试会失败并报 `snapshot_restore_exception: cannot restore index ... because it cannot be upgraded`。
- ES 7.10 的快照必须先恢复到 OpenSearch 2.x，在其上 reindex，之后才能升级到 OS 3.x。使用 Reindex from Remote 可完全避开这一流程。
- **OpenSearch 无法恢复由 Elasticsearch 8.x 创建的快照。** 对 ES 8.x 源请使用 Reindex from Remote。

:::

本指南在 Snapshot & Restore 方法中以 ES 7.10 作为源，在 Reindex from Remote 方法中以 ES 8.17 作为源。如果你的源版本不同，请相应调整。


## 从 ES 7.10 迁移到 OpenSearch 3.x（经由 2.x）

此迁移需要**三阶段方案**：

* **Phase 0**：在源 Elasticsearch 7.10 集群上创建快照
* **Phase 1**：将该快照恢复到 OpenSearch 2.x
* **Phase 2**：对恢复出的索引执行 reindex，然后将 OpenSearch 2.x 升级到 3.x

如果你的目标就是 OpenSearch **2.x**，而不是把它当作通往 3.x 的中转，那么执行完 Phase 0 和 Phase 1 即可停止——Phase 2 仅为到达 3.x 而存在。

### 前提条件

- 一个源集群和目标集群都能访问的共享存储后端（例如 S3 Bucket、GCS Bucket）。
- 两个集群上都已安装 `repository-s3` 插件（或对应存储后端的插件）。

#### 检查插件是否已安装

在两个集群上都执行检查：

```bash
# On an Elasticsearch pod
curl -u "elastic:<password>" "http://localhost:9200/_cat/plugins?v"

# On an OpenSearch pod
curl -k -u "admin:<password>" "https://localhost:9200/_cat/plugins?v"
```

:::info
请记得将 `<password>` 替换为你集群的凭据，此处以及后续所有命令都是如此。

- 对于 Elasticsearch，默认用户是 `elastic`，密码在创建时随机生成。
- 对于 OpenSearch，默认用户是 `admin`，密码存放在 `<cluster-name>-admin-password` Secret 中。详情参见 [如何设置和更新 OpenSearch Admin 密码](./How_to_update_opensearch_admin_password.md)。
:::

#### 安装 repository-s3 插件

首先，读取每个集群实际运行的精确版本——你需要用它来拼接下载 URL：

```bash
# On an Elasticsearch pod
curl -s -u "elastic:<password>" "http://localhost:9200" | grep '"number"'

# On an OpenSearch pod
curl -sk -u "admin:<password>" "https://localhost:9200" | grep '"number"'
```

然后将该版本代入对应的 URL 模板：

| 产品 | 下载 URL 模板 |
| :--- | :--- |
| Elasticsearch | `https://artifacts.elastic.co/downloads/elasticsearch-plugins/repository-s3/repository-s3-<VERSION>.zip` |
| OpenSearch | `https://artifacts.opensearch.org/releases/plugins/repository-s3/<VERSION>/repository-s3-<VERSION>.zip` |

:::warning 版本必须严格一致
`elasticsearch-plugin install` / `opensearch-plugin install` 会读取插件包中记录的版本，并**拒绝安装到运行任何其他版本的节点上**——包括不同的 patch 版本。版本不匹配会导致节点无法启动。

本文档的示例中 Elasticsearch 使用 `7.10.2`，OpenSearch 使用 `2.19.3` / `3.3.1`。这些仅为示例：**请将所有出现的版本替换为你自己集群实际运行的版本。**
:::

:::warning 离线（Air-Gapped）环境

如果你的 Kubernetes 集群没有外部网络访问能力，请先下载插件 zip 文件，并将其托管在内部 HTTP 服务器上（例如 Nexus、Artifactory 或 Nginx）。然后将下文配置中的下载 URL 替换为你内部可访问的 URL。

:::

**ES 7.10（Helm Chart）：**

在 **容器平台** > **应用** > **原生应用** 页面：

- 找到 elasticsearch 实例
- 点击**更新**
- 切换到 **YAML** 编辑页面

在**自定义**输入文本框中使用以下内容更新 `values.yaml`：

```yaml
masterNodes:
  config:
    elasticsearch.yml: |
      s3.client.default.endpoint: "http://minio.example.com:9000"
      s3.client.default.region: "us-east-1"
      s3.client.default.path_style_access: true  # Required for MinIO

extraInitContainers:
  - name: install-plugins
    image: <the-image-your-elasticsearch-nodes-run>  # see the note below
    command:
      - sh
      - -c
      - |
        bin/elasticsearch-plugin install --batch https://artifacts.elastic.co/downloads/elasticsearch-plugins/repository-s3/repository-s3-7.10.2.zip
    volumeMounts:
      - name: plugins
        mountPath: /usr/share/elasticsearch/plugins

extraVolumes:
  - name: plugins
    emptyDir: {}

extraVolumeMounts:
  - name: plugins
    mountPath: /usr/share/elasticsearch/plugins
```

:::note
- init 容器必须使用**与你的节点当前运行完全相同的 Elasticsearch 镜像**——插件会被安装到一个随后由节点容器挂载的卷中，使用不同发行版（例如在运行默认发行版的集群上使用 `-oss` 镜像）产出的插件会被节点拒绝加载。请从正在运行的工作负载上读取镜像并原样粘贴该值：

  ```bash
  kubectl get sts -n <namespace> <elasticsearch-sts-name> \
    -o jsonpath='{.spec.template.spec.containers[0].image}'
  ```

  离线集群只能从实例部署时所用的内部镜像仓库拉取镜像，这也是应复用运行中镜像而非公共镜像的另一个原因。
- 在 `/usr/share/elasticsearch/plugins` 挂载 `emptyDir` 会遮蔽该目录中已安装的所有内容，因此 init 容器必须安装集群需要的每一个插件，而不仅仅是 `repository-s3`。
- 上述配置只为 master 节点设置了 S3 配置。如果你有专用的数据节点，请同样为 `dataNodes` 添加相同的 S3 配置。
:::

**OpenSearch：**

在你的 `OpenSearchCluster` CR 中：

```yaml
apiVersion: opensearch.opster.io/v1
kind: OpenSearchCluster
metadata:
  name: my-cluster
spec:
  bootstrap:
    pluginsList:
    - https://artifacts.opensearch.org/releases/plugins/repository-s3/2.19.3/repository-s3-2.19.3.zip
  general:
    additionalConfig:
      s3.client.default.endpoint: "http://minio.example.com:9000"
      s3.client.default.region: "us-east-1"
      s3.client.default.path_style_access: "true"
    pluginsList:
    - https://artifacts.opensearch.org/releases/plugins/repository-s3/2.19.3/repository-s3-2.19.3.zip
```

:::warning 对 `additionalConfig` 或 `pluginsList` 的每次变更都会重启整个集群

- 两种方式都会触发**所有节点的滚动重启**（一次一个节点），以加载新的配置或插件。
- 使用 **Operator 2.8.x** 时，`additionalConfig` 下的每个条目都会被渲染为**每个** pod（包括临时的 bootstrap pod）上的环境变量，OpenSearch 会将其作为设置读取。（其他 Operator 版本可能改为将相同条目渲染进挂载的 `opensearch.yml` ConfigMap——验证某个设置时请两处都检查。）Operator **不会校验这些值**。未知或拼写错误的设置只有在节点启动时才会被拒绝，节点因此无法启动——参见 [故障排查](#troubleshooting)。
- 由于节点是逐个重启的，请在允许滚动继续之前确认第一个重启的节点已恢复到 `Running` 且 `Ready`。如果没有，请在其余节点应用该配置之前先修复配置。
- `pluginsList` 中的插件是在**每次 pod 启动时**下载并安装的，而不是只装一次。该 URL 必须对每个节点持续可达，或改用预装了插件的镜像。
:::

### Phase 0：在 Elasticsearch 7.10 上创建快照

#### 步骤 1：配置 S3 凭据

出于安全原因，避免将 access key 直接写入 API 请求体。请改用 keystore。

**在 Elasticsearch 7.10 Pod 上：**

1. 将 S3 凭据添加到 keystore（secure settings）：

    ```bash
    bin/elasticsearch-keystore add s3.client.default.access_key
    bin/elasticsearch-keystore add s3.client.default.secret_key
    ```

    或使用非交互模式：

    ```bash
    echo "<YOUR_ACCESS_KEY>" | bin/elasticsearch-keystore add --stdin s3.client.default.access_key
    echo "<YOUR_SECRET_KEY>" | bin/elasticsearch-keystore add --stdin s3.client.default.secret_key
    ```

2. 重新加载 secure settings：

    ```bash
    curl -u "elastic:<password>" -X POST "http://localhost:9200/_nodes/reload_secure_settings"
    ```

    :::warning 在每个 Elasticsearch pod 上重复执行
    keystore 是每个节点自身 config 目录中的一个文件，而 `reload_secure_settings` 只会重新加载每个节点上已存在的内容。在调用 reload 之前，请**在每个 Elasticsearch pod 上执行步骤 1**（master 节点和数据节点）。

    有两点很容易让人出错：

    - 即使大多数节点根本没有凭据，`reload_secure_settings` 也会对**每个**节点报告成功，因此它的输出并不能证明凭据已就位。
    - 失败会在稍后注册仓库时才暴露出来，而且报错中点名的是**当选 master**——它通常并不是你执行 keystore 命令的那个 pod：

      ```text
      repository_verification_exception: [migration_repo] path [es_710_backup] is not accessible on master node
      ```

    keystore 还位于容器文件系统中：除非你的 chart 对 Elasticsearch config 目录做了持久化，否则 pod 重启后凭据会丢失，必须重新添加。
    :::

**在 OpenSearch 上：**

使用 Operator 的声明式配置：

1. 创建包含凭据和 endpoint 的 Secret：

    ```yaml
    apiVersion: v1
    kind: Secret
    metadata:
      name: s3-secret
    stringData:
      s3.client.default.access_key: "<YOUR_ACCESS_KEY>"
      s3.client.default.secret_key: "<YOUR_SECRET_KEY>"
    ```

    :::note S3 Endpoint 配置

    - 对于 AWS S3：省略 `endpoint` 字段，或将其设置为 `s3.amazonaws.com`
    - 对于 S3 兼容服务（MinIO、Ceph 等）：将 endpoint 设置为你的服务器地址
    - 对于 path-style 访问：添加 `s3.client.default.path_style_access: "true"`（MinIO 必需）

    :::

2. 在 `OpenSearchCluster` CR 中引用该 Secret：

    ```yaml
    spec:
      general:
        keystore:
          - secret:
              name: s3-secret
    ```

    :::note
    Operator 会挂载该 Secret 并在 init 容器中构建 keystore，因此凭据只在 pod 启动时被读取。因此添加或修改 `general.keystore` 会触发节点的滚动重启——Operator **不会**调用 `_nodes/reload_secure_settings`。
    :::

#### 步骤 2：在源集群（ES 7.10）上注册快照仓库

```bash
curl -u "elastic:<password>" -X PUT "http://localhost:9200/_snapshot/migration_repo" \
  -H 'Content-Type: application/json' -d'
{
  "type": "s3",
  "settings": {
    "bucket": "my-migration-bucket",
    "base_path": "es_710_backup"
  }
}'
```

#### 步骤 3：在源集群（ES 7.10）上创建全量快照

```bash
curl -u "elastic:<password>" -X PUT "http://localhost:9200/_snapshot/migration_repo/snapshot_1?wait_for_completion=true" \
  -H 'Content-Type: application/json' -d'
{
  "indices": "*,-.kibana*,-.security*,-.monitoring*,-apm*,-.apm*",
  "ignore_unavailable": true,
  "include_global_state": true
}'
```

:::note 排除系统索引
上面的 `indices` 模式排除了系统索引（`.kibana*`、`.security*`、`.monitoring*`、`apm*`、`.apm*`）。这些索引是 Elasticsearch 特有的，恢复时会与 OpenSearch 的内部索引发生冲突。在快照阶段就排除它们还能减小快照体积。

由于这些索引不被迁移，其中保存的对象也不会随之迁移：Kibana saved objects（index patterns、可视化、仪表盘）以及 Elasticsearch 的用户、角色和角色映射都必须在 OpenSearch 侧重新创建。
:::

### Phase 1：恢复到 OpenSearch 2.x

#### 步骤 1：部署 OpenSearch 2.x 集群

使用 OpenSearch Operator 部署一个新的 OpenSearch **2.x** 集群。完整部署操作步骤参见 [OpenSearch 安装指南](./OpenSearch_Installation_Guide.md)；下面的片段只展示本次迁移所需的字段。

:::note
将 `version` 设置为你环境中可用的 OpenSearch 版本。在没有外部网络访问的集群上，只能拉取已安装插件包中包含的 OpenSearch 版本——部署前请先确认哪些版本可用，并在 `pluginsList` URL 中也使用该版本。
:::

```yaml
apiVersion: opensearch.opster.io/v1
kind: OpenSearchCluster
metadata:
  name: my-cluster
spec:
  bootstrap:
    # REQUIRED: the bootstrap pod also receives general.additionalConfig, so it needs the
    # plugin that defines the s3.client.* settings, or it will not start.
    pluginsList:
      - https://artifacts.opensearch.org/releases/plugins/repository-s3/2.19.3/repository-s3-2.19.3.zip
  general:
    version: 2.19.3
    additionalConfig:
      s3.client.default.endpoint: "http://minio.example.com:9000"
      s3.client.default.region: "us-east-1"
      s3.client.default.path_style_access: "true"
      # Only needed when no securityConfigSecret is supplied - see the warning below.
      # OpenSearch 2.12 and later refuse to start without an initial admin password.
      OPENSEARCH_INITIAL_ADMIN_PASSWORD: "<strong-password>"
    pluginsList:
      - https://artifacts.opensearch.org/releases/plugins/repository-s3/2.19.3/repository-s3-2.19.3.zip
    keystore:
      - secret:
          name: s3-secret
    snapshotRepositories:
      - name: migration_repo
        type: s3
        settings:
          bucket: my-migration-bucket
          base_path: es_710_backup
          # Read-only is correct for the restore, but it also means this repository
          # cannot receive the pre-upgrade snapshot taken in Phase 2. Register a second,
          # writable repository (different base_path) when you get there.
          readonly: "true"
    ...
  security:
    config:
      # credentials the Operator itself uses to reach the cluster; the password must match
      # the admin password the cluster is initialized with (see the warning below)
      adminCredentialsSecret:
        name: admin-credentials-secret
```

:::warning 缺少这两个设置集群将无法启动

**1. `bootstrap.pluginsList`。** 使用 Operator 2.8.x 时，每个 `general.additionalConfig` 条目都会被渲染为**所有** pod（包括临时的 bootstrap pod）上的环境变量。`s3.client.*` 条目只有在安装了 `repository-s3` 时才是有效设置，因此如果 bootstrap pod 不安装该插件，它会立即失败并报：

```text
StartupException: unknown setting [s3.client.default.region] please check that any
required plugins are installed, or check the breaking changes documentation for removed settings
```

随后 bootstrap pod 进入 crash-loop，而由于其他节点通过 `cluster.initial_master_nodes` 与它绑定，集群永远无法组建起来。

**2. 初始 admin 密码。** 从 OpenSearch 2.12 起，demo 密码会被拒绝，节点会退出并报 `No custom admin password found. Please provide a password via the environment variable OPENSEARCH_INITIAL_ADMIN_PASSWORD`。`security.config.adminCredentialsSecret` **不能**提供该密码——那个 secret 只被 Operator 用于向集群做身份认证。

满足该要求有两种方式，选哪种取决于这个集群会存活多久：

- **推荐——提供完整的安全配置。** 创建一个包含 `internal_users.yml`（内含 admin 密码的 bcrypt 哈希）的 `securityConfigSecret`，并配套匹配的 `adminCredentialsSecret`。安全插件随后会从该配置初始化，初始密码检查也就不再适用。这是本产品其他所有地方采用的方式；请按照 [如何设置和更新 OpenSearch Admin 密码](./How_to_update_opensearch_admin_password.md) 操作，并跳过上面的 `OPENSEARCH_INITIAL_ADMIN_PASSWORD` 条目。
- **仅用于短生命周期的迁移集群——通过 `additionalConfig` 传入 `OPENSEARCH_INITIAL_ADMIN_PASSWORD`。** 使用 Operator 2.8.x 时，bootstrap pod 没有自己的 `env` 字段，因此触达它的唯一途径是 `general.additionalConfig`，该 Operator 版本会把它变成每个 pod 上的环境变量。两点注意：该值会以**明文**存储在集群资源中；而且这个技巧依赖环境变量渲染方式——在把 `additionalConfig` 写入 `opensearch.yml` 的 Operator 版本上，这个键会变成未知设置，导致每个节点都无法启动，情况与 [故障排查](#troubleshooting) 中描述的完全一致。在依赖它之前，请先验证它确实以环境变量形式落地：

  ```bash
  kubectl get sts -n <namespace> <cluster-name>-<nodepool> \
    -o jsonpath='{.spec.template.spec.containers[0].env}' | tr ',' '\n' | grep OPENSEARCH_INITIAL_ADMIN_PASSWORD
  ```

迁移完成后，请删除该迁移集群，或通过安全配置轮换密码。
:::

#### 步骤 2：在 OpenSearch 上恢复快照

排除系统索引以避免与 OpenSearch 的内部索引冲突：

```bash
curl -k -u "admin:<password>" -X POST "https://localhost:9200/_snapshot/migration_repo/snapshot_1/_restore" \
  -H 'Content-Type: application/json' -d'
{
  "indices": "-.kibana*,-.security*,-.monitoring*,-apm*,-.apm*",
  "include_global_state": false
}'
```

:::note
- 如果同名索引已存在且处于打开状态，恢复会失败。请先删除或关闭目标索引，或使用 `rename_pattern` / `rename_replacement` 以其他名称恢复。
- 恢复出的索引会保留源集群的副本数。如果目标集群节点更少，请在请求体中添加 `"index_settings": {"index.number_of_replicas": 1}`，否则恢复出的索引会一直处于 yellow 状态。
- `include_global_state` 为 `false`，因此索引模板、legacy 模板和 ingest pipeline **不会**被恢复。请在 OpenSearch 上重建你需要的部分。Index Lifecycle Management（ILM）策略没有直接等价物，必须重建为 Index State Management（ISM）策略。
:::

#### 步骤 3：验证

验证索引数量和文档数量与源集群一致：

```bash
# Check indices on OpenSearch pod
curl -k -u "admin:<password>" "https://localhost:9200/_cat/indices?v"

# Check document count on OpenSearch pod
curl -k -u "admin:<password>" "https://localhost:9200/<index_name>/_count"
```

### Phase 2：Reindex 并升级到 OpenSearch 3.x

:::warning 关键步骤
从 ES 7.10 快照恢复出的索引会保留其原始版本元数据（`7.10.2`）。OpenSearch 3.x 要求索引版本为 `2.0.0+`。在升级之前，你**必须在 OpenSearch 2.x 内对所有恢复出的索引执行 reindex**。
:::

#### 步骤 1：在恢复后的 OpenSearch 上对所有恢复出的索引执行 reindex

对每个恢复出的索引，创建新索引并 reindex 数据：

:::note
- 下面的示例使用 `migration_test` 作为索引名。执行这些命令时请将 `migration_test` 替换为你的实际索引名。
- 这些命令需要 `jq`。如果 OpenSearch 容器中没有它，请在一台能访问集群的工作机上执行。
- 复制索引的 **settings** 很重要：分片数、自定义 analyzer 等设置都存放在那里，而不在 mappings 中。如果某个索引使用了自定义 analyzer，还必须在创建新索引之前在目标集群上安装对应的 analysis 插件。
- 由 shrink 或 split 产生的索引还带有 `index.resize.*` 和 `index.routing.allocation.initial_recovery.*`，它们同样不能在新索引上设置。如果创建调用拒绝这些设置，也请把它们从 `index_def.json` 中删除。
:::

```bash
# 1. Export the source index definition (settings AND mappings), removing the
#    read-only fields that cannot be set on a new index

curl -s -k -u "admin:<password>" "https://localhost:9200/migration_test" | \
  jq '.migration_test
      | {settings: .settings, mappings: .mappings}
      | del(.settings.index.uuid,
            .settings.index.creation_date,
            .settings.index.version,
            .settings.index.provided_name)' > index_def.json

# 2. Create a new index with the same settings and mappings (add suffix _v2)

curl -k -u "admin:<password>" -X PUT "https://localhost:9200/migration_test_v2" \
  -H 'Content-Type: application/json' \
  -d @index_def.json

# 3. Reindex data from old index to new index.
#    For a large index use wait_for_completion=false and poll GET _tasks/<task_id>
#    instead - a request held open for minutes can be cut off by an intermediate proxy.

curl -k -u "admin:<password>" -X POST "https://localhost:9200/_reindex?wait_for_completion=true" \
  -H 'Content-Type: application/json' -d'
{
  "source": { "index": "migration_test" },
  "dest": { "index": "migration_test_v2" }
}'

# 4. Compare the document counts BEFORE deleting anything - the next step is destructive

curl -k -u "admin:<password>" "https://localhost:9200/migration_test/_count"
curl -k -u "admin:<password>" "https://localhost:9200/migration_test_v2/_count"

# 5. Only once the two counts match: delete the old index and create an alias (or rename)
curl -k -u "admin:<password>" -X DELETE "https://localhost:9200/migration_test"
curl -k -u "admin:<password>" -X POST "https://localhost:9200/_aliases" \
  -H 'Content-Type: application/json' -d'
{
  "actions": [
    { "add": { "index": "migration_test_v2", "alias": "migration_test" } }
  ]
}'
```

对所有恢复出的索引重复此操作。reindex 完成后，验证新索引的版本：

```bash
curl -k -u "admin:<password>" "https://localhost:9200/migration_test_v2/_settings?filter_path=**.version"
```

`version.created` 应显示为 OpenSearch 2.x 的内部版本号（例如 OS 2.19.3 对应 `136408127`），而不是 ES 7.10.2 索引携带的 `7100299`。具体数字随 patch 版本而变化，因此不要与某个字面值比较：任何 `136xxxxxx` 形式的值都表示该索引由 OpenSearch 2.x 创建、reindex 已成功。

#### 步骤 2：升级 OpenSearch 集群

:::warning
在开始升级之前，先为 OpenSearch 2.x 集群创建一个快照。大版本升级无法原地回滚。

Phase 1 中注册的 `migration_repo` 声明了 `readonly: "true"`，因此无法接收这个快照。请先注册第二个仓库——用同一个 bucket 也可以，但要使用不同的 `base_path` 且不带 `readonly`。
:::

更新 `OpenSearchCluster` CR 以升级版本。OpenSearch 和 OpenSearch Dashboards 使用相同的版本：

```yaml
spec:
  general:
    version: 3.3.1  # Upgrade to OpenSearch 3.x
    pluginsList:
    - https://artifacts.opensearch.org/releases/plugins/repository-s3/3.3.1/repository-s3-3.3.1.zip
  dashboards:
    version: 3.3.1  # Upgrade OpenSearch Dashboards to the matching version
```

Operator 会自动执行滚动升级。

#### 步骤 3：升级后验证

验证升级后所有索引均可访问：

```bash
curl -k -u "admin:<password>" "https://localhost:9200/_cat/indices?v"
curl -k -u "admin:<password>" "https://localhost:9200/_cluster/health?pretty"
```

## 从 ES 8.x 迁移到 OpenSearch 3.x

OpenSearch 无法恢复由 Elasticsearch 8.x 创建的快照，因此对于该源版本，**Reindex from Remote** 是唯一可用的方法。

同样的方法也适用于 ES 7.10 源，并且与 Snapshot & Restore 不同，它可以直接以 OpenSearch 3.x 为目标，无需中间 2.x 集群。权衡取舍参见 [选择迁移方法](#choosing-a-method)。

### 前提条件

- **网络连通性**：OpenSearch 集群必须能够访问源集群的 HTTP/REST 端口（通常为 9200）。
- **索引 settings 与 mappings**：reindex 只复制文档。请在 reindex **之前**用你需要的 settings 和 mappings 创建目标索引，否则目标索引会按动态 mapping 默认值创建，无法还原源索引的分片数、自定义 analyzer 或字段类型。

### 使用 ECK Operator 部署 ES 8.x

使用 ECK Operator 部署 Elasticsearch 8.17 集群：

```yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: es-cluster
spec:
  http:
    service:
      spec:
        type: NodePort
  version: 8.17.5
  nodeSets:
  - name: default
    count: 3
    config: {}
    podTemplate:
      spec:
        containers:
        - name: elasticsearch
          resources:
            limits:
              cpu: "2"
              memory: 4Gi
            requests:
              cpu: "1"
              memory: 4Gi
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes:
        - ReadWriteOnce
        resources:
          requests:
            storage: 5Gi
```

:::note TLS 配置
如果你通过以下设置禁用了 TLS：

```yaml
spec:
  http:
    tls:
      selfSignedCertificate:
        disabled: true
```

那么访问 Elasticsearch API 时必须使用 `http://` 而不是 `https://`。
:::

### 操作步骤

#### 步骤 1：为远程 Reindex 配置 OpenSearch

在 `OpenSearchCluster` CR 的 `additionalConfig` 中添加以下配置：

```yaml
spec:
  general:
    additionalConfig:
      # Allow connections to the ES 8.x host. Host and port only - no http:// or https:// prefix.
      # Separate multiple hosts with commas.
      reindex.remote.allowlist: "es8-cluster-host:9200"
      # Disable SSL verification for self-signed certificates
      reindex.ssl.verification_mode: "none"
```

:::warning 是 `allowlist`，不是 `whitelist`

Elasticsearch 以及 OpenSearch 1.x 使用的是 `reindex.remote.whitelist`。OpenSearch 将该设置重命名为 `reindex.remote.allowlist`，并在 2.x 中保留旧名称作为已废弃的别名。**OpenSearch 3.x 已彻底移除旧名称**，因此从 Elasticsearch 文档抄来的配置会让每个节点在启动时失败并报：

```text
SettingsException[unknown setting [reindex.remote.whitelist] ...]
```

应用该变更会逐个重启节点。请在滚动继续之前确认第一个重启的节点已恢复到 `Running` 且 `Ready`——参见 [故障排查](#troubleshooting)。
:::

滚动完成后，**请确认设置确实生效**。拼写错误的设置会让节点报错崩溃、动静很大，但 Operator 未能下发的设置却是静默的——节点保持健康，而稍后的 reindex 请求会失败并报 `[es8-cluster-host:9200] not allowlisted in reindex.remote.allowlist`：

```bash
curl -k -u "admin:<password>" "https://localhost:9200/_nodes/settings?filter_path=**.reindex*"
```

每个节点都必须报告该 allowlist。如果响应为空，说明该条目没有下发到节点（[opensearch-k8s-operator#883](https://github.com/opensearch-project/opensearch-k8s-operator/issues/883) 在跟踪此问题）；请改为在 `nodePools[].additionalConfig` 上设置，或将其固化到自定义镜像的 `opensearch.yml` 中，并在继续之前再次检查。

#### 步骤 2：在 OpenSearch 上创建目标索引

Reindex 只复制文档，因此请在执行 reindex **之前**，用你需要的 settings 和 mappings 创建目标索引——或创建一个能匹配其名称的 Index Template。由 reindex 隐式创建的索引会使用动态 mapping 默认值，无法还原源索引的分片数、自定义 analyzer 或字段类型。

只有当源索引没有任何值得保留的 mapping 或 setting 时，才可以跳过此步骤。

#### 步骤 3：在 OpenSearch 上执行 Reindex

从 OpenSearch 集群发起 reindex 请求。设置 `wait_for_completion=false` 以异步运行。

```bash
curl -k -u "admin:<password>" -X POST "https://localhost:9200/_reindex?wait_for_completion=false" -H 'Content-Type: application/json' -d'
{
  "source": {
    "remote": {
      "host": "https://es8-cluster-host:9200",
      "username": "elastic",
      "password": "<password>"
    },
    "index": "migration_test"
  },
  "dest": {
    "index": "migration_test"
  }
}'
```

**示例响应：**

```json
{
  "task": "N6q0j8s-T0m0j8s-T0m0j8:123456"
}
```

#### 步骤 4：监控 Reindex 进度

使用上一步得到的 Task ID 查询任务状态：

```bash
curl -k -u "admin:<password>" "https://localhost:9200/_tasks/N6q0j8s-T0m0j8s-T0m0j8:123456"
```

#### 步骤 5：验证 Reindex 完成

验证索引已创建且包含数据：

```bash
# Check if index exists and document count (run on OpenSearch pod)
curl -k -u "admin:<password>" "https://localhost:9200/migration_test/_count"

# Compare with source ES 8.x cluster (run on ES 8.x pod)
curl -k -u "elastic:<password>" "https://es8-cluster-host:9200/migration_test/_count"
```

## 故障排查

### 配置变更后某个节点持续处于 CrashLoopBackOff

`spec.general.additionalConfig` 下的每个条目都会被透传给 OpenSearch 作为设置——在 Operator 2.8.x 中是以 pod 上环境变量的形式。Operator 不会校验这些值。未知或拼写错误的设置会在节点启动时被拒绝，节点因此始终无法启动：

```text
[ERROR][o.o.b.OpenSearchUncaughtExceptionHandler] uncaught exception in thread [main]
org.opensearch.bootstrap.StartupException: SettingsException[unknown setting [reindex.remote.whitelist]
  please check that any required plugins are installed, or check the breaking changes documentation
  for removed settings]
```

Operator 逐个重启节点并等待每个节点就绪，因此滚动会停在第一个失败的节点上。其余节点继续运行之前的配置，这就是为什么在一个 pod 循环重启的同时，集群仍然可以对外提供服务。

恢复方法：

```bash
# 1. Identify the failing node and the rejected setting
kubectl get pods -n <namespace>
kubectl logs -n <namespace> <cluster-name>-masters-0 --tail=50

# 2. Correct the setting in the cluster resource
kubectl edit opensearchcluster -n <namespace> <cluster-name>

# 3. Confirm the Operator has regenerated the configuration.
#    With Operator 2.8.x, additionalConfig entries become environment variables on the pods,
#    so check the StatefulSet first:
kubectl get sts -n <namespace> <cluster-name>-<nodepool> \
  -o jsonpath='{.spec.template.spec.containers[0].env}' | tr ',' '\n' | grep '<setting-name>'

#    Other Operator versions render the same entries into a mounted opensearch.yml instead.
#    If the setting is not in the StatefulSet env, look for it in the cluster's ConfigMaps:
kubectl get cm -n <namespace> -o yaml | grep '<setting-name>'

# 4. Restart the failing pod so it picks up the new configuration
kubectl delete pod -n <namespace> <cluster-name>-masters-0

# 5. Watch the rollout continue to the remaining nodes
kubectl get pods -n <namespace> -w
```

:::note
设置是逐个校验的，因此节点只会报告它发现的第一个无效设置。如果修复后再次失败，请针对下一个被报告的设置重复上述操作。
:::

## 客户端迁移指南

无论源 ES 版本如何，都**强烈建议切换到官方 OpenSearch 客户端**。

:::warning 兼容性说明

- Elasticsearch OSS 7.10.2 客户端或许能与 OpenSearch 1.x 一起工作，但最新的 ES 客户端包含 license/版本检查，会破坏兼容性。
- **对于 OpenSearch 2.0 及更高版本，没有任何 Elasticsearch 客户端能与 OpenSearch 完全兼容。**
- 强烈建议为 OpenSearch 集群使用 OpenSearch 客户端。
:::

### OpenSearch 官方客户端

| 语言 | 客户端 | 文档 |
| :--- | :--- | :--- |
| **Python** | opensearch-py | [高级客户端](https://docs.opensearch.org/latest/clients/python-high-level/), [低级客户端](https://docs.opensearch.org/latest/clients/python-low-level/) |
| **Java** | opensearch-java | [Java 客户端](https://docs.opensearch.org/latest/clients/java/) |
| **JavaScript** | @opensearch-project/opensearch | [Node.js 客户端](https://docs.opensearch.org/latest/clients/javascript/index) |
| **Go** | opensearch-go | [Go 客户端](https://docs.opensearch.org/latest/clients/go/) |
| **Ruby** | opensearch-ruby | [Ruby 客户端](https://docs.opensearch.org/latest/clients/ruby/) |
| **PHP** | opensearch-php | [PHP 客户端](https://docs.opensearch.org/latest/clients/php/) |
| **.NET** | OpenSearch.Client | [.NET 客户端](https://docs.opensearch.org/latest/clients/dot-net/) |
| **Rust** | opensearch-rs | [Rust 客户端](https://docs.opensearch.org/latest/clients/rust/) |
| **Hadoop** | opensearch-hadoop | [GitHub](https://github.com/opensearch-project/opensearch-hadoop) |

详细迁移说明请参考 [OpenSearch 客户端文档](https://docs.opensearch.org/latest/clients/)。

## 参考资料

- [OpenSearch 迁移指南](https://docs.opensearch.org/latest/upgrade-or-migrate/)
- [快照与恢复](https://docs.opensearch.org/latest/tuning-your-cluster/availability-and-recovery/snapshots/snapshot-restore/)
- [Reindex API](https://docs.opensearch.org/latest/api-reference/document-apis/reindex/)
- [Keystore 管理](https://docs.opensearch.org/latest/security/configuration/opensearch-keystore/)
