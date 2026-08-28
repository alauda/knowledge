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
适用版本：OpenSearch Operator \~= 2.8.\*，OpenSearch \~= 2.x / 3.x
:::

本文档提供了从 Elasticsearch (ES) 迁移到 OpenSearch 的详细指导。

## 迁移策略概述

有两种迁移机制。首先选择机制，然后按照相应部分进行操作。

| 源版本       | 目标版本       | 迁移方法                           | 备注                                                  |
| :----------- | :------------- | :--------------------------------- | :----------------------------------------------------- |
| **ES 7.10**  | **OS 2.x**     | 快照与恢复                         | ✅ 支持直接恢复                                       |
| **ES 7.10**  | **OS 3.x**     | 快照与恢复 → 重新索引 → 升级      | ⚠️ 必须先恢复到 OS 2.x，在那里重新索引，然后升级     |
| **ES 7.10**  | **OS 3.x**     | 从远程重新索引                    | ✅ 单步操作，无需中间 2.x 集群                        |
| **ES 8.x**   | **OS 3.x**     | 从远程重新索引                    | ✅ 支持直接迁移                                     |

### 选择方法

**快照与恢复** 复制索引文件本身。对于大型数据集，它的速度更快，并且能够准确保留索引设置、映射和别名。它的限制是版本兼容性：OpenSearch 3.x 只能打开由 OpenSearch 2.0.0 或更高版本创建的索引，因此 ES 7.10 索引必须先恢复到 OpenSearch 2.x，并在那重新索引，然后才能升级集群。它还需要一个两个集群都可以访问的快照存储库。

**从远程重新索引** 通过 HTTP 从源集群读取文档，并将其作为新文档写入目标。由于每个文档都是全新索引，因此源的文件格式并不重要——这就是为什么它可以直接从 ES 7.10 迁移到 OpenSearch 3.x，以及为什么它是 ES 8.x 的唯一选项。其成本在于每个文档都需要支付完整的索引成本（远比大规模恢复文件慢），它需要 OpenSearch 与源之间的网络连接，并且它只复制 **文档**——索引设置、映射和别名不会被转移，必须在目标上预先创建。

:::warning 关键兼容性说明

- **ES 7.10 → OS 3.x 直接恢复不受支持**。OpenSearch 3.x 要求索引必须使用 OpenSearch 2.0.0+ 创建。尝试此操作会失败，错误信息为 `snapshot_restore_exception: cannot restore index ... because it cannot be upgraded`。
- ES 7.10 快照必须首先恢复到 OpenSearch 2.x，在那里重新索引，然后才能升级到 OS 3.x。从远程重新索引完全避免了这一点。
- **OpenSearch 无法恢复由 Elasticsearch 8.x 拍摄的快照。** 对于 ES 8.x 源，请使用从远程重新索引。

:::

本指南使用 ES 7.10 作为快照与恢复方法的源，使用 ES 8.17 作为从远程重新索引的方法。如果您的源版本不同，请相应调整。

## 从 ES 7.10 迁移到 OpenSearch 3.x（通过 2.x）

此迁移需要 **三阶段方法**：

- **阶段 0**：在源 Elasticsearch 7.10 集群上创建快照
- **阶段 1**：将该快照恢复到 OpenSearch 2.x
- **阶段 2**：重新索引恢复的索引，然后将 OpenSearch 2.x 升级到 3.x

如果 OpenSearch **2.x** 是您的目标，而不是通往 3.x 的中转站，请遵循阶段 0 和阶段 1，然后停止——阶段 2 仅用于达到 3.x。

### 先决条件

- 一个共享存储后端（例如，S3 Bucket，GCS Bucket），两个源和目标集群都可以访问。
- 在两个集群上安装 `repository-s3` 插件（或相应的存储后端插件）。

#### 检查插件是否已安装

在两个集群上运行检查：

```bash
# 在 Elasticsearch pod 上
curl -u "elastic:<password>" "http://localhost:9200/_cat/plugins?v"

# 在 OpenSearch pod 上
curl -k -u "admin:<password>" "https://localhost:9200/_cat/plugins?v"
```

