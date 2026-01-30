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

## 从 ES 7.10 迁移到 OpenSearch 2.x 到 3.x

此迁移需要 **两阶段方法**：

- **第一阶段**：将 ES 7.10 快照恢复到 OpenSearch 2.x
- **第二阶段**：将 OpenSearch 2.x 升级到 3.x

### 前提条件

- 一个共享存储后端（例如，S3 Bucket，GCS Bucket），源集群和目标集群均可访问。
- 在两个集群上安装 `repository-s3` 插件（或相应的存储后端插件）。

#### 检查插件是否已安装

```bash
curl -u "elastic:<password>" "http://localhost:9200/_cat/plugins?v"
```

:::info
请记得在上述命令和以下命令中将 `<password>` 替换为您集群的凭据。

对于 Elasticsearch，默认用户为 `elastic`，默认密码在创建时随机生成。
:::

#### 安装 repository-s3 插件

插件下载 URL：

| 版本             | 下载 URL                                                                                          |
| :--------------- | :-------------------------------------------------------------------------------------------------- |
| ES 7.10.2       | `https://artifacts.elastic.co/downloads/elasticsearch-plugins/repository-s3/repository-s3-7.10.2.zip` |
| OpenSearch 2.19.3 | `https://artifacts.opensearch.org/releases/plugins/repository-s3/2.19.3/repository-s3-2.19.3.zip`     |
| OpenSearch 3.3.1  | `https://artifacts.opensearch.org/releases/plugins/repository-s3/3.3.1/repository-s3-3.3.1.zip`       |

:::note
插件版本 **必须完全匹配** Elasticsearch/OpenSearch 版本。例如，OpenSearch 3.3.1 需要 `repository-s3-3.3.1.zip`。
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
      s3.client.default.endpoint: "<http://minio.example.com:9000>"
      s3.client.default.region: "us-east-1"
      s3.client.default.path_style_access: true  # MinIO 所需

extraInitContainers:
  - name: install-plugins
    image: harbor.alauda.cn/middleware/elasticsearch:v7.10.2
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
上述配置仅为主节点设置 S3 配置。如果您有专用的数据节点，请将相同的 S3 配置添加到 `dataNodes` 中。
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
      s3.client.default.endpoint: "<http://minio.example.com:9000>"
      s3.client.default.region: "us-east-1"
      s3.client.default.path_style_access: "true"
    pluginsList:
    - https://artifacts.opensearch.org/releases/plugins/repository-s3/2.19.3/repository-s3-2.19.3.zip
```

:::note
这两种方法都会触发节点的滚动重启，以加载新安装的插件。
:::

### 操作步骤

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
  "indices": "*",
  "ignore_unavailable": true,
  "include_global_state": true 
}'
```

:::note 排除系统索引
建议在创建快照时排除系统索引（`.kibana*`、`.security*`、`.monitoring*`、`apm*`、`.apm*`）。这些索引是 Elasticsearch 特有的，在恢复时会与 OpenSearch 的内部索引发生冲突。通过在快照时排除它们，可以减少快照大小并避免潜在的恢复问题。
:::

### 第一阶段：恢复到 OpenSearch 2.x

#### 第 1 步：部署 OpenSearch 2.x 集群

使用 OpenSearch Operator 部署一个新的 OpenSearch **2.x** 集群：

```yaml
apiVersion: opensearch.opster.io/v1
kind: OpenSearchCluster
metadata:
  name: my-cluster
spec:
  general:
    version: 2.19.3
    additionalConfig:
      s3.client.default.endpoint: "<http://minio.example.com:9000>"
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

:::info
请记得在上述命令和以下命令中将 `<password>` 替换为您集群的凭据。

对于 OpenSearch，默认用户为 `admin`，默认密码为 `admin`。
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
以下示例使用 `migration_test` 作为索引名称。在执行这些命令时，请将 `migration_test` 替换为您的实际索引名称。
:::

```bash
# 1. 获取原始索引映射并使用 sed 提取映射对象

curl -s -k -u "admin:<password>" "https://localhost:9200/migration_test/_mapping" | \
  sed 's/^{"migration_test"://' | sed 's/}$//' > mapping.json

# 2. 创建一个具有相同映射的新索引（添加后缀 _v2）

curl -k -u "admin:<password>" -X PUT "https://localhost:9200/migration_test_v2" \
  -H 'Content-Type: application/json' \
  -d @mapping.json

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

`version.created` 应显示 OpenSearch 2.x 内部版本号（例如，`136408127` 对于 OS 2.19.x）。ES 7.10.2 索引显示 `7102099`。如果您看到以 `136` 开头或更高的数字，则重建成功。

#### 第 2 步：升级 OpenSearch 集群

更新 `OpenSearchCluster` CR 以升级版本：

```yaml
spec:
  general:
    version: 3.3.1  # 升级到 OpenSearch 3.x
    pluginsList:
    - https://artifacts.opensearch.org/releases/plugins/repository-s3/3.3.1/repository-s3-3.3.1.zip
  dashboards:
    version: 3.3.0  # 同时升级 OpenSearch Dashboards
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
      # 允许连接到 ES 8.x 主机（OpenSearch 3.x 使用 'allowlist'）
      reindex.remote.allowlist: "es8-cluster-host:9200"
      # 禁用自签名证书的 SSL 验证
      reindex.ssl.verification_mode: "none"
```

> **注意**：应用此配置更改后，节点将重启。

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
