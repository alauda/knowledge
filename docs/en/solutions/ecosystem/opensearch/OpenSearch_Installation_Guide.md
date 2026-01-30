---
products:
  - Alauda Application Services
kind:
  - Solution
---

# OpenSearch Installation Guide

## Overview

OpenSearch is a community-driven, open-source search and analytics suite derived from Elasticsearch and Kibana. This guide covers deploying the OpenSearch Kubernetes Operator and creating OpenSearch cluster instances on the Alauda Container Platform.

### Supported Versions

| Component | Supported Versions |
|-----------|-------------------|
| OpenSearch | 2.19.3, 3.3.1 |
| OpenSearch Dashboards | 2.19.3, 3.3.0 |
| OpenSearch Operator | 2.8.0 |

## Prerequisites

- StorageClass that supports dynamic provisioning (for persistent volumes)
- ACP cluster with minimum 3 nodes for production deployments (to maintain cluster manager quorum)
- (Optional) LoadBalancer or Ingress Controller for external access

## Install OpenSearch Operator

1. Download the **OpenSearch Operator** plugin from [Alauda Cloud Console](https://cloud.alauda.io/) Marketplace.
2. Follow the [Upload Packages](https://docs.alauda.io/container_platform/4.2/extend/upload_package.html) guide to upload the plugin to the cluster.
3. Navigate to Administrator -> Marketplace -> OperatorHub.
4. Locate **OpenSearch Cluster** and click Install.

## Quick Start: Create an OpenSearch Instance

This section demonstrates how to quickly deploy an OpenSearch cluster with OpenSearch Dashboards.

### Basic Cluster Configuration

Deploy a simple 3-node OpenSearch cluster:

```yaml
apiVersion: opensearch.opster.io/v1
kind: OpenSearchCluster
metadata:
  name: my-opensearch
  namespace: opensearch-demo
spec:
  general:
    serviceName: my-opensearch
    version: 3.3.1
    httpPort: 9200
  security:
    tls:
      transport:
        generate: true
        perNode: true
      http:
        generate: true
  dashboards:
    enable: true
    version: 3.3.0
    replicas: 1
    resources:
      requests:
        memory: "512Mi"
        cpu: "200m"
      limits:
        memory: "512Mi"
        cpu: "200m"
  nodePools:
    - component: nodes
      replicas: 3
      diskSize: "3Gi"
      persistence:
        pvc:
          accessModes:
          - ReadWriteOnce
          storageClass: sc-topolvm
      resources:
        requests:
          memory: "2Gi"
          cpu: "500m"
        limits:
          memory: "2Gi"
          cpu: "500m"
      roles:
        - "cluster_manager"
        - "data"
```

> [!WARNING]
> Change the default password according to [How to Set and Update the OpenSearch Admin Password](./How_to_update_opensearch_admin_password.md) for production.

### Verify Deployment

Check the status of the OpenSearch cluster:

```bash
# Check pods
kubectl get pods -n opensearch-demo

# Check cluster health
kubectl exec -n opensearch-demo my-opensearch-nodes-0 -- curl -sk -u admin:<password> https://localhost:9200/_cluster/health?pretty
```

> The default password for the `admin` user is `admin`.

### Access OpenSearch Dashboards

1. Set up port forwarding:

   ```bash
    kubectl -n opensearch-demo port-forward service/my-opensearch-dashboards 5601:5601
   ```

2. Open [http://127.0.0.1:5601](http://127.0.0.1:5601) in your browser.

3. Login with credentials:
   - Username: `admin`
   - Password: `<password>`
   
   > The default password for the `admin` user is `admin`.


## Understanding Node Roles

OpenSearch supports multiple node roles (also called node types) that determine the functions each node performs in the cluster. Proper role assignment is critical for cluster performance and stability.

By default, each node is a cluster-manager-eligible, data, ingest, and coordinating node. Deciding on the number of nodes, assigning node types, and choosing the hardware for each node type depends on your use case. You must take into account factors like the amount of time you want to hold on to your data, the average size of your documents, your typical workload (indexing, searches, aggregations), your expected price-performance ratio, your risk tolerance, and so on.

### Available Node Types

The following table provides descriptions of the node types and best practices for production deployments:

| Node Type | Description | 
|-----------|-------------|
| **`cluster_manager`** | Manages the overall operation of a cluster and keeps track of the cluster state. This includes creating and deleting indexes, keeping track of the nodes that join and leave the cluster, checking the health of each node in the cluster (by running ping requests), and allocating shards to nodes. |
| **`data`** | Stores and searches data. Performs all data-related operations (indexing, searching, aggregating) on local shards. These are the worker nodes of your cluster and need more disk space than any other node type. |
| **`ingest`** | Pre-processes data before storing it in the cluster. Runs an ingest pipeline that transforms your data before adding it to an index. |
| **`coordinating`** | Delegates client requests to the shards on the data nodes, collects and aggregates the results into one final result, and sends this result back to the client. |
| **`dynamic`** | Delegates a specific node for custom work, such as machine learning (ML) tasks, preventing the consumption of resources from data nodes and therefore not affecting any OpenSearch functionality. |
| **`warm`** | Provides access to searchable snapshots. Incorporates techniques like frequently caching used segments and removing the least used data segments in order to access the searchable snapshot index (stored in a remote long-term storage source, for example, Amazon S3 or Google Cloud Storage). |
| **`search`** | Search nodes are dedicated nodes that host only search replica shards, helping separate search workloads from indexing workloads. |

> [!NOTE]
> By default, nodes with no explicit roles specified become coordinating-only nodes. To create a coordinating-only node, set the `roles` field to an empty array `[]`.

### Capacity Planning and Benchmarking

After you assess your requirements, we recommend you use a benchmark testing tool like [OpenSearch Benchmark](https://github.com/opensearch-project/opensearch-benchmark) to provision a small sample cluster and run tests with varying workloads and configurations. Compare and analyze the system and query metrics for these tests to design an optimum architecture.

### When to Use Each Role

#### Small Clusters (Development/Testing)

For small clusters with limited resources, combine roles on the same nodes:

```yaml
nodePools:
  - component: all-in-one
    replicas: 3
    diskSize: "30Gi"
    resources:
      requests:
        memory: "2Gi"
        cpu: "500m"
      limits:
        memory: "2Gi"
        cpu: "500m"
    roles:
      - "cluster_manager"
      - "data"
      - "ingest"
```

#### Medium Clusters (Production)

Separate cluster manager and data roles for better stability:

```yaml
nodePools:
  # Dedicated cluster manager nodes
  - component: masters
    replicas: 3
    diskSize: "10Gi"
    resources:
      requests:
        memory: "2Gi"
        cpu: "500m"
      limits:
        memory: "2Gi"
        cpu: "500m"
    roles:
      - "cluster_manager"
  
  # Dedicated data nodes
  - component: data
    replicas: 3
    diskSize: "100Gi"
    jvm: -Xmx4G -Xms4G
    resources:
      requests:
        memory: "8Gi"
        cpu: "2000m"
      limits:
        memory: "8Gi"
        cpu: "2000m"
    roles:
      - "data"
      - "ingest"
```

#### Large Clusters (High-Scale Production)

Full role separation for maximum performance and isolation:

```yaml
nodePools:
  # Dedicated cluster manager nodes
  - component: masters
    replicas: 3
    diskSize: "30Gi"
    resources:
      requests:
        memory: "4Gi"
        cpu: "1000m"
      limits:
        memory: "4Gi"
        cpu: "1000m"
    roles:
      - "cluster_manager"
  
  # Hot data nodes (frequent access, fast storage)
  - component: hot-data
    replicas: 5
    diskSize: "500Gi"
    jvm: -Xmx8G -Xms8G
    resources:
      requests:
        memory: "16Gi"
        cpu: "4000m"
      limits:
        memory: "16Gi"
        cpu: "4000m"
    roles:
      - "data"
      - "ingest"
  
  # Coordinating-only nodes (load balancing)
  - component: coordinators
    replicas: 2
    diskSize: "10Gi"
    resources:
      requests:
        memory: "4Gi"
        cpu: "2000m"
      limits:
        memory: "4Gi"
        cpu: "2000m"
    roles: []  # Empty roles = coordinating only
```

### Best Practices for Node Roles

| Guideline | Recommendation |
|-----------|----------------|
| Cluster Manager Count | Always use an **odd number** (3, 5, 7) to maintain quorum |
| Dedicated Cluster Managers | Recommended for clusters with >5 data nodes |
| Data Node Scaling | Scale horizontally based on data volume and query load |
| JVM Heap Size | Set to **half of container memory**, max 32GB |
| Coordinating Nodes | Use in large clusters to offload request routing from data nodes |

## Deploy in Restricted Namespaces (Pod Security Admission)

By default, the OpenSearch Operator creates init containers without security context restrictions to perform:

1. Set `vm.max_map_count` kernel parameter
2. Fix volume permissions via `chown`

When deploying OpenSearch in namespaces with restricted Pod Security Admission (PSA), additional configuration is required.

### Solution

#### Step 1: Pre-configure Kernel Parameters

Since the operator cannot set `vm.max_map_count`, configure it on all worker nodes:

```bash
# On each worker node
sysctl -w vm.max_map_count=262144

# Make it persistent
echo "vm.max_map_count=262144" >> /etc/sysctl.conf
```

#### Step 2: Create OpenSearch Cluster with Security Context

Deploy the cluster with proper security contexts:

```yaml
apiVersion: opensearch.opster.io/v1
kind: OpenSearchCluster
metadata:
  name: opensearch-restricted
  namespace: opensearch
spec:
  general:
    serviceName: opensearch-restricted
    version: 3.3.1
    httpPort: 9200
    
    # Disable init containers that require root
    setVMMaxMapCount: false
    
    # Pod-level security context
    podSecurityContext:
      runAsUser: 1000
      runAsGroup: 1000
      runAsNonRoot: true
      fsGroup: 1000
      seccompProfile:
        type: RuntimeDefault
    
    # Container-level security context
    securityContext:
      allowPrivilegeEscalation: false
      privileged: false
      runAsNonRoot: true
      runAsUser: 1000
      runAsGroup: 1000
      capabilities:
        drop:
          - ALL
      readOnlyRootFilesystem: false  # OpenSearch needs to write to certain paths
  
  security:
    tls:
      transport:
        generate: true
        perNode: true
      http:
        generate: true
  
  nodePools:
    - component: nodes
      replicas: 3
      diskSize: "30Gi"
      persistence:
        pvc:
          accessModes:
          - ReadWriteOnce
          storageClass: sc-topolvm
      resources:
        requests:
          memory: "2Gi"
          cpu: "500m"
        limits:
          memory: "2Gi"
          cpu: "500m"
      roles:
        - "cluster_manager"
        - "data"
  
  dashboards:
    enable: true
    version: 3.3.0
    replicas: 1
    
    # Dashboards security context
    podSecurityContext:
      runAsUser: 1000
      runAsGroup: 1000
      runAsNonRoot: true
      fsGroup: 1000
      seccompProfile:
        type: RuntimeDefault
    
    securityContext:
      allowPrivilegeEscalation: false
      privileged: false
      runAsNonRoot: true
      capabilities:
        drop:
          - ALL
    
    resources:
      requests:
        memory: "512Mi"
        cpu: "200m"
      limits:
        memory: "512Mi"
        cpu: "200m"
```

When the init container is disabled, you must ensure volumes are writable by UID 1000. The `fsGroup` setting handles this automatically:

```yaml
podSecurityContext:
  fsGroup: 1000  # Kubernetes will chown volumes to this group
```

If using a StorageClass that doesn't support fsGroup, ensure the underlying storage is pre-configured with correct permissions.

## Configuration Reference

### Common Configuration Options

| Field | Default | Description |
|-------|---------|-------------|
| `spec.general.version` | - | OpenSearch version (required) |
| `spec.general.httpPort` | `9200` | HTTP API port |
| `spec.general.setVMMaxMapCount` | `false` | Enable vm.max_map_count init container |
| `spec.nodePools[].replicas` | - | Number of nodes in pool |
| `spec.nodePools[].diskSize` | - | Storage size per node |
| `spec.nodePools[].jvm` | auto | JVM heap settings (e.g., `-Xmx4G -Xms4G`) |
| `spec.nodePools[].roles` | - | Node roles (cluster_manager, data, ingest, or empty for coordinating) |
| `spec.dashboards.enable` | `false` | Enable OpenSearch Dashboards |
| `spec.dashboards.version` | - | Dashboards version |
| `spec.security.tls.transport.generate` | `false` | Auto-generate transport TLS certificates |
| `spec.security.tls.http.generate` | `false` | Auto-generate HTTP TLS certificates |

### Custom OpenSearch Configuration

Add custom OpenSearch settings via `additionalConfig`:

```yaml
spec:
  general:
    additionalConfig:
      # Global settings applied to all nodes
      indices.query.bool.max_clause_count: "2048"
  nodePools:
    - component: data
      additionalConfig:
        # Node pool-specific settings
        node.attr.zone: zone-a
      roles:
        - "data"
```

## References

1. [OpenSearch Kubernetes Operator Documentation](https://github.com/opensearch-project/opensearch-k8s-operator/blob/main/docs/userguide/main.md)
2. [OpenSearch Official Documentation](https://docs.opensearch.org/3.3/about/)
3. [How to Set and Update the OpenSearch Admin Password](./How_to_update_opensearch_admin_password.md)
4. [OpenSearch Node Roles](https://opensearch.org/docs/latest/tuning-your-cluster/#node-roles)