:::info
请记得在这里和后续每个命令中将 `<password>` 替换为您集群的凭据。

- 对于 Elasticsearch，默认用户为 `elastic`，密码在创建时随机生成。
- 对于 OpenSearch，默认用户为 `admin`，密码存储在 `<cluster-name>-admin-password` Secret 中。有关详细信息，请参见 [如何设置和更新 OpenSearch 管理员密码](./How_to_update_opensearch_admin_password.md)。
  :::

#### 安装 repository-s3 插件

首先，读取每个集群运行的确切版本——您需要它来构建下载 URL：

```bash
# 在 Elasticsearch pod 上
curl -s -u "elastic:<password>" "http://localhost:9200" | grep '"number"'

# 在 OpenSearch pod 上
curl -sk -u "admin:<password>" "https://localhost:9200" | grep '"number"'
```

然后将该版本替换到匹配的 URL 模式中：

| 产品          | 下载 URL 模式                                                                                     |
| :------------ | :------------------------------------------------------------------------------------------------- |
| Elasticsearch | `https://artifacts.elastic.co/downloads/elasticsearch-plugins/repository-s3/repository-s3-<VERSION>.zip` |
| OpenSearch    | `https://artifacts.opensearch.org/releases/plugins/repository-s3/<VERSION>/repository-s3-<VERSION>.zip`  |

:::warning 版本必须完全匹配
`elasticsearch-plugin install` / `opensearch-plugin install` 会读取插件包中记录的版本，并 **拒绝在运行任何其他版本的节点上安装**——包括不同的补丁版本。不匹配会导致节点无法启动。

本文档中的示例使用 `7.10.2` 作为 Elasticsearch 的版本，使用 `2.19.3` / `3.3.1` 作为 OpenSearch 的版本。这些仅为示例：**请用您自己集群实际运行的版本替换每个出现的地方。**
:::

:::warning 隔离环境

如果您的 Kubernetes 集群没有外部网络访问权限，请先下载插件 zip 文件，并将其托管在内部 HTTP 服务器上（例如，Nexus、Artifactory 或 Nginx）。然后将下面配置中的下载 URL 替换为您内部可访问的 URL。

:::

**ES 7.10（Helm Chart）：**

在 **应用容器平台** > **应用** > **应用** 页面：

- 找到 elasticsearch 实例
- 点击 **更新**
- 切换到 **YAML** 编辑页面

在 **自定义** 输入文本区域中更新 `values.yaml`，内容如下：

