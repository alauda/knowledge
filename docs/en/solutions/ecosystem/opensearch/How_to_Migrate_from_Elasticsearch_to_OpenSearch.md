---
products:
  - Alauda Application Services
kind:
  - Solution
id: KB260100026
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

This guide uses ES 7.10 as the source for the Snapshot & Restore method, and ES 8.17 for the Reindex from Remote method. Adjust accordingly if your source version differs.


## Migrate from ES 7.10 to OpenSearch 3.x (via 2.x)

This migration requires a **three-phase approach**:

* **Phase 0**: Create a snapshot on the source Elasticsearch 7.10 cluster
* **Phase 1**: Restore that snapshot to OpenSearch 2.x
* **Phase 2**: Reindex the restored indices, then upgrade OpenSearch 2.x to 3.x

### Prerequisites

- A shared storage backend (e.g., S3 Bucket, GCS Bucket) accessible by both source and target clusters.
- The `repository-s3` plugin (or corresponding storage backend plugin) installed on both clusters.

#### Check if Plugin is Installed

Run the check on both clusters:

```bash
# On an Elasticsearch pod
curl -u "elastic:<password>" "http://localhost:9200/_cat/plugins?v"

# On an OpenSearch pod
curl -k -u "admin:<password>" "https://localhost:9200/_cat/plugins?v"
```

:::info
Remember to replace `<password>` with your cluster's credentials, here and in every command that follows.

- For Elasticsearch, the default user is `elastic`, and the password is randomly generated during creation.
- For OpenSearch, the default user is `admin`, and the password is stored in the `<cluster-name>-admin-password` Secret. See [How to Set and Update the OpenSearch Admin Password](./How_to_update_opensearch_admin_password.md) for details.
:::

#### Install repository-s3 Plugin

First, read the exact version each cluster runs — you need it to build the download URL:

```bash
# On an Elasticsearch pod
curl -s -u "elastic:<password>" "http://localhost:9200" | grep '"number"'

# On an OpenSearch pod
curl -sk -u "admin:<password>" "https://localhost:9200" | grep '"number"'
```

Then substitute that version into the matching URL pattern:

| Product | Download URL pattern |
| :--- | :--- |
| Elasticsearch | `https://artifacts.elastic.co/downloads/elasticsearch-plugins/repository-s3/repository-s3-<VERSION>.zip` |
| OpenSearch | `https://artifacts.opensearch.org/releases/plugins/repository-s3/<VERSION>/repository-s3-<VERSION>.zip` |

:::warning Version must match exactly
`elasticsearch-plugin install` / `opensearch-plugin install` reads the version recorded in the plugin package and **refuses to install it on a node running any other version** — including a different patch release. A mismatch leaves the node unable to start.

The examples in this document use `7.10.2` for Elasticsearch and `2.19.3` / `3.3.1` for OpenSearch. These are examples only: **replace every occurrence with the versions your own clusters actually run.**
:::

:::warning Air-Gapped Environments

If your Kubernetes cluster does not have external network access, download the plugin zip files first and host them on an internal HTTP server (e.g., Nexus, Artifactory, or Nginx). Then replace the download URLs in the configurations below with your internal accessible URLs.

:::

**ES 7.10 (Helm Chart):**

In **Application Container Platform** > **Applications** > **Applications** page:

- Find the elasticsearch instance
- Click **Update**
- Switch to **YAML** edit page

Update `values.yaml` on the **Custom** input textarea with the following content:

```yaml
masterNodes:
  config:
    elasticsearch.yml: |
      s3.client.default.endpoint: "http://minio.example.com:9000"
      s3.client.default.region: "us-east-1"
      s3.client.default.path_style_access: true  # Required for MinIO

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
- The init container must use the **same Elasticsearch image your nodes already run**. The image above is an example.
- Mounting an `emptyDir` at `/usr/share/elasticsearch/plugins` hides anything already installed in that directory, so the init container must install every plugin the cluster needs, not just `repository-s3`.
- The above configuration only sets S3 configs for master nodes. If you have dedicated data nodes, add the same S3 config to `dataNodes` as well.
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

:::warning Every change to `additionalConfig` or `pluginsList` restarts the whole cluster

- Both approaches trigger a **rolling restart of every node**, one at a time, to load the new configuration or plugin.
- Values under `additionalConfig` are written straight into `opensearch.yml` and are **not validated by the Operator**. An unknown or misspelled setting is only rejected when the node boots, and the node then fails to start — see [Troubleshooting](#troubleshooting).
- Because nodes are restarted one at a time, verify that the first restarted node returns to `Running` and `Ready` before letting the rollout continue. If it does not, fix the configuration before the remaining nodes pick it up.
- Plugins in `pluginsList` are downloaded and installed **on every pod start**, not once. The URL must stay reachable from every node, or use an image with the plugin pre-installed.
:::

### Phase 0: Create the Snapshot on Elasticsearch 7.10

#### Step 1: Configure S3 Credentials

For security reasons, avoid including access keys directly in API request bodies. Use the keystore instead.

**On Elasticsearch 7.10 Pod:**

1. Add S3 credentials to keystore (secure settings):

    ```bash
    bin/elasticsearch-keystore add s3.client.default.access_key
    bin/elasticsearch-keystore add s3.client.default.secret_key
    ```

    Or use non-interactive mode:

    ```bash
    echo "<YOUR_ACCESS_KEY>" | bin/elasticsearch-keystore add --stdin s3.client.default.access_key
    echo "<YOUR_SECRET_KEY>" | bin/elasticsearch-keystore add --stdin s3.client.default.secret_key
    ```

2. Reload the secure settings:

    ```bash
    curl -u "elastic:<password>" -X POST "http://localhost:9200/_nodes/reload_secure_settings"
    ```

    :::warning Repeat on every Elasticsearch pod
    The keystore is a file inside each node's own config directory, and `reload_secure_settings` only reloads what is already present on each node. **Run step 1 on every Elasticsearch pod** (masters and data nodes) before calling the reload, otherwise snapshots fail on whichever nodes lack the credentials.

    The keystore also lives in the container filesystem: unless your chart persists the Elasticsearch config directory, the credentials are lost when a pod restarts and must be added again.
    :::

**On OpenSearch:**

Use the Operator's declarative configuration:

1. Create a Secret containing the credentials and endpoint:

    ```yaml
    apiVersion: v1
    kind: Secret
    metadata:
      name: s3-secret
    stringData:
      s3.client.default.access_key: "<YOUR_ACCESS_KEY>"
      s3.client.default.secret_key: "<YOUR_SECRET_KEY>"
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

#### Step 3: Create a Full Snapshot on Source Cluster (ES 7.10)

```bash
curl -u "elastic:<password>" -X PUT "http://localhost:9200/_snapshot/migration_repo/snapshot_1?wait_for_completion=true" \
  -H 'Content-Type: application/json' -d'
{
  "indices": "*,-.kibana*,-.security*,-.monitoring*,-apm*,-.apm*",
  "ignore_unavailable": true,
  "include_global_state": true
}'
```

:::note Excluding System Indices
The `indices` pattern above excludes system indices (`.kibana*`, `.security*`, `.monitoring*`, `apm*`, `.apm*`). These indices are Elasticsearch-specific and would conflict with OpenSearch's internal indices during restore. Excluding them at snapshot time also reduces the snapshot size.

Because these indices are not migrated, the objects they hold do not come across either: Kibana saved objects (index patterns, visualizations, dashboards) and Elasticsearch users, roles and role mappings must be recreated on the OpenSearch side.
:::

### Phase 1: Restore to OpenSearch 2.x

#### Step 1: Deploy OpenSearch 2.x Cluster

Deploy a new OpenSearch **2.x** cluster using the OpenSearch Operator. For the full deployment procedure, see the [OpenSearch Installation Guide](./OpenSearch_Installation_Guide.md); the fragment below shows only the fields this migration needs.

:::note
Set `version` to an OpenSearch version that is available in your environment. On a cluster without external network access, only the OpenSearch versions included in the installed plugin package can be pulled — check which ones are available before you deploy, and use that version in the `pluginsList` URL as well.
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

#### Step 2: Restore the Snapshot on OpenSearch

Exclude system indices to avoid conflicts with OpenSearch's internal indices:

```bash
curl -k -u "admin:<password>" -X POST "https://localhost:9200/_snapshot/migration_repo/snapshot_1/_restore" \
  -H 'Content-Type: application/json' -d'
{
  "indices": "-.kibana*,-.security*,-.monitoring*,-apm*,-.apm*",
  "include_global_state": false
}'
```

