---
products:
  - Alauda Application Services
kind:
  - Solution
---

# How to Install the IK Analyzer Plugin for OpenSearch Using opensearch-operator

:::info
Applicable Version: OpenSearch Operator ~= 2.8.x, OpenSearch ~= 2.19.3 / 3.3.1
:::

This document explains how to deploy an OpenSearch cluster with the [IK Analyzer](https://github.com/infinilabs/analysis-ik) plugin pre-installed using the opensearch-operator. The IK Analyzer is the most widely used Chinese text analysis plugin for OpenSearch/Elasticsearch, providing smart and maximum-granularity tokenization for Chinese text.

## How Plugin Installation Works

The opensearch-operator installs plugins by passing each entry in `pluginsList` to the `opensearch-plugin install` command during node startup. You need to configure `pluginsList` in two places:

| Field | Purpose |
| :--- | :--- |
| `spec.general.pluginsList` | Installs the plugin on all OpenSearch data/master nodes |
| `spec.bootstrap.pluginsList` | Installs the plugin on the bootstrap pod used for initial cluster formation |

Both must be configured. If the bootstrap pod is missing the plugin while `additionalConfig` references it, cluster initialization may fail.

:::note
Adding or modifying `pluginsList` on a running cluster will trigger a **rolling restart** of all nodes to install the new plugin.
:::

## IK Analyzer Plugin Download URLs

| OpenSearch Version | Plugin Download URL |
| :--- | :--- |
| **2.19.3** | `https://release.infinilabs.com/analysis-ik/stable/opensearch-analysis-ik-2.19.3.zip` |
| **3.3.1** | `https://release.infinilabs.com/analysis-ik/stable/opensearch-analysis-ik-3.3.1.zip` |

:::note
Before applying, verify that the plugin URL for your OpenSearch version is available. Check the [Infinilabs releases page](https://github.com/infinilabs/analysis-ik/releases) to confirm the file exists. If the URL returns a 404, the cluster will fail to start.
:::

:::warning Air-Gapped Environments
If your Kubernetes cluster does not have external network access, download the plugin zip files first and host them on an internal HTTP server (e.g., Nexus, Artifactory, or Nginx). Then replace the download URLs in the configurations below with your internal accessible URLs.
:::

## Deploy OpenSearch with IK Analyzer

### For OpenSearch 2.19.3

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

### For OpenSearch 3.3.1

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
    version: 3.3.0  # Dashboards 3.3.0 is the latest release compatible with OpenSearch 3.3.1
    replicas: 1
    resources:
      requests:
        memory: "512Mi"
        cpu: "200m"
      limits:
        memory: "512Mi"
        cpu: "200m"
```

Apply the configuration:

```bash
kubectl apply -f cluster.yaml
```

## Verify the Plugin is Installed

After the cluster is running, verify the IK plugin is installed on a node:

```bash
kubectl -n <namespace> exec my-cluster-masters-0 -- bin/opensearch-plugin list
```

The output should include `analysis-ik`.

## Test IK Analyzer

Port-forward the OpenSearch service and run a quick tokenization test:

```bash
kubectl -n <namespace> port-forward svc/my-cluster 9200
```

**Test `ik_max_word` tokenizer** (maximum granularity, splits text into all possible tokens):

```bash
# The operator generates a self-signed cert; -k skips local certificate validation
curl -k -u admin:admin -X POST "https://localhost:9200/_analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "analyzer": "ik_max_word",
    "text": "中华人民共和国"
  }'
```

Expected output:

```json
{
  "tokens": [
    { "token": "中华人民共和国", "start_offset": 0, "end_offset": 7, "type": "CN_WORD", "position": 0 },
    { "token": "中华人民",     "start_offset": 0, "end_offset": 4, "type": "CN_WORD", "position": 1 },
    { "token": "中华",         "start_offset": 0, "end_offset": 2, "type": "CN_WORD", "position": 2 },
    { "token": "华人",         "start_offset": 1, "end_offset": 3, "type": "CN_WORD", "position": 3 },
    { "token": "人民共和国",   "start_offset": 2, "end_offset": 7, "type": "CN_WORD", "position": 4 },
    { "token": "人民",         "start_offset": 2, "end_offset": 4, "type": "CN_WORD", "position": 5 },
    { "token": "共和国",       "start_offset": 4, "end_offset": 7, "type": "CN_WORD", "position": 6 },
    { "token": "共和",         "start_offset": 4, "end_offset": 6, "type": "CN_WORD", "position": 7 },
    { "token": "国",           "start_offset": 6, "end_offset": 7, "type": "CN_WORD", "position": 8 }
  ]
}
```

**Test `ik_smart` tokenizer** (coarse-grained, splits into the fewest tokens):

```bash
# The operator generates a self-signed cert; -k skips local certificate validation
curl -k -u admin:admin -X POST "https://localhost:9200/_analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "analyzer": "ik_smart",
    "text": "中华人民共和国"
  }'