```yaml
masterNodes:
  config:
    elasticsearch.yml: |
      s3.client.default.endpoint: "http://minio.example.com:9000"
      s3.client.default.region: "us-east-1"
      s3.client.default.path_style_access: true  # MinIO 所需

extraInitContainers:
  - name: install-plugins
    image: <the-image-your-elasticsearch-nodes-run>  # 见下文说明
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

- 初始化容器必须使用 **与您的节点当前运行的相同 Elasticsearch 镜像**——插件安装到节点容器挂载的卷中，而不同的发行版（例如，针对运行默认发行版的集群的 `-oss` 镜像）会产生节点拒绝加载的插件。读取正在运行的工作负载的镜像并粘贴该确切值：

  ```bash
  kubectl get sts -n <namespace> <elasticsearch-sts-name> \
    -o jsonpath='{.spec.template.spec.containers[0].image}'
  ```

  隔离集群只能从部署实例的内部注册表中拉取，这也是重用正在运行的镜像而不是公共镜像的另一个原因。
- 在 `/usr/share/elasticsearch/plugins` 挂载 `emptyDir` 会隐藏该目录中已安装的任何内容，因此初始化容器必须安装集群所需的每个插件，而不仅仅是 `repository-s3`。
- 上述配置仅为主节点设置 S3 配置。如果您有专用数据节点，请在 `dataNodes` 中添加相同的 S3 配置。
  :::

**OpenSearch：**

在您的 `OpenSearchCluster` CR 中：

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

:::warning 每次更改 `additionalConfig` 或 `pluginsList` 都会重启整个集群

- 两种方法都会触发 **每个节点的滚动重启**，一次一个，以加载新配置或插件。
- 使用 **Operator 2.8.x**，`additionalConfig` 下的每个条目都会作为环境变量呈现在 **每个** pod 上，包括临时的引导 pod，OpenSearch 将其视为设置。（其他 Operator 版本可能会将相同条目呈现到挂载的 `opensearch.yml` ConfigMap 中——在验证设置时检查两者。）Operator **不验证这些值**。未知或拼写错误的设置仅在节点启动时被拒绝，节点随后无法启动——请参见 [故障排除](#troubleshooting)。
- 由于节点是一个一个重启的，因此在让滚动继续之前，请验证第一个重启的节点返回到 `Running` 和 `Ready` 状态。如果没有，请在剩余节点获取之前修复配置。
- `pluginsList` 中的插件在 **每个 pod 启动时** 下载和安装，而不是一次。URL 必须从每个节点可达，或者使用预先安装插件的镜像。
  :::

### 阶段 0：在 Elasticsearch 7.10 上创建快照

#### 步骤 1：配置 S3 凭据

出于安全原因，避免直接在 API 请求体中包含访问密钥。请使用密钥库。

**在 Elasticsearch 7.10 Pod 上：**

1. 将 S3 凭据添加到密钥库（安全设置）：

   ```bash
   bin/elasticsearch-keystore add s3.client.default.access_key
   bin/elasticsearch-keystore add s3.client.default.secret_key
   ```

   或使用非交互模式：

   ```bash
   echo "<YOUR_ACCESS_KEY>" | bin/elasticsearch-keystore add --stdin s3.client.default.access_key
   echo "<YOUR_SECRET_KEY>" | bin/elasticsearch-keystore add --stdin s3.client.default.secret_key
   ```

2. 重新加载安全设置：

   ```bash
   curl -u "elastic:<password>" -X POST "http://localhost:9200/_nodes/reload_secure_settings"
   ```

   :::warning 在每个 Elasticsearch pod 上重复
   密钥库是每个节点自己配置目录中的一个文件，`reload_secure_settings` 仅重新加载每个节点上已存在的内容。**在每个 Elasticsearch pod 上运行步骤 1**（主节点和数据节点）后再调用重新加载。

   有两个因素使得这很容易出错：

   - `reload_secure_settings` 对 **每个** 节点报告成功，即使大多数节点根本没有凭据，因此其输出并不是检查凭据是否到位。
   - 失败会在注册存储库时显现，并且它会命名 **当选主节点**——这通常不是您运行密钥库命令的 pod：

     ```text
     repository_verification_exception: [migration_repo] path [es_710_backup] is not accessible on master node
     ```

   密钥库也存在于容器文件系统中：除非您的 chart 持久化 Elasticsearch 配置目录，否则凭据在 pod 重启时会丢失，必须重新添加。
   :::

**在 OpenSearch 上：**

使用 Operator 的声明性配置：

1. 创建一个包含凭据和端点的 Secret：

   ```yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: s3-secret
   stringData:
     s3.client.default.access_key: "<YOUR_ACCESS_KEY>"
     s3.client.default.secret_key: "<YOUR_SECRET_KEY>"
   ```

   :::note S3 端点配置

   - 对于 AWS S3：省略 `endpoint` 字段，或将其设置为 `s3.amazonaws.com`
   - 对于 S3 兼容服务（MinIO、Ceph 等）：将端点设置为您的服务器地址
   - 对于路径样式访问：添加 `s3.client.default.path_style_access: "true"`（MinIO 所需）

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
   Operator 在初始化容器中挂载 Secret 并构建密钥库，因此凭据仅在 pod 启动时读取。因此，添加或更改 `general.keystore` 会触发节点的滚动重启——Operator 不会调用 `_nodes/reload_secure_settings`。
   :::

#### 步骤 2：在源集群（ES 7.10）上注册快照存储库

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

#### 步骤 3：在源集群（ES 7.10）上创建完整快照

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
上述 `indices` 模式排除了系统索引（`.kibana*`、`.security*`、`.monitoring*`、`apm*`、`.apm*`）。这些索引是 Elasticsearch 特有的，在恢复期间会与 OpenSearch 的内部索引发生冲突。在快照时排除它们也会减少快照大小。

由于这些索引未被迁移，因此它们所持有的对象也不会被转移：Kibana 保存的对象（索引模式、可视化、仪表板）以及 Elasticsearch 用户、角色和角色映射必须在 OpenSearch 端重新创建。
:::

### 阶段 1：恢复到 OpenSearch 2.x

#### 步骤 1：部署 OpenSearch 2.x 集群

使用 OpenSearch Operator 部署一个新的 OpenSearch **2.x** 集群。有关完整的部署步骤，请参见 [OpenSearch 安装指南](./OpenSearch_Installation_Guide.md)；下面的片段仅显示此迁移所需的字段。

:::note
将 `version` 设置为您环境中可用的 OpenSearch 版本。在没有外部网络访问的集群中，仅可以拉取安装的插件包中包含的 OpenSearch 版本——在部署之前检查可用的版本，并在 `pluginsList` URL 中使用该版本。
:::

```yaml
apiVersion: opensearch.opster.io/v1
kind: OpenSearchCluster
metadata:
  name: my-cluster
