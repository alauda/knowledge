---
products:
  - Alauda Application Services
kind:
  - Solution
id: KB260300007
sourceSHA: 8bfec3a48d73d7884a6d20fc02b0bddcb6d518c0832190dfe4f7f490e3e9df53
---

# 如何使用 opensearch-operator 安装 IK Analyzer 插件

:::info
适用版本：OpenSearch Operator \~= 2.8.x, OpenSearch \~= 2.19.3 / 3.3.1
:::

本文档解释了如何使用 opensearch-operator 部署一个预安装 [IK Analyzer](https://github.com/infinilabs/analysis-ik) 插件的 OpenSearch 集群。IK Analyzer 是 OpenSearch/Elasticsearch 中使用最广泛的中文文本分析插件，提供智能和最大粒度的中文文本分词功能。

## 插件安装工作原理

opensearch-operator 通过在节点启动时将 `pluginsList` 中的每个条目传递给 `opensearch-plugin install` 命令来安装插件。您需要在两个地方配置 `pluginsList`：

| 字段                        | 目的                                                                     |
| :--------------------------- | :-------------------------------------------------------------------------- |
| `spec.general.pluginsList`   | 在所有 OpenSearch 数据/主节点上安装插件                                   |
| `spec.bootstrap.pluginsList` | 在用于初始集群形成的引导 Pod 上安装插件                                   |

这两个字段都必须配置。如果引导 Pod 缺少插件，而 `additionalConfig` 引用它，则集群初始化可能会失败。

:::note
在运行中的集群上添加或修改 `pluginsList` 将触发所有节点的 **滚动重启** 以安装新插件。
:::

## IK Analyzer 插件下载 URL

| OpenSearch 版本 | 插件下载 URL                                                                   |
| :----------------- | :------------------------------------------------------------------------------------ |
| **2.19.3**         | `https://release.infinilabs.com/analysis-ik/stable/opensearch-analysis-ik-2.19.3.zip` |
| **3.3.1**          | `https://release.infinilabs.com/analysis-ik/stable/opensearch-analysis-ik-3.3.1.zip`  |

:::note
在应用之前，请验证您的 OpenSearch 版本的插件 URL 是否可用。请检查 [Infinilabs 发布页面](https://github.com/infinilabs/analysis-ik/releases) 确认文件存在。如果 URL 返回 404，集群将无法启动。
:::

:::warning Air-Gapped Environments
如果您的 Kubernetes 集群没有外部网络访问，请先下载插件 zip 文件并将其托管在内部 HTTP 服务器上（例如 Nexus、Artifactory 或 Nginx）。然后用您内部可访问的 URL 替换下面配置中的下载 URL。
:::

## 使用 IK Analyzer 部署 OpenSearch

### 对于 OpenSearch 2.19.3

```yaml
apiVersion: opensearch.opster.io/v1
kind: OpenSearchCluster
metadata:
  name: my-cluster
  namespace: <namespace>
spec:
  general:
    serviceName: my-cluster
    version: 2.19.3
    setVMMaxMapCount: true
    pluginsList:
      - "https://release.infinilabs.com/analysis-ik/stable/opensearch-analysis-ik-2.19.3.zip"
  bootstrap:
    pluginsList:
      - "https://release.infinilabs.com/analysis-ik/stable/opensearch-analysis-ik-2.19.3.zip"
  security:
    tls:
      transport:
        generate: true
        perNode: true
      http:
        generate: true
  nodePools:
    - component: masters
      replicas: 3
      diskSize: "30Gi"
      persistence:
        pvc:
          storageClass: "<your-storage-class>"
          accessModes:
            - ReadWriteOnce
      roles:
        - "cluster_manager"
        - "data"
      resources:
        requests:
          memory: "2Gi"
          cpu: "500m"
        limits:
          memory: "2Gi"
          cpu: "500m"
  dashboards:
    enable: true
    version: 2.19.3
    replicas: 1
    resources:
      requests:
        memory: "512Mi"
        cpu: "200m"
      limits:
        memory: "512Mi"
        cpu: "200m"
```

### 对于 OpenSearch 3.3.1

```yaml
apiVersion: opensearch.opster.io/v1
kind: OpenSearchCluster
metadata:
  name: my-cluster
  namespace: <namespace>
spec:
  general:
    serviceName: my-cluster
    version: 3.3.1
    setVMMaxMapCount: true
    pluginsList:
      - "https://release.infinilabs.com/analysis-ik/stable/opensearch-analysis-ik-3.3.1.zip"
  bootstrap:
    pluginsList:
      - "https://release.infinilabs.com/analysis-ik/stable/opensearch-analysis-ik-3.3.1.zip"
  security:
    tls:
      transport:
        generate: true
        perNode: true
      http:
        generate: true
  nodePools:
    - component: masters
      replicas: 3
      diskSize: "30Gi"
      persistence:
        pvc:
          storageClass: "<your-storage-class>"
          accessModes:
            - ReadWriteOnce
      roles:
        - "cluster_manager"
        - "data"
      resources:
        requests:
          memory: "2Gi"
          cpu: "500m"
        limits:
          memory: "2Gi"
          cpu: "500m"
  dashboards:
    enable: true
    version: 3.3.0  # Dashboards 3.3.0 是与 OpenSearch 3.3.1 兼容的最新版本
    replicas: 1
    resources:
      requests:
        memory: "512Mi"
        cpu: "200m"
      limits:
        memory: "512Mi"
        cpu: "200m"
```

应用配置：

```bash
kubectl apply -f cluster.yaml
```

## 验证插件是否已安装

集群运行后，验证 IK 插件是否已安装在节点上：

```bash
kubectl -n <namespace> exec my-cluster-masters-0 -- bin/opensearch-plugin list
```

输出应包括 `analysis-ik`。

## 测试 IK Analyzer

端口转发 OpenSearch 服务并运行快速分词测试：

```bash
kubectl -n <namespace> port-forward svc/my-cluster 9200
```

**测试 `ik_max_word` 分析器**（最大粒度，将文本拆分为所有可能的令牌）：

```bash
# 操作符生成自签名证书； -k 跳过本地证书验证
curl -k -u admin:admin -X POST "https://localhost:9200/_analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "analyzer": "ik_max_word",
    "text": "自然语言处理技术在人工智能领域的应用越来越广泛"
  }'
```

预期输出：

```json
{
  "tokens": [
    { "token": "自然语言",   "start_offset": 0,  "end_offset": 4,  "type": "CN_WORD", "position": 0 },
    { "token": "自然",       "start_offset": 0,  "end_offset": 2,  "type": "CN_WORD", "position": 1 },
    { "token": "语言",       "start_offset": 2,  "end_offset": 4,  "type": "CN_WORD", "position": 2 },
    { "token": "处理",       "start_offset": 4,  "end_offset": 6,  "type": "CN_WORD", "position": 3 },
    { "token": "技术",       "start_offset": 6,  "end_offset": 8,  "type": "CN_WORD", "position": 4 },
    { "token": "在",         "start_offset": 8,  "end_offset": 9,  "type": "CN_CHAR", "position": 5 },
    { "token": "人工智能",   "start_offset": 9,  "end_offset": 13, "type": "CN_WORD", "position": 6 },
    { "token": "人工",       "start_offset": 9,  "end_offset": 11, "type": "CN_WORD", "position": 7 },
    { "token": "智能",       "start_offset": 11, "end_offset": 13, "type": "CN_WORD", "position": 8 },
    { "token": "领域",       "start_offset": 13, "end_offset": 15, "type": "CN_WORD", "position": 9 },
    { "token": "的",         "start_offset": 15, "end_offset": 16, "type": "CN_CHAR", "position": 10 },
    { "token": "应用",       "start_offset": 16, "end_offset": 18, "type": "CN_WORD", "position": 11 },
    { "token": "越来越",     "start_offset": 18, "end_offset": 21, "type": "CN_WORD", "position": 12 },
    { "token": "越来",       "start_offset": 18, "end_offset": 20, "type": "CN_WORD", "position": 13 },
    { "token": "越",         "start_offset": 20, "end_offset": 21, "type": "CN_CHAR", "position": 14 },
    { "token": "广泛",       "start_offset": 21, "end_offset": 23, "type": "CN_WORD", "position": 15 }
  ]
}
```

**测试 `ik_smart` 分析器**（粗粒度，将文本拆分为最少的令牌）：

```bash
# 操作符生成自签名证书； -k 跳过本地证书验证
curl -k -u admin:admin -X POST "https://localhost:9200/_analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "analyzer": "ik_smart",
    "text": "自然语言处理技术在人工智能领域的应用越来越广泛"
  }'
```

预期输出：

```json
{
  "tokens": [
    { "token": "自然语言", "start_offset": 0,  "end_offset": 4,  "type": "CN_WORD", "position": 0 },
    { "token": "处理",   "start_offset": 4,  "end_offset": 6,  "type": "CN_WORD", "position": 1 },
    { "token": "技术",   "start_offset": 6,  "end_offset": 8,  "type": "CN_WORD", "position": 2 },
    { "token": "在",     "start_offset": 8,  "end_offset": 9,  "type": "CN_CHAR", "position": 3 },
    { "token": "人工智能", "start_offset": 9,  "end_offset": 13, "type": "CN_WORD", "position": 4 },
    { "token": "领域",   "start_offset": 13, "end_offset": 15, "type": "CN_WORD", "position": 5 },
    { "token": "的",     "start_offset": 15, "end_offset": 16, "type": "CN_CHAR", "position": 6 },
    { "token": "应用",   "start_offset": 16, "end_offset": 18, "type": "CN_WORD", "position": 7 },
    { "token": "越来越", "start_offset": 18, "end_offset": 21, "type": "CN_WORD", "position": 8 },
    { "token": "广泛",   "start_offset": 21, "end_offset": 23, "type": "CN_WORD", "position": 9 }
  ]
}
```

## 在索引映射中使用 IK Analyzer

创建索引时，为中文文本字段指定 `ik_max_word` 或 `ik_smart` 作为分析器：

```bash
curl -k -u admin:admin -X PUT "https://localhost:9200/my-index" \
  -H "Content-Type: application/json" \
  -d '{
    "settings": {
      "analysis": {
        "analyzer": {
          "ik_max_word_analyzer": {
            "type": "ik_max_word"
          },
          "ik_smart_analyzer": {
            "type": "ik_smart"
          }
        }
      }
    },
    "mappings": {
      "properties": {
        "title": {
          "type": "text",
          "analyzer": "ik_max_word",
          "search_analyzer": "ik_smart"
        },
        "content": {
          "type": "text",
          "analyzer": "ik_max_word",
          "search_analyzer": "ik_smart"
        }
      }
    }
  }'
```

:::note
使用 `ik_max_word` 进行索引，使用 `ik_smart` 进行搜索是一种常见模式：它在索引时最大化召回，同时保持搜索查询的精确性。
:::

## （可选）挂载自定义词典

IK Analyzer 支持通过 `IKAnalyzer.cfg.xml` 自定义词典和停用词列表。要将自定义词典挂载到集群中，请使用 `additionalVolumes` 和 ConfigMap。

### 第 1 步：创建 ConfigMap

准备您的自定义词典文件并创建 ConfigMap。以下示例添加了一个自定义词表：

```bash
# custom_dict.dic — 每行一个词
cat > custom_dict.dic << 'EOF'
云原生
容器编排
服务网格
EOF

# IKAnalyzer.cfg.xml — 引用自定义词典
cat > IKAnalyzer.cfg.xml << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">
<properties>
  <comment>IK Analyzer 扩展配置</comment>
  <!-- 自定义扩展词典；多个文件用 ; 分隔 -->
  <entry key="ext_dict">custom_dict.dic</entry>
  <!-- 自定义停用词词典；多个文件用 ; 分隔 -->
  <entry key="ext_stopwords"></entry>
</properties>
EOF

kubectl -n <namespace> create configmap ik-custom-dict \
  --from-file=custom_dict.dic \
  --from-file=IKAnalyzer.cfg.xml
```

### 第 2 步：通过 additionalVolumes 挂载 ConfigMap

在您的 `OpenSearchCluster` CR 的 `spec.general` 中添加 `additionalVolumes` 部分：

```yaml
spec:
  general:
    pluginsList:
      - "https://release.infinilabs.com/analysis-ik/stable/opensearch-analysis-ik-2.19.3.zip"
    additionalVolumes:
      - name: ik-custom-dict
        path: /usr/share/opensearch/plugins/analysis-ik/config
        restartPods: true  # 当 ConfigMap 内容更改时重启 Pods
        configMap:
          name: ik-custom-dict
```

应用后，Pods 将重启并获取新词典。通过使用您的自定义术语运行 `_analyze` 请求来验证。

## 参考

- [opensearch-operator: 添加插件](https://github.com/opensearch-project/opensearch-k8s-operator/blob/v2.8.0/docs/userguide/main.md#adding-plugins)
- [opensearch-operator: 附加卷](https://github.com/opensearch-project/opensearch-k8s-operator/blob/v2.8.0/docs/userguide/main.md#additional-volumes)
- [IK Analyzer for OpenSearch (Infinilabs)](https://github.com/infinilabs/analysis-ik)