```

Expected output:

```json
{
  "tokens": [
    { "token": "中华人民共和国", "start_offset": 0, "end_offset": 7, "type": "CN_WORD", "position": 0 }
  ]
}
```

## Use IK Analyzer in an Index Mapping

When creating an index, specify `ik_max_word` or `ik_smart` as the analyzer for Chinese text fields:

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
Using `ik_max_word` for indexing and `ik_smart` for search is a common pattern: it maximizes recall at index time while keeping search queries precise.
:::

## (Optional) Mount a Custom Dictionary

The IK Analyzer supports custom word dictionaries and stop-word lists via `IKAnalyzer.cfg.xml`. To mount a custom dictionary into the cluster, use `additionalVolumes` with a ConfigMap.

### Step 1: Create the ConfigMap

Prepare your custom dictionary files and create a ConfigMap. The following example adds a custom word list:

```bash
# custom_dict.dic — one word per line
cat > custom_dict.dic << 'EOF'
云原生
容器编排
服务网格
EOF

# IKAnalyzer.cfg.xml — reference the custom dictionary
cat > IKAnalyzer.cfg.xml << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">
<properties>
  <comment>IK Analyzer Extended Configuration</comment>
  <!-- Custom extended dictionary; separate multiple files with ; -->
  <entry key="ext_dict">custom_dict.dic</entry>
  <!-- Custom stop-word dictionary; separate multiple files with ; -->
  <entry key="ext_stopwords"></entry>
</properties>
EOF

kubectl -n <namespace> create configmap ik-custom-dict \
  --from-file=custom_dict.dic \
  --from-file=IKAnalyzer.cfg.xml
```

### Step 2: Mount the ConfigMap via additionalVolumes

Add the `additionalVolumes` section to `spec.general` in your `OpenSearchCluster` CR:

```yaml
spec:
  general:
    pluginsList:
      - "https://release.infinilabs.com/analysis-ik/stable/opensearch-analysis-ik-2.19.3.zip"
    additionalVolumes:
      - name: ik-custom-dict
        path: /usr/share/opensearch/plugins/analysis-ik/config
        restartPods: true  # Restart pods when ConfigMap content changes
        configMap:
          name: ik-custom-dict
```

After applying, pods will restart and pick up the new dictionary. Verify by running an `_analyze` request with your custom terms.

## References

- [opensearch-operator: Adding Plugins](https://github.com/opensearch-project/opensearch-k8s-operator/blob/v2.8.0/docs/userguide/main.md#adding-plugins)
- [opensearch-operator: Additional Volumes](https://github.com/opensearch-project/opensearch-k8s-operator/blob/v2.8.0/docs/userguide/main.md#additional-volumes)
- [IK Analyzer for OpenSearch (Infinilabs)](https://github.com/infinilabs/analysis-ik)