spec:
  bootstrap:
    # 必需：引导 pod 也接收 general.additionalConfig，因此它需要定义 s3.client.* 设置的插件，否则将无法启动。
    pluginsList:
      - https://artifacts.opensearch.org/releases/plugins/repository-s3/2.19.3/repository-s3-2.19.3.zip
  general:
    version: 2.19.3
    additionalConfig:
      s3.client.default.endpoint: "http://minio.example.com:9000"
      s3.client.default.region: "us-east-1"
      s3.client.default.path_style_access: "true"
      # 仅在未提供 securityConfigSecret 时需要 - 请参见下面的警告。
      # OpenSearch 2.12 及更高版本在没有初始管理员密码的情况下拒绝启动。
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
          # 只读对恢复是正确的，但这也意味着此存储库
          # 不能接收在阶段 2 中拍摄的升级前快照。完成后注册第二个
          # 可写存储库（不同的 base_path）。
          readonly: "true"
    ...
  security:
    config:
      # Operator 自身用于访问集群的凭据；密码必须与集群初始化时的管理员密码匹配（见下面的警告）
      adminCredentialsSecret:
        name: admin-credentials-secret
```

:::warning 集群启动所需的两个设置

**1. `bootstrap.pluginsList`。** 使用 Operator 2.8.x，`general.additionalConfig` 下的每个条目都会作为环境变量呈现在 **所有** pod 上，包括临时引导 pod。`s3.client.*` 条目仅在安装了 `repository-s3` 时才是有效设置，因此如果引导 pod 没有安装该插件，它会立即失败并显示：

```text
StartupException: unknown setting [s3.client.default.region] please check that any
required plugins are installed, or check the breaking changes documentation for removed settings
```

引导 pod 然后会崩溃循环，并且由于其他节点通过 `cluster.initial_master_nodes` 被固定在它上面，集群将无法形成。

**2. 初始管理员密码。** 从 OpenSearch 2.12 开始，演示密码被拒绝，节点退出并显示 `No custom admin password found. Please provide a password via the environment variable OPENSEARCH_INITIAL_ADMIN_PASSWORD`。`security.config.adminCredentialsSecret` 并 **不** 提供它——该 Secret 仅用于 Operator 进行集群身份验证。

满足这一点有两种方法，正确的方法取决于集群的生命周期：

- **推荐 — 提供完整的安全配置。** 创建一个 `securityConfigSecret`，其中包含 `internal_users.yml`，并带有管理员密码的 bcrypt 哈希，以及匹配的 `adminCredentialsSecret`。安全插件将从该配置初始化，初始密码检查将不再适用。这是本产品其他地方使用的方法；请参见 [如何设置和更新 OpenSearch 管理员密码](./How_to_update_opensearch_admin_password.md)，并跳过上面的 `OPENSEARCH_INITIAL_ADMIN_PASSWORD` 条目。
- **短期迁移集群 — 通过 `additionalConfig` 提供 `OPENSEARCH_INITIAL_ADMIN_PASSWORD`。** 使用 Operator 2.8.x，引导 pod 自身没有 `env` 字段，因此到达它的唯一方法是 `general.additionalConfig`，该版本的 Operator 将其转换为每个 pod 上的环境变量。有两个警告：该值以 **明文** 存储在集群资源中，并且该技巧依赖于环境变量呈现——在将 `additionalConfig` 写入 `opensearch.yml` 的 Operator 版本中，此键变为未知设置，所有节点都无法启动，正如 [故障排除](#troubleshooting) 中所描述的那样。在依赖它之前，请验证它作为环境变量落地：

  ```bash
  kubectl get sts -n <namespace> <cluster-name>-<nodepool> \
    -o jsonpath='{.spec.template.spec.containers[0].env}' | tr ',' '\n' | grep OPENSEARCH_INITIAL_ADMIN_PASSWORD
  ```

在迁移完成后，删除迁移集群或通过安全配置轮换密码。
:::

#### 步骤 2：在 OpenSearch 上恢复快照

排除系统索引以避免与 OpenSearch 的内部索引发生冲突：

```bash
curl -k -u "admin:<password>" -X POST "https://localhost:9200/_snapshot/migration_repo/snapshot_1/_restore" \
  -H 'Content-Type: application/json' -d'
{
  "indices": "-.kibana*,-.security*,-.monitoring*,-apm*,-.apm*",
  "include_global_state": false
}'
```

:::note

- 如果同名的索引已经存在并且处于打开状态，则恢复会失败。请先删除或关闭目标索引，或使用 `rename_pattern` / `rename_replacement` 在不同名称下恢复。
- 恢复的索引保留源集群的副本计数。如果目标集群节点较少，请在请求体中添加 `"index_settings": {"index.number_of_replicas": 1}`，否则恢复的索引将保持黄色。
- `include_global_state` 为 `false`，因此索引模板、遗留模板和摄取管道 **不会** 被恢复。请在 OpenSearch 上重新创建所需的模板。索引生命周期管理（ILM）策略没有直接等效项，必须重建为索引状态管理（ISM）策略。
  :::

#### 步骤 3：验证

验证索引计数和文档计数与源集群匹配：

```bash
# 检查 OpenSearch pod 上的索引
curl -k -u "admin:<password>" "https://localhost:9200/_cat/indices?v"

