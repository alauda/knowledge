---
products:
  - Alauda Application Services
kind:
  - Solution
id: KB260100026
sourceSHA: 4d71480f5d5df1aa4044adeeedaadb443b8cd9b2bd075df00f762f1ec153febe
---

# 如何从 Elasticsearch 迁移到 OpenSearch

:::info
适用版本：OpenSearch Operator \~= 2.8.\*, OpenSearch \~= 2.x / 3.x
:::

本文档提供了从 Elasticsearch (ES) 迁移到 OpenSearch 的详细指导。

## 迁移策略概述

| 源版本       | 目标版本       | 迁移方法                   | 备注                                           |
| :----------- | :------------- | :------------------------- | :---------------------------------------------- |
| **ES 7.10**  | **OS 2.x**     | 快照与恢复                 | ✅ 支持直接恢复                                |
| **ES 7.10**  | **OS 3.x**     | 快照与恢复 → 升级         | ⚠️ 必须先恢复到 OS 2.x，然后再升级           |
| **ES 8.x**   | **OS 3.x**     | 从远程重建索引             | ✅ 支持直接迁移                                |

:::warning 关键兼容性说明

- **ES 7.10 → OS 3.x 直接恢复不被支持**。OpenSearch 3.x 要求索引必须使用 OpenSearch 2.0.0+ 创建。
- ES 7.10 快照必须先恢复到 OpenSearch 2.x，然后再将集群升级到 OS 3.x。
- ES 8.x 使用不兼容的 Lucene 版本，因此快照与恢复不可用；请使用从远程重建索引。

:::

本指南使用 ES 7.10 作为快照与恢复方法的源，使用 ES 8.17 作为从远程重建索引的方法。如果您的源版本不同，请相应调整。

## 从 ES 7.10 迁移到 OpenSearch 3.x（经由 2.x）

此迁移需要 **三阶段方法**：

- **第 0 阶段**：在源 Elasticsearch 7.10 集群上创建快照
- **第一阶段**：将该快照恢复到 OpenSearch 2.x
- **第二阶段**：对恢复的索引重建索引，然后将 OpenSearch 2.x 升级到 3.x

### 前提条件

- 一个共享存储后端（例如，S3 Bucket，GCS Bucket），源集群和目标集群均可访问。
- 在两个集群上安装 `repository-s3` 插件（或相应的存储后端插件）。

#### 检查插件是否已安装

在两个集群上分别执行检查：

```bash
# 在 Elasticsearch pod 上
curl -u "elastic:<password>" "http://localhost:9200/_cat/plugins?v"

# 在 OpenSearch pod 上
curl -k -u "admin:<password>" "https://localhost:9200/_cat/plugins?v"
```

:::info
请记得在此处以及后续所有命令中，将 `<password>` 替换为您集群的凭据。

- 对于 Elasticsearch，默认用户为 `elastic`，密码在创建时随机生成。
- 对于 OpenSearch，默认用户为 `admin`，密码保存在 `<集群名称>-admin-password` Secret 中。详见 *How to Set and Update the OpenSearch Admin Password*。
:::

#### 安装 repository-s3 插件

首先读取每个集群实际运行的版本号，下载 URL 需要使用它：

```bash
# 在 Elasticsearch pod 上
curl -s -u "elastic:<password>" "http://localhost:9200" | grep '"number"'

# 在 OpenSearch pod 上
curl -sk -u "admin:<password>" "https://localhost:9200" | grep '"number"'
```

然后将该版本号代入对应的 URL 模板：

| 产品 | 下载 URL 模板 |
| :--- | :--- |
| Elasticsearch | `https://artifacts.elastic.co/downloads/elasticsearch-plugins/repository-s3/repository-s3-<VERSION>.zip` |
| OpenSearch | `https://artifacts.opensearch.org/releases/plugins/repository-s3/<VERSION>/repository-s3-<VERSION>.zip` |

:::warning 版本必须完全一致
`elasticsearch-plugin install` / `opensearch-plugin install` 会读取插件包中记录的版本，并 **拒绝安装到任何其他版本的节点上**（补丁版本不同也不行）。版本不匹配会导致节点无法启动。

本文档示例中 Elasticsearch 使用 `7.10.2`，OpenSearch 使用 `2.19.3` / `3.3.1`。这些仅为示例：**请将文中每一处都替换为您集群实际运行的版本。**
:::