:::note
- A restore fails if an index of the same name already exists and is open. Delete or close the target index first, or use `rename_pattern` / `rename_replacement` to restore under a different name.
- Restored indices keep the replica count of the source cluster. If the target cluster has fewer nodes, add `"index_settings": {"index.number_of_replicas": 1}` to the request body, otherwise the restored indices stay yellow.
- `include_global_state` is `false`, so index templates, legacy templates and ingest pipelines are **not** restored. Recreate the ones you need on OpenSearch. Index Lifecycle Management (ILM) policies have no direct equivalent and must be rebuilt as Index State Management (ISM) policies.
:::

#### Step 3: Verification

Verify the index count and document count match the source cluster:

```bash
# Check indices on OpenSearch pod
curl -k -u "admin:<password>" "https://localhost:9200/_cat/indices?v"

# Check document count on OpenSearch pod
curl -k -u "admin:<password>" "https://localhost:9200/<index_name>/_count"
```

### Phase 2: Reindex and Upgrade to OpenSearch 3.x

:::warning Critical Step
Indices restored from ES 7.10 snapshots retain their original version metadata (`7.10.2`). OpenSearch 3.x requires indices to have version `2.0.0+`. You **MUST reindex** all restored indices within OpenSearch 2.x before upgrading.
:::

#### Step 1: Reindex All Restored Indices on the Restored OpenSearch

For each restored index, create a new index and reindex the data:

:::note
- The examples below use `migration_test` as the index name. Replace `migration_test` with your actual index name when executing these commands.
- The commands require `jq`. If it is not available in the OpenSearch container, run them from a workstation that can reach the cluster.
- Copying the index **settings** matters: shard counts, custom analyzers and similar settings live there, not in the mappings. If an index uses a custom analyzer, the corresponding analysis plugin must also be installed on the target cluster before the new index can be created.
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

# 3. Reindex data from old index to new index

curl -k -u "admin:<password>" -X POST "https://localhost:9200/_reindex?wait_for_completion=true" \
  -H 'Content-Type: application/json' -d'
{
  "source": { "index": "migration_test" },
  "dest": { "index": "migration_test_v2" }
}'

# 4. Delete old index and create alias (or rename)
curl -k -u "admin:<password>" -X DELETE "https://localhost:9200/migration_test"
curl -k -u "admin:<password>" -X POST "https://localhost:9200/_aliases" \
  -H 'Content-Type: application/json' -d'
{
  "actions": [
    { "add": { "index": "migration_test_v2", "alias": "migration_test" } }
  ]
}'
```

Repeat for all restored indices. After reindexing, verify the new index version:

```bash
curl -k -u "admin:<password>" "https://localhost:9200/migration_test_v2/_settings?filter_path=**.version"
```

The `version.created` should show an OpenSearch 2.x internal version number (for example `136408127` for OS 2.19.x), rather than the `7102099` that ES 7.10.2 indices carry. Any `136xxxxxx` value means the index was created by OpenSearch 2.x and the reindex was successful.

#### Step 2: Upgrade OpenSearch Cluster

:::warning
Take a snapshot of the OpenSearch 2.x cluster before starting the upgrade. A major version upgrade cannot be rolled back in place.
:::

Update the `OpenSearchCluster` CR to upgrade the version. Use the same version for OpenSearch and OpenSearch Dashboards:

```yaml
spec:
  general:
    version: 3.3.1  # Upgrade to OpenSearch 3.x
    pluginsList:
    - https://artifacts.opensearch.org/releases/plugins/repository-s3/3.3.1/repository-s3-3.3.1.zip
  dashboards:
    version: 3.3.1  # Upgrade OpenSearch Dashboards to the matching version