# 检查 OpenSearch pod 上的文档计数
curl -k -u "admin:<password>" "https://localhost:9200/<index_name>/_count"
```

### 阶段 2：重新索引并升级到 OpenSearch 3.x

:::warning 关键步骤
从 ES 7.10 快照恢复的索引保留其原始版本元数据（`7.10.2`）。OpenSearch 3.x 要求索引必须具有版本 `2.0.0+`。您 **必须在 OpenSearch 2.x 中重新索引** 所有恢复的索引，然后才能升级。
:::

#### 步骤 1：在恢复的 OpenSearch 上重新索引所有恢复的索引

对于每个恢复的索引，创建一个新索引并重新索引数据：

:::note

- 以下示例使用 `migration_test` 作为索引名称。在执行这些命令时，请将 `migration_test` 替换为您的实际索引名称。
- 这些命令需要 `jq`。如果在 OpenSearch 容器中不可用，请从可以访问集群的工作站运行它们。
- 复制索引 **设置** 是重要的：分片计数、自定义分析器和类似设置都在这里，而不在映射中。如果索引使用自定义分析器，则必须在目标集群上安装相应的分析插件，才能创建新索引。
- 通过缩小或拆分生成的索引也会携带 `index.resize.*` 和 `index.routing.allocation.initial_recovery.*`，这些在新索引上也无法设置。如果创建调用拒绝它们，请从 `index_def.json` 中删除这些。
  :::

```bash
# 1. 导出源索引定义（设置和映射），删除无法在新索引上设置的只读字段

curl -s -k -u "admin:<password>" "https://localhost:9200/migration_test" | \
  jq '.migration_test
      | {settings: .settings, mappings: .mappings}
      | del(.settings.index.uuid,
            .settings.index.creation_date,
            .settings.index.version,
            .settings.index.provided_name)' > index_def.json

# 2. 创建一个具有相同设置和映射的新索引（添加后缀 _v2）

