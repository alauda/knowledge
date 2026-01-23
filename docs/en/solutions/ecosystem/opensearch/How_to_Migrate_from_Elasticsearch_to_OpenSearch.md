---
products:
  - Alauda Container Platform
kind:
  - Solution
---

# How to Migrate from Elasticsearch to OpenSearch

:::info
Applicable Version: OpenSearch Operator ~= 2.8.*, OpenSearch ~= 2.x / 3.x
:::

This document provides detailed guidance for migrating from Elasticsearch (ES) to OpenSearch.

## Migration Strategy Overview

| Source Version | Target Version | Migration Method | Notes |
| :--- | :--- | :--- | :--- |
| **ES 7.10** | **OS 2.x** | Snapshot & Restore | ✅ Direct restore supported |
| **ES 7.10** | **OS 3.x** | Snapshot & Restore → Upgrade | ⚠️ Must restore to OS 2.x first, then upgrade |
| **ES 8.x** | **OS 3.x** | Reindex from Remote | ✅ Direct migration supported |

:::warning Key Compatibility Note

- **ES 7.10 → OS 3.x direct restore is NOT supported**. OpenSearch 3.x requires indices to be created with OpenSearch 2.0.0+.
- ES 7.10 snapshots must be restored to OpenSearch 2.x first, then upgrade the cluster to OS 3.x.
- ES 8.x uses incompatible Lucene versions, so Snapshot & Restore is not available; use Reindex from Remote instead.

:::

## Migrate from ES 7.10 to OpenSearch 2.x to 3.x

This migration requires a **two-phase approach**:

1. **Phase 1**: Restore ES 7.10 snapshot to OpenSearch 2.x
2. **Phase 2**: Upgrade OpenSearch 2.x to 3.x

### Prerequisites

- A shared storage backend (e.g., S3 Bucket, GCS Bucket) accessible by both source and target clusters.
- The `repository-s3` plugin (or corresponding storage backend plugin) installed on both clusters.

#### Check if Plugin is Installed

```bash
curl -u "elastic:<password>" "http://localhost:9200/_cat/plugins?v"
```

#### Install repository-s3 Plugin

Plugin download URLs:

| Version | Download URL |
| :--- | :--- |
| ES 7.10.2 | `https://artifacts.elastic.co/downloads/elasticsearch-plugins/repository-s3/repository-s3-7.10.2.zip` |
| OpenSearch 2.19.3 | `https://artifacts.opensearch.org/releases/plugins/repository-s3/2.19.3/repository-s3-2.19.3.zip` |
| OpenSearch 3.3.1 | `https://artifacts.opensearch.org/releases/plugins/repository-s3/3.3.1/repository-s3-3.3.1.zip` |

:::note
The plugin version **must exactly match** the Elasticsearch/OpenSearch version. For example, OpenSearch 3.3.1 requires `repository-s3-3.3.1.zip`.
:::

:::warning Air-Gapped Environments

If your Kubernetes cluster does not have external network access, download the plugin zip files first and host them on an internal HTTP server (e.g., Nexus, Artifactory, or Nginx). Then replace the download URLs in the configurations below with your internal accessible URLs.

:::

**ES 7.10 (Helm Chart):**

In **Application Container Platform** > **Applications** > **Applications** page:

- Find the elasticsearch instance
- Click **Update**
- Switch to **YAML** edit page

Update `values.yaml` on the **Custom** input textarea with below content:

```yaml
masterNodes:
  config:
    elasticsearch.yml: |
      s3.client.default.endpoint: "http://minio.example.com:9000"
      s3.client.default.region: "us-east-1"
      s3.client.default.path_style_access: true  # Required for MinIO

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
The above configuration only sets S3 configs for master nodes. If you have dedicated data nodes, add the same S3 config to `dataNodes` as well.
:::

**OpenSearch:**

In your `OpenSearchCluster` CR:

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

:::note
All three approaches will trigger a rolling restart of nodes to load the newly installed plugin.
:::

### Procedure

#### Step 1: Configure S3 Credentials

For security reasons, avoid including access keys directly in API request bodies. Use the keystore instead.

**On Elasticsearch 7.10:**

1. Add S3 credentials to keystore (secure settings):

    ```bash
    bin/elasticsearch-keystore add s3.client.default.access_key
    bin/elasticsearch-keystore add s3.client.default.secret_key
    ```

    Or use non-interactive mode:

    ```bash
    echo "YOUR_ACCESS_KEY" | bin/elasticsearch-keystore add --stdin s3.client.default.access_key
    echo "YOUR_SECRET_KEY" | bin/elasticsearch-keystore add --stdin s3.client.default.secret_key
    ```

2. Reload the secure settings:

    ```bash
    curl -u "elastic:<password>" -X POST "http://localhost:9200/_nodes/reload_secure_settings"
    ```

**On OpenSearch:**

Use the Operator's declarative configuration:

1. Create a Secret containing the credentials and endpoint:

    ```yaml
    apiVersion: v1
    kind: Secret
    metadata:
      name: s3-secret
    stringData:
      s3.client.default.access_key: "YOUR_ACCESS_KEY"
      s3.client.default.secret_key: "YOUR_SECRET_KEY"
    ```

    :::note S3 Endpoint Configuration

    - For AWS S3: Omit the `endpoint` field, or set it to `s3.amazonaws.com`
    - For S3-compatible services (MinIO, Ceph, etc.): Set the endpoint to your server address
    - For path-style access: Add `s3.client.default.path_style_access: "true"` (required for MinIO)

    :::

2. Reference the Secret in the `OpenSearchCluster` CR:

    ```yaml
    spec:
      general:
        keystore:
          - secret:
              name: s3-secret
    ```

    > The Operator will automatically mount the secret and reload the secure settings.

#### Step 2: Register Snapshot Repository on Source Cluster (ES 7.10)

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

#### Step 3: Create a Full Snapshot

```bash
curl -u "elastic:<password>" -X PUT "http://localhost:9200/_snapshot/migration_repo/snapshot_1?wait_for_completion=true" \
  -H 'Content-Type: application/json' -d'
{
  "indices": "*",
  "ignore_unavailable": true,
  "include_global_state": true
}'
```

### Phase 1: Restore to OpenSearch 2.x

#### Step 4: Deploy OpenSearch 2.x Cluster

Deploy a new OpenSearch **2.x** cluster using the OpenSearch Operator:

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

#### Step 5: Restore the Snapshot

Exclude system indices to avoid conflicts with OpenSearch's internal indices:

```bash
curl -k -u "admin:admin" -X POST "https://localhost:9200/_snapshot/migration_repo/snapshot_1/_restore" \
  -H 'Content-Type: application/json' -d'
{
  "indices": "-.kibana*,-.security*,-.monitoring*",
  "include_global_state": false
}'
```

#### Step 6: Verification

Verify the index count and document count match the source cluster:

```bash
# Check indices
curl -k -u "admin:admin" "https://localhost:9200/_cat/indices?v"

# Check document count
curl -k -u "admin:admin" "https://localhost:9200/<index_name>/_count"
```

### Phase 2: Reindex and Upgrade to OpenSearch 3.x

:::warning Critical Step
Indices restored from ES 7.10 snapshots retain their original version metadata (`7.10.2`). OpenSearch 3.x requires indices to have version `2.0.0+`. You **MUST reindex** all restored indices within OpenSearch 2.x before upgrading.
:::

#### Step 7: Reindex All Restored Indices

For each restored index, create a new index and reindex the data:

```bash
# 1. Get the original index mapping and extract the mappings object using sed

curl -s -k -u "admin:admin" "https://localhost:9200/migration_test/_mapping" | \
  sed 's/^{"migration_test"://' | sed 's/}$//' > mapping.json

# 2. Create a new index with the same mapping (add suffix _v2)

curl -k -u "admin:admin" -X PUT "https://localhost:9200/migration_test_v2" \
  -H 'Content-Type: application/json' \
  -d @mapping.json

# 3. Reindex data from old index to new index

curl -k -u "admin:admin" -X POST "https://localhost:9200/_reindex?wait_for_completion=true" \
  -H 'Content-Type: application/json' -d'
{
  "source": { "index": "migration_test" },
  "dest": { "index": "migration_test_v2" }
}'

# 4. Delete old index and create alias (or rename)
curl -k -u "admin:admin" -X DELETE "https://localhost:9200/migration_test"
curl -k -u "admin:admin" -X POST "https://localhost:9200/_aliases" \
  -H 'Content-Type: application/json' -d'
{
  "actions": [
    { "add": { "index": "migration_test_v2", "alias": "migration_test" } }
  ]
}'
```

Repeat for all restored indices. After reindexing, verify the new index version:

```bash
curl -k -u "admin:admin" "https://localhost:9200/migration_test_v2/_settings?filter_path=**.version"
```

The `version.created` should show an OpenSearch 2.x internal version number (e.g., `136408127` for OS 2.19.x). ES 7.10.2 indices show `7102099`. If you see a number starting with `136` or higher, the reindex was successful.

#### Step 8: Upgrade OpenSearch Cluster

Update the `OpenSearchCluster` CR to upgrade the version:

```yaml
spec:
  general:
    version: 3.3.1  # Upgrade to OpenSearch 3.x
    pluginsList:
    - https://artifacts.opensearch.org/releases/plugins/repository-s3/3.3.1/repository-s3-3.3.1.zip