```

The Operator will perform a rolling upgrade automatically.

#### Step 3: Post-Upgrade Verification

Verify all indices are accessible after upgrade:

```bash
curl -k -u "admin:<password>" "https://localhost:9200/_cat/indices?v"
curl -k -u "admin:<password>" "https://localhost:9200/_cluster/health?pretty"
```

## Migrate from ES 8.x to OpenSearch 3.x

Elasticsearch 8.x uses a newer Lucene version with incompatible metadata protocols, making snapshots unreadable by OpenSearch. Use **Reindex from Remote** instead.

### Prerequisites

- **Network Connectivity**: The OpenSearch cluster must be able to reach the ES 8.x cluster's HTTP/REST port (typically 9200).

### Deploy ES 8.x Using ECK Operator

Deploy an Elasticsearch 8.17 cluster using ECK Operator:

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

:::note TLS Configuration
If you disable TLS by setting:

```yaml
spec:
  http:
    tls:
      selfSignedCertificate:
        disabled: true
```

You must use `http://` instead of `https://` when accessing the Elasticsearch API.
:::

### Procedure

#### Step 1: Configure OpenSearch for Remote Reindex

Add the following configurations to `OpenSearchCluster` CR's `additionalConfig`:

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

:::warning It is `allowlist`, not `whitelist`

Elasticsearch, and OpenSearch 1.x, used `reindex.remote.whitelist`. OpenSearch renamed the setting to `reindex.remote.allowlist` and kept the old name as a deprecated alias in 2.x. **OpenSearch 3.x removed the old name entirely**, so a configuration copied from Elasticsearch documentation makes every node fail at startup with:

```text
SettingsException[unknown setting [reindex.remote.whitelist] ...]
```

Applying this change restarts the nodes one at a time. Confirm the first restarted node returns to `Running` and `Ready` before the rollout continues — see [Troubleshooting](#troubleshooting).
:::

#### Step 2: Create Index Templates on OpenSearch (Optional but Recommended)

If your ES 8.x indices rely on specific settings or mappings, it is recommended to manually create the corresponding Index Templates or Mappings in OpenSearch beforehand.

#### Step 3: Execute Reindex on OpenSearch

Initiate the reindex request from the OpenSearch cluster. Set `wait_for_completion=false` to run asynchronously.

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

**Example Response:**

```json
{
  "task": "N6q0j8s-T0m0j8s-T0m0j8:123456"
}
```

#### Step 4: Monitor Reindex Progress

Use the Task ID from the previous step to check the task status:

```bash
curl -k -u "admin:<password>" "https://localhost:9200/_tasks/N6q0j8s-T0m0j8s-T0m0j8:123456"
```

#### Step 5: Verify Reindex Completion

Verify that the index was created and contains data:

```bash
# Check if index exists and document count (run on OpenSearch pod)
curl -k -u "admin:<password>" "https://localhost:9200/migration_test/_count"

# Compare with source ES 8.x cluster (run on ES 8.x pod)
curl -k -u "elastic:<password>" "https://es8-cluster-host:9200/migration_test/_count"
```

## Troubleshooting

### A node stays in CrashLoopBackOff after a configuration change

Values placed under `spec.general.additionalConfig` are written directly into `opensearch.yml` and are not validated by the Operator. An unknown or misspelled setting is rejected when the node boots, and the node never starts:

```text
[ERROR][o.o.b.OpenSearchUncaughtExceptionHandler] uncaught exception in thread [main]
org.opensearch.bootstrap.StartupException: SettingsException[unknown setting [reindex.remote.whitelist]
  please check that any required plugins are installed, or check the breaking changes documentation
  for removed settings]
```

The Operator restarts nodes one at a time and waits for each one to become ready, so the rollout stops at the first node that fails. The remaining nodes keep running the previous configuration, which is why the cluster can still be serving traffic while one pod restarts in a loop.

To recover:

```bash
# 1. Identify the failing node and the rejected setting
kubectl get pods -n <namespace>
kubectl logs -n <namespace> <cluster-name>-masters-0 --tail=50

# 2. Correct the setting in the cluster resource
kubectl edit opensearchcluster -n <namespace> <cluster-name>

# 3. Confirm the Operator has regenerated the configuration
kubectl get cm -n <namespace> -o yaml | grep -n '<setting-name>'

# 4. Restart the failing pod so it picks up the new configuration
kubectl delete pod -n <namespace> <cluster-name>-masters-0

# 5. Watch the rollout continue to the remaining nodes
kubectl get pods -n <namespace> -w
```

:::note
Settings are validated one at a time, so the node reports only the first invalid setting it finds. If it fails again after your fix, repeat the procedure for the next reported setting.
:::

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