curl -k -u "admin:<password>" -X PUT "https://localhost:9200/migration_test_v2" \
  -H 'Content-Type: application/json' \
  -d @index_def.json

# 3. 从旧索引重新索引数据到新索引。
#    对于大型索引，请使用 wait_for_completion=false，并轮询 GET _tasks/<task_id>
#    代替——一个保持开放几分钟的请求可能会被中间代理切断。

curl -k -u "admin:<password>" -X POST "https://localhost:9200/_reindex?wait_for_completion=true" \
  -H 'Content-Type: application/json' -d'
{
  "source": { "index": "migration_test" },
  "dest": { "index": "migration_test_v2" }
}'

# 4. 在删除任何内容之前比较文档计数 - 下一步是破坏性的

curl -k -u "admin:<password>" "https://localhost:9200/migration_test/_count"
curl -k -u "admin:<password>" "https://localhost:9200/migration_test_v2/_count"

# 5. 仅在两个计数匹配时：删除旧索引并创建别名（或重命名）
curl -k -u "admin:<password>" -X DELETE "https://localhost:9200/migration_test"
curl -k -u "admin:<password>" -X POST "https://localhost:9200/_aliases" \
  -H 'Content-Type: application/json' -d'
{
  "actions": [
    { "add": { "index": "migration_test_v2", "alias": "migration_test" } }
  ]
}'
```

对所有恢复的索引重复此操作。重新索引后，验证新索引版本：

```bash
curl -k -u "admin:<password>" "https://localhost:9200/migration_test_v2/_settings?filter_path=**.version"
```

`version.created` 应显示 OpenSearch 2.x 内部版本号（例如 `136408127` 对于 OS 2.19.3），而不是 ES 7.10.2 索引携带的 `7100299`。确切数字会因补丁版本而异，因此不要与字面值进行比较：任何 `136xxxxxx` 值都意味着索引是由 OpenSearch 2.x 创建的，重新索引成功。

#### 步骤 2：升级 OpenSearch 集群

:::warning
在开始升级之前，请先对 OpenSearch 2.x 集群进行快照。主要版本升级无法在原地回滚。

在阶段 1 中注册的 `migration_repo` 被声明为 `readonly: "true"`，因此无法接收此快照。请先注册第二个存储库——同一存储桶可以，但需要不同的 `base_path`，且不带 `readonly`。
:::

更新 `OpenSearchCluster` CR 以升级版本。对 OpenSearch 和 OpenSearch Dashboards 使用相同版本：

```yaml
spec:
  general:
    version: 3.3.1  # 升级到 OpenSearch 3.x
    pluginsList:
    - https://artifacts.opensearch.org/releases/plugins/repository-s3/3.3.1/repository-s3-3.3.1.zip
  dashboards:
    version: 3.3.1  # 将 OpenSearch Dashboards 升级到匹配版本
```

Operator 将自动执行滚动升级。

#### 步骤 3：升级后验证

验证所有索引在升级后是否可访问：

```bash
curl -k -u "admin:<password>" "https://localhost:9200/_cat/indices?v"
curl -k -u "admin:<password>" "https://localhost:9200/_cluster/health?pretty"
```

## 从 ES 8.x 迁移到 OpenSearch 3.x

OpenSearch 无法恢复由 Elasticsearch 8.x 拍摄的快照，因此 **从远程重新索引** 是此源版本唯一可用的方法。

同样的方法也适用于 ES 7.10 源，并且与快照与恢复不同，可以直接针对 OpenSearch 3.x，而无需中间 2.x 集群。有关权衡，请参见 [选择方法](#choosing-a-method)。

### 先决条件

- **网络连接**：OpenSearch 集群必须能够访问源集群的 HTTP/REST 端口（通常为 9200）。
- **索引设置和映射**：重新索引仅复制文档。在重新索引之前，请使用所需的设置和映射创建目标索引，否则目标索引将根据动态映射默认值创建，并且不会复制源的分片计数、自定义分析器或字段类型。

### 使用 ECK Operator 部署 ES 8.x

使用 ECK Operator 部署一个 Elasticsearch 8.17 集群：

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
如果您通过设置以下内容禁用 TLS：

```yaml
spec:
  http:
    tls:
      selfSignedCertificate:
        disabled: true