```

The Operator will perform a rolling upgrade automatically.

#### Step 9: Post-Upgrade Verification

Verify all indices are accessible after upgrade:

```bash
curl -k -u "admin:admin" "https://localhost:9200/_cat/indices?v"
curl -k -u "admin:admin" "https://localhost:9200/_cluster/health?pretty"
```

## Migrate from ES 8.x/9.x to OpenSearch 3.x

Elasticsearch 8.x uses a newer Lucene version with incompatible metadata protocols, making snapshots unreadable by OpenSearch. Use **Reindex from Remote** instead.

### Prerequisites

- **Network Connectivity**: The OpenSearch cluster must be able to reach the ES 8.x cluster's HTTP/REST port (typically 9200).

### Deploy ES 8.x Using ECK Operator

Deploy an Elasticsearch 8.x cluster using ECK Operator:

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

### Procedure

#### Step 1: Configure OpenSearch for Remote Reindex

Add the following configurations to `OpenSearchCluster` CR's `additionalConfig`:

```yaml
spec:
  general:
    additionalConfig:
      # Allow connections to ES 8.x host (OpenSearch 3.x uses 'allowlist')
      reindex.remote.allowlist: "es8-cluster-host:9200"
      # Disable SSL verification for self-signed certificates
      reindex.ssl.verification_mode: "none"
```

> **Note**: Nodes will be restarted after applying this configuration change.

#### Step 2: Create Index Templates (Optional but Recommended)

If your ES 8.x indices rely on specific settings or mappings, it is recommended to manually create the corresponding Index Templates or Mappings in OpenSearch beforehand.

#### Step 3: Execute Reindex

Initiate the reindex request from the OpenSearch cluster. Set `wait_for_completion=false` to run asynchronously.

```bash
curl -k -u "admin:admin" -X POST "https://localhost:9200/_reindex?wait_for_completion=false" -H 'Content-Type: application/json' -d'
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

**Example Response:**

```json
{
  "task": "N6q0j8s-T0m0j8s-T0m0j8:123456"
}
```

#### Step 4: Monitor Reindex Progress

Use the Task ID from the previous step to check the task status:

```bash
curl -k -u "admin:admin" "https://localhost:9200/_tasks/N6q0j8s-T0m0j8s-T0m0j8:123456"
```

#### Step 5: Verify Reindex Completion

Verify that the index was created and contains data:

```bash
# Check if index exists and document count
curl -k -u "admin:admin" "https://localhost:9200/migration_test/_count"

# Compare with source ES 8.x cluster
curl -k -u "elastic:<password>" "https://es8-cluster-host:9200/migration_test/_count"
```

## Client Migration Guide

Regardless of the source ES version, **it is strongly recommended to switch to the official OpenSearch clients**.

:::warning Compatibility Note

- Elasticsearch OSS 7.10.2 clients may work with OpenSearch 1.x, but latest ES clients include license/version checks that break compatibility.
- **For OpenSearch 2.0 and later, no Elasticsearch clients are fully compatible with OpenSearch.**
- Using OpenSearch clients for OpenSearch clusters is strongly recommended.
:::

### OpenSearch Official Clients

| Language | Client | Documentation |
| :--- | :--- | :--- |
| **Python** | opensearch-py | [High-level](https://docs.opensearch.org/latest/clients/python-high-level/), [Low-level](https://docs.opensearch.org/latest/clients/python-low-level/) |
| **Java** | opensearch-java | [Java Client](https://docs.opensearch.org/latest/clients/java/) |
| **JavaScript** | @opensearch-project/opensearch | [Node.js Client](https://docs.opensearch.org/latest/clients/javascript/index) |
| **Go** | opensearch-go | [Go Client](https://docs.opensearch.org/latest/clients/go/) |
| **Ruby** | opensearch-ruby | [Ruby Client](https://docs.opensearch.org/latest/clients/ruby/) |
| **PHP** | opensearch-php | [PHP Client](https://docs.opensearch.org/latest/clients/php/) |
| **.NET** | OpenSearch.Client | [.NET Clients](https://docs.opensearch.org/latest/clients/dot-net/) |
| **Rust** | opensearch-rs | [Rust Client](https://docs.opensearch.org/latest/clients/rust/) |
| **Hadoop** | opensearch-hadoop | [GitHub](https://github.com/opensearch-project/opensearch-hadoop) |

For detailed migration instructions, refer to the [OpenSearch Clients Documentation](https://docs.opensearch.org/latest/clients/).

## References

- [OpenSearch Migration Guide](https://docs.opensearch.org/latest/upgrade-or-migrate/)
- [Snapshot and Restore](https://docs.opensearch.org/latest/tuning-your-cluster/availability-and-recovery/snapshots/snapshot-restore/)
- [Reindex API](https://docs.opensearch.org/latest/api-reference/document-apis/reindex/)
- [Keystore Management](https://docs.opensearch.org/latest/security/configuration/opensearch-keystore/)