:::warning 空气隔离环境

如果您的 Kubernetes 集群没有外部网络访问，请先下载插件 zip 文件并将其托管在内部 HTTP 服务器（例如 Nexus、Artifactory 或 Nginx）上。然后在以下配置中将下载 URL 替换为您内部可访问的 URL。

:::

**ES 7.10 (Helm Chart)：**

在 **应用容器平台** > **应用** > **应用** 页面：

- 找到 elasticsearch 实例
- 点击 **更新**
- 切换到 **YAML** 编辑页面

在 **自定义** 输入文本框中更新 `values.yaml`，内容如下：

```yaml
masterNodes:
  config:
    elasticsearch.yml: |
      s3.client.default.endpoint: "http://minio.example.com:9000"
      s3.client.default.region: "us-east-1"
      s3.client.default.path_style_access: true  # MinIO 所需

extraInitContainers:
  - name: install-plugins
    image: docker.elastic.co/elasticsearch/elasticsearch-oss:7.10.2
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
- init 容器必须使用 **与您节点当前运行的相同的 Elasticsearch 镜像**，上面的镜像仅为示例。
- 在 `/usr/share/elasticsearch/plugins` 上挂载 `emptyDir` 会遮蔽该目录中已安装的内容，因此 init 容器必须安装集群需要的全部插件，而不仅仅是 `repository-s3`。
- 上述配置仅为主节点设置 S3 配置。如果您有专用的数据节点，请将相同的 S3 配置添加到 `dataNodes` 中。
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

:::warning 每次修改 `additionalConfig` 或 `pluginsList` 都会重启整个集群

- 这两种方法都会触发 **所有节点逐个滚动重启**，以加载新的配置或插件。
- `additionalConfig` 下的值会被直接写入 `opensearch.yml`，Operator **不会对其做校验**。未知或拼写错误的设置只有在节点启动时才会被拒绝，此时节点将无法启动 —— 参见 [故障排查](#故障排查)。
- 由于节点是逐个重启的，请先确认第一个重启的节点恢复到 `Running` 且 `Ready`，再让滚动继续。如果没有恢复，请在其余节点应用该配置之前先修正配置。
- `pluginsList` 中的插件会在 **每次 Pod 启动时** 下载并安装，而不是只装一次。该 URL 必须对每个节点持续可达，或改用已预装插件的镜像。
:::

### 第 0 阶段：在 Elasticsearch 7.10 上创建快照

#### 第 1 步：配置 S3 凭据

出于安全原因，避免在 API 请求体中直接包含访问密钥。请使用密钥库。

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

   :::warning 每个 Elasticsearch Pod 都要执行
   密钥库是每个节点自己配置目录中的文件，而 `reload_secure_settings` 只会重新加载各节点上已经存在的内容。**请在每一个 Elasticsearch Pod（主节点和数据节点）上都执行第 1 步**，然后再调用重新加载，否则缺少凭据的节点会导致快照失败。

   密钥库同样位于容器文件系统中：除非您的 Chart 对 Elasticsearch 配置目录做了持久化，否则 Pod 重启后凭据会丢失，需要重新添加。
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

   > Operator 将自动挂载该 Secret 并重新加载安全设置。

#### 第 2 步：在源集群（ES 7.10）上注册快照存储库

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

#### 第 3 步：在源集群（ES 7.10）上创建完整快照

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
上面的 `indices` 模式已排除系统索引（`.kibana*`、`.security*`、`.monitoring*`、`apm*`、`.apm*`）。这些索引是 Elasticsearch 特有的，在恢复时会与 OpenSearch 的内部索引发生冲突；在快照时排除它们还可以减小快照体积。

由于这些索引不会被迁移，它们所保存的对象也不会随之迁移：Kibana 的已保存对象（索引模式、可视化、仪表板）以及 Elasticsearch 的用户、角色和角色映射，都需要在 OpenSearch 侧重新创建。
:::

### 第一阶段：恢复到 OpenSearch 2.x

#### 第 1 步：部署 OpenSearch 2.x 集群

使用 OpenSearch Operator 部署一个新的 OpenSearch **2.x** 集群。完整的部署流程请参见 *OpenSearch Installation Guide*；下面的片段只列出本次迁移需要的字段。

:::note
请将 `version` 设置为您环境中可用的 OpenSearch 版本。在没有外网访问的集群上，只有已安装插件包中包含的 OpenSearch 版本才能拉取到镜像 —— 请先确认哪些版本可用，并在 `pluginsList` 的 URL 中使用同一版本。
:::

```yaml
apiVersion: opensearch.opster.io/v1
kind: OpenSearchCluster
metadata:
  name: my-cluster