```

您必须在访问 Elasticsearch API 时使用 `http://` 而不是 `https://`。
:::

### 操作步骤

#### 步骤 1：配置 OpenSearch 进行远程重新索引

将以下配置添加到 `OpenSearchCluster` CR 的 `additionalConfig` 中：

```yaml
spec:
  general:
    additionalConfig:
      # 允许连接到 ES 8.x 主机。仅主机和端口 - 不要有 http:// 或 https:// 前缀。
      # 用逗号分隔多个主机。
      reindex.remote.allowlist: "es8-cluster-host:9200"
      # 禁用自签名证书的 SSL 验证
      reindex.ssl.verification_mode: "none"
```

:::warning 这是 `allowlist`，而不是 `whitelist`

Elasticsearch 和 OpenSearch 1.x 使用 `reindex.remote.whitelist`。OpenSearch 将设置重命名为 `reindex.remote.allowlist`，并在 2.x 中保留旧名称作为弃用别名。**OpenSearch 3.x 完全删除了旧名称**，因此从 Elasticsearch 文档复制的配置会导致每个节点在启动时失败，错误信息为：

```text
SettingsException[unknown setting [reindex.remote.whitelist] ...]
```

应用此更改会一次重启一个节点。在滚动继续之前，请确认第一个重启的节点返回到 `Running` 和 `Ready` 状态——请参见 [故障排除](#troubleshooting)。
:::

**确认设置实际生效** 一旦滚动完成。拼写错误的设置会导致节点崩溃，但 Operator 未能传播的设置是静默的——节点保持健康，稍后重新索引请求会失败，错误信息为 `[es8-cluster-host:9200] not allowlisted in reindex.remote.allowlist`：

```bash
curl -k -u "admin:<password>" "https://localhost:9200/_nodes/settings?filter_path=**.reindex*"
```

每个节点必须报告允许列表。如果响应为空，则该条目未到达节点（[opensearch-k8s-operator#883](https://github.com/opensearch-project/opensearch-k8s-operator/issues/883) 跟踪此问题）；请将其设置在 `nodePools[].additionalConfig` 中，或将其嵌入到自定义镜像中的 `opensearch.yml` 中，然后再次检查再继续。

#### 步骤 2：在 OpenSearch 上创建目标索引

重新索引仅复制文档，因此请在运行重新索引之前创建目标索引——或与其名称匹配的索引模板，使用您所需的设置和映射。

仅在源索引没有任何值得保留的映射或设置时跳过此步骤。

#### 步骤 3：在 OpenSearch 上执行重新索引

从 OpenSearch 集群发起重新索引请求。设置 `wait_for_completion=false` 以异步运行。

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

#### 步骤 4：监控重新索引进度

使用上一步的任务 ID 检查任务状态：

```bash
curl -k -u "admin:<password>" "https://localhost:9200/_tasks/N6q0j8s-T0m0j8s-T0m0j8:123456"
```

#### 步骤 5：验证重新索引完成

验证索引是否已创建并包含数据：

```bash
# 检查索引是否存在和文档计数（在 OpenSearch pod 上运行）
curl -k -u "admin:<password>" "https://localhost:9200/migration_test/_count"

# 与源 ES 8.x 集群比较（在 ES 8.x pod 上运行）
curl -k -u "elastic:<password>" "https://es8-cluster-host:9200/migration_test/_count"
```

## 故障排除

### 节点在配置更改后保持在 CrashLoopBackOff 状态

`spec.general.additionalConfig` 下的每个条目都会作为设置传递给 OpenSearch——使用 Operator 2.8.x 时，作为环境变量传递给 pods。Operator 不会验证这些值。未知或拼写错误的设置在节点启动时被拒绝，节点从未启动：

```text
[ERROR][o.o.b.OpenSearchUncaughtExceptionHandler] uncaught exception in thread [main]
org.opensearch.bootstrap.StartupException: SettingsException[unknown setting [reindex.remote.whitelist]
  please check that any required plugins are installed, or check the breaking changes documentation
  for removed settings]
```

Operator 一次重启一个节点，并等待每个节点变为就绪，因此滚动在第一个失败的节点处停止。其余节点继续运行先前的配置，这就是为什么集群仍然可以提供流量，而一个 pod 在循环中重启的原因。

要恢复：

```bash
# 1. 确定失败的节点和被拒绝的设置
kubectl get pods -n <namespace>
kubectl logs -n <namespace> <cluster-name>-masters-0 --tail=50

# 2. 在集群资源中更正设置
kubectl edit opensearchcluster -n <namespace> <cluster-name>

# 3. 确认 Operator 已重新生成配置。
#    使用 Operator 2.8.x，additionalConfig 条目成为 pods 上的环境变量，
#    因此首先检查 StatefulSet：
kubectl get sts -n <namespace> <cluster-name>-<nodepool> \
  -o jsonpath='{.spec.template.spec.containers[0].env}' | tr ',' '\n' | grep '<setting-name>'

#    其他 Operator 版本将相同条目呈现到挂载的 opensearch.yml 中。
#    如果设置不在 StatefulSet 环境中，请在集群的 ConfigMaps 中查找：
kubectl get cm -n <namespace> -o yaml | grep '<setting-name>'

# 4. 重启失败的 pod，以便它获取新配置
kubectl delete pod -n <namespace> <cluster-name>-masters-0

# 5. 观察滚动继续到其余节点
kubectl get pods -n <namespace> -w
```

:::note
设置是逐个验证的，因此节点仅报告它找到的第一个无效设置。如果在修复后再次失败，请对下一个报告的设置重复该过程。
:::

## 客户端迁移指南

无论源 ES 版本如何，**强烈建议切换到官方 OpenSearch 客户端**。

:::warning 兼容性说明

- Elasticsearch OSS 7.10.2 客户端可能与 OpenSearch 1.x 兼容，但最新的 ES 客户端包含许可证/版本检查，破坏了兼容性。
- **对于 OpenSearch 2.0 及更高版本，没有 Elasticsearch 客户端与 OpenSearch 完全兼容。**
- 强烈建议为 OpenSearch 集群使用 OpenSearch 客户端。
  :::

### OpenSearch 官方客户端

| 语言          | 客户端                         | 文档                                                                                                                                          |
| :------------ | :----------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| **Python**    | opensearch-py                  | [高级](https://docs.opensearch.org/latest/clients/python-high-level/)，[低级](https://docs.opensearch.org/latest/clients/python-low-level/) |
| **Java**      | opensearch-java                | [Java 客户端](https://docs.opensearch.org/latest/clients/java/)                                                                                  |
| **JavaScript**| @opensearch-project/opensearch | [Node.js 客户端](https://docs.opensearch.org/latest/clients/javascript/index)                                                                    |
| **Go**        | opensearch-go                  | [Go 客户端](https://docs.opensearch.org/latest/clients/go/)                                                                                      |
| **Ruby**      | opensearch-ruby                | [Ruby 客户端](https://docs.opensearch.org/latest/clients/ruby/)                                                                                  |
| **PHP**       | opensearch-php                 | [PHP 客户端](https://docs.opensearch.org/latest/clients/php/)                                                                                   |
| **.NET**      | OpenSearch.Client              | [.NET 客户端](https://docs.opensearch.org/latest/clients/dot-net/)                                                                              |
| **Rust**      | opensearch-rs                  | [Rust 客户端](https://docs.opensearch.org/latest/clients/rust/)                                                                                  |
| **Hadoop**    | opensearch-hadoop              | [GitHub](https://github.com/opensearch-project/opensearch-hadoop)                                                                                |

有关详细的迁移说明，请参见 [OpenSearch 客户端文档](https://docs.opensearch.org/latest/clients/)。

## 参考

- [OpenSearch 迁移指南](https://docs.opensearch.org/latest/upgrade-or-migrate/)
- [快照与恢复](https://docs.opensearch.org/latest/tuning-your-cluster/availability-and-recovery/snapshots/snapshot-restore/)
- [重新索引 API](https://docs.opensearch.org/latest/api-reference/document-apis/reindex/)
- [密钥库管理](https://docs.opensearch.org/latest/security/configuration/opensearch-keystore/)