spec:
  general:
    version: 2.19.3
    additionalConfig:
      s3.client.default.endpoint: "http://minio.example.com:9000"
      s3.client.default.region: "us-east-1"
      s3.client.default.path_style_access: "true"
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
          readonly: "true"
    ...
```

#### 第 2 步：在 OpenSearch 上恢复快照

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
- 如果同名索引已存在且处于 open 状态，恢复会失败。请先删除或关闭目标索引，或使用 `rename_pattern` / `rename_replacement` 以其他名称恢复。
- 恢复出来的索引会保留源集群的副本数。如果目标集群节点更少，请在请求体中加入 `"index_settings": {"index.number_of_replicas": 1}`，否则恢复后的索引会一直是 yellow 状态。
- `include_global_state` 为 `false`，因此索引模板、旧版模板和 ingest pipeline **不会** 被恢复，需要在 OpenSearch 上重新创建所需的部分。索引生命周期管理（ILM）策略没有直接对应物，必须重建为索引状态管理（ISM）策略。
:::

#### 第 3 步：验证

验证索引数量和文档数量与源集群匹配：

```bash
# 检查 OpenSearch pod 上的索引
curl -k -u "admin:<password>" "https://localhost:9200/_cat/indices?v"

# 检查 OpenSearch pod 上的文档数量
curl -k -u "admin:<password>" "https://localhost:9200/<index_name>/_count"
```

### 第二阶段：重建索引并升级到 OpenSearch 3.x

:::warning 关键步骤
从 ES 7.10 快照恢复的索引保留其原始版本元数据（`7.10.2`）。OpenSearch 3.x 要求索引的版本为 `2.0.0+`。您 **必须在 OpenSearch 2.x 中重建** 所有恢复的索引，然后才能升级。
:::

#### 第 1 步：在恢复的 OpenSearch 上重建所有恢复的索引

对于每个恢复的索引，创建一个新索引并重建数据：

:::note
- 以下示例使用 `migration_test` 作为索引名称。在执行这些命令时，请将 `migration_test` 替换为您的实际索引名称。
- 这些命令需要 `jq`。如果 OpenSearch 容器中没有该工具，请在能够访问集群的工作机上执行。
- 复制索引 **settings** 很重要：分片数、自定义分析器等配置保存在 settings 中，而不在 mappings 中。如果索引使用了自定义分析器，还必须先在目标集群上安装对应的分析插件，新索引才能创建成功。
:::

```bash
# 1. 导出源索引定义（settings 和 mappings），并去掉新索引上无法设置的只读字段

curl -s -k -u "admin:<password>" "https://localhost:9200/migration_test" | \
  jq '.migration_test
      | {settings: .settings, mappings: .mappings}
      | del(.settings.index.uuid,
            .settings.index.creation_date,
            .settings.index.version,
            .settings.index.provided_name)' > index_def.json

# 2. 使用相同的 settings 和 mappings 创建新索引（添加后缀 _v2）

curl -k -u "admin:<password>" -X PUT "https://localhost:9200/migration_test_v2" \
  -H 'Content-Type: application/json' \
  -d @index_def.json

# 3. 从旧索引重建数据到新索引

curl -k -u "admin:<password>" -X POST "https://localhost:9200/_reindex?wait_for_completion=true" \
  -H 'Content-Type: application/json' -d'
{
  "source": { "index": "migration_test" },
  "dest": { "index": "migration_test_v2" }
}'

# 4. 删除旧索引并创建别名（或重命名）
curl -k -u "admin:<password>" -X DELETE "https://localhost:9200/migration_test"
curl -k -u "admin:<password>" -X POST "https://localhost:9200/_aliases" \
  -H 'Content-Type: application/json' -d'
{
  "actions": [
    { "add": { "index": "migration_test_v2", "alias": "migration_test" } }
  ]
}'
```

对所有恢复的索引重复此操作。重建后，验证新索引版本：

```bash
curl -k -u "admin:<password>" "https://localhost:9200/migration_test_v2/_settings?filter_path=**.version"
```

`version.created` 应显示 OpenSearch 2.x 的内部版本号（例如 OS 2.19.x 为 `136408127`），而不是 ES 7.10.2 索引所带的 `7102099`。任何 `136xxxxxx` 形式的值都表示该索引由 OpenSearch 2.x 创建，重建成功。

#### 第 2 步：升级 OpenSearch 集群

:::warning
开始升级前，请先对 OpenSearch 2.x 集群做一次快照。大版本升级无法就地回滚。
:::

更新 `OpenSearchCluster` CR 以升级版本。OpenSearch 与 OpenSearch Dashboards 请使用相同的版本：

```yaml
spec:
  general:
    version: 3.3.1  # 升级到 OpenSearch 3.x
    pluginsList:
    - https://artifacts.opensearch.org/releases/plugins/repository-s3/3.3.1/repository-s3-3.3.1.zip
  dashboards:
    version: 3.3.1  # 将 OpenSearch Dashboards 升级到相同版本
```

Operator 将自动执行滚动升级。

#### 第 3 步：升级后验证

验证所有索引在升级后是否可访问：

```bash
curl -k -u "admin:<password>" "https://localhost:9200/_cat/indices?v"
curl -k -u "admin:<password>" "https://localhost:9200/_cluster/health?pretty"
```

## 从 ES 8.x 迁移到 OpenSearch 3.x

Elasticsearch 8.x 使用更新的 Lucene 版本，具有不兼容的元数据协议，使快照无法被 OpenSearch 读取。请改用 **从远程重建索引**。

### 前提条件

- **网络连接**：OpenSearch 集群必须能够访问 ES 8.x 集群的 HTTP/REST 端口（通常为 9200）。

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

#### 第 1 步：配置 OpenSearch 进行远程重建索引

将以下配置添加到 `OpenSearchCluster` CR 的 `additionalConfig` 中：

```yaml
spec:
  general:
    additionalConfig:
      # 允许连接到 ES 8.x 主机。只写主机和端口，不带 http:// 或 https:// 前缀。
      # 多个主机之间用逗号分隔。
      reindex.remote.allowlist: "es8-cluster-host:9200"
      # 禁用自签名证书的 SSL 验证
      reindex.ssl.verification_mode: "none"
```

:::warning 是 `allowlist`，不是 `whitelist`

Elasticsearch 以及 OpenSearch 1.x 使用的是 `reindex.remote.whitelist`。OpenSearch 将该设置重命名为 `reindex.remote.allowlist`，并在 2.x 中把旧名称保留为已废弃的别名。**OpenSearch 3.x 彻底移除了旧名称**，因此从 Elasticsearch 文档照搬过来的配置会让每个节点在启动时失败：

```text
SettingsException[unknown setting [reindex.remote.whitelist] ...]
```

应用该变更会让节点逐个重启。请确认第一个重启的节点恢复到 `Running` 且 `Ready`，再让滚动继续 —— 参见 [故障排查](#故障排查)。
:::

#### 第 2 步：在 OpenSearch 上创建索引模板（可选但推荐）

如果您的 ES 8.x 索引依赖于特定的设置或映射，建议提前在 OpenSearch 中手动创建相应的索引模板或映射。

#### 第 3 步：在 OpenSearch 上执行重建索引

从 OpenSearch 集群发起重建索引请求。设置 `wait_for_completion=false` 以异步运行。

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

#### 第 4 步：监控重建进度

使用上一步中的任务 ID 检查任务状态：

```bash
curl -k -u "admin:<password>" "https://localhost:9200/_tasks/N6q0j8s-T0m0j8s-T0m0j8:123456"
```

#### 第 5 步：验证重建完成

验证索引是否已创建并包含数据：

```bash
# 检查索引是否存在及文档数量（在 OpenSearch pod 上运行）
curl -k -u "admin:<password>" "https://localhost:9200/migration_test/_count"

# 与源 ES 8.x 集群比较（在 ES 8.x pod 上运行）
curl -k -u "elastic:<password>" "https://es8-cluster-host:9200/migration_test/_count"
```

## 故障排查

### 修改配置后节点一直处于 CrashLoopBackOff

放在 `spec.general.additionalConfig` 下的值会被直接写入 `opensearch.yml`，Operator 不会对其做校验。未知或拼写错误的设置会在节点启动时被拒绝，节点将无法启动：

```text
[ERROR][o.o.b.OpenSearchUncaughtExceptionHandler] uncaught exception in thread [main]
org.opensearch.bootstrap.StartupException: SettingsException[unknown setting [reindex.remote.whitelist]
  please check that any required plugins are installed, or check the breaking changes documentation
  for removed settings]
```

Operator 逐个重启节点，并等待每个节点就绪，因此滚动会停在第一个失败的节点上。其余节点仍运行着此前的配置 —— 这正是为什么某个 Pod 反复重启时，集群仍可能在正常提供服务。

恢复步骤：

```bash
# 1. 确认失败的节点以及被拒绝的设置
kubectl get pods -n <namespace>
kubectl logs -n <namespace> <cluster-name>-masters-0 --tail=50

# 2. 在集群资源中修正该设置
kubectl edit opensearchcluster -n <namespace> <cluster-name>

# 3. 确认 Operator 已重新生成配置
kubectl get cm -n <namespace> -o yaml | grep -n '<setting-name>'

# 4. 重启失败的 Pod，使其加载新配置
kubectl delete pod -n <namespace> <cluster-name>-masters-0

# 5. 观察滚动继续应用到其余节点
kubectl get pods -n <namespace> -w
```

:::note
设置是逐条校验的，节点只会报告它发现的第一个非法设置。如果修复后仍然启动失败，请针对下一个报告出来的设置重复上述步骤。
:::

## 客户端迁移指南

无论源 ES 版本如何，**强烈建议切换到官方 OpenSearch 客户端**。

:::warning 兼容性说明

- Elasticsearch OSS 7.10.2 客户端可能与 OpenSearch 1.x 兼容，但最新的 ES 客户端包含许可证/版本检查，导致不兼容。
- **对于 OpenSearch 2.0 及更高版本，没有 Elasticsearch 客户端与 OpenSearch 完全兼容。**
- 强烈建议使用 OpenSearch 客户端连接 OpenSearch 集群。
  :::

### OpenSearch 官方客户端

| 语言           | 客户端                         | 文档                                                                                                                                              |
| :------------- | :----------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Python**     | opensearch-py                  | [高级](https://docs.opensearch.org/latest/clients/python-high-level/)，[低级](https://docs.opensearch.org/latest/clients/python-low-level/) |
| **Java**       | opensearch-java                | [Java 客户端](https://docs.opensearch.org/latest/clients/java/)                                                                                  |
| **JavaScript** | @opensearch-project/opensearch | [Node.js 客户端](https://docs.opensearch.org/latest/clients/javascript/index)                                                                    |
| **Go**         | opensearch-go                  | [Go 客户端](https://docs.opensearch.org/latest/clients/go/)                                                                                      |
| **Ruby**       | opensearch-ruby                | [Ruby 客户端](https://docs.opensearch.org/latest/clients/ruby/)                                                                                  |
| **PHP**        | opensearch-php                 | [PHP 客户端](https://docs.opensearch.org/latest/clients/php/)                                                                                    |
| **.NET**       | OpenSearch.Client              | [.NET 客户端](https://docs.opensearch.org/latest/clients/dot-net/)                                                                              |
| **Rust**       | opensearch-rs                  | [Rust 客户端](https://docs.opensearch.org/latest/clients/rust/)                                                                                  |
| **Hadoop**     | opensearch-hadoop              | [GitHub](https://github.com/opensearch-project/opensearch-hadoop)                                                                                 |

有关详细的迁移说明，请参阅 [OpenSearch 客户端文档](https://docs.opensearch.org/latest/clients/)。

## 参考

- [OpenSearch 迁移指南](https://docs.opensearch.org/latest/upgrade-or-migrate/)
- [快照和恢复](https://docs.opensearch.org/latest/tuning-your-cluster/availability-and-recovery/snapshots/snapshot-restore/)
- [重建索引 API](https://docs.opensearch.org/latest/api-reference/document-apis/reindex/)
- [密钥库管理](https://docs.opensearch.org/latest/security/configuration/opensearch-keystore/)
