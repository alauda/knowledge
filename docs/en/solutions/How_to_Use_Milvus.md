---
kind:
   - Solution
products:
  - Alauda Application Services
ProductsVersion:
   - 4.x
---

# Milvus Vector Database Solution Guide

## Background

### The Challenge

Modern AI/ML applications require efficient similarity search and vector operations at scale. Traditional databases struggle with:

- **Vector Search Performance**: Inability to efficiently search through millions of high-dimensional vectors
- **Scalability Limitations**: Difficulty scaling vector operations across multiple nodes
- **Complex Deployment**: Challenges in deploying and managing distributed vector databases
- **Integration Complexity**: Hard to integrate with existing ML pipelines and AI frameworks

### The Solution

Milvus is an open-source vector database built for scalable similarity search and AI applications, providing:

- **High-Performance Vector Search**: Billion-scale vector search with millisecond latency
- **Multiple Index Types**: Support for various indexing algorithms (IVF, HNSW, ANNOY, DiskANN)
- **Cloud-Native Architecture**: Kubernetes-native design with automatic scaling and fault tolerance
- **Rich Ecosystem**: Integrations with popular ML frameworks (PyTorch, TensorFlow, LangChain, LlamaIndex)

## Environment Information

Applicable Versions: >=ACP 4.2.0, Milvus: >=v2.4.0

## Quick Reference

### Key Concepts
- **Collection**: A container for a set of vectors and their associated schema
- **Vector Embedding**: Numerical representation of data (text, images, audio) for similarity search
- **Index**: Data structure that accelerates vector similarity search
- **Partition**: Logical division of a collection for improved search performance and data management
- **Message Queue**: Required for cluster mode. Options include:
  - **Woodpecker**: Embedded WAL in Milvus 2.6+ (simpler deployment)
  - **Kafka**: External distributed event streaming platform (battle-tested, production-proven)

### Common Use Cases

| Scenario | Recommended Approach | Section Reference |
|----------|---------------------|------------------|
| **Semantic Search** | Create collection with text embeddings | [Basic Operations](https://milvus.io/docs/) |
| **Image Retrieval** | Use vision model embeddings | [Image Search](https://milvus.io/docs/) |
| **RAG Applications** | Integrate with LangChain/LlamaIndex | [RAG Pipeline](https://milvus.io/docs/) |
| **Production Deployment** | Use cluster mode with appropriate message queue | [Production Workflows](https://milvus.io/docs/) |

### Message Queue Selection Guide

| Factor | Woodpecker | Kafka |
|--------|-----------|-------|
| **Operational Overhead** | Low (embedded) | High (external service) |
| **Production Maturity** | New (Milvus 2.6+) | Battle-tested |
| **Scalability** | Good with object storage | Excellent horizontal scaling |
| **Deployment Complexity** | Simple | Complex |
| **Best For** | Simplicity, lower cost, new deployments | Mission-critical workloads, existing Kafka users |

## Prerequisites

Before implementing Milvus, ensure you have:

- ACP v4.2.0 or later
- Basic understanding of vector embeddings and similarity search concepts

> **Note**: ACP v4.2.0 and later supports in-cluster MinIO and etcd deployment through the Milvus Operator. External storage (S3-compatible) and external message queue (Kafka) are optional.

### Storage Requirements

- **etcd**: Minimum 10GB storage per replica for metadata (in-cluster deployment)
- **MinIO**: Sufficient capacity for your vector data and index files (in-cluster deployment)
- **Memory**: RAM should be 2-4x the vector dataset size for optimal performance

### Resource Recommendations

| Deployment Mode | Minimum CPU | Minimum Memory | Recommended Use |
|-----------------|-------------|----------------|-----------------|
| **Standalone** | 4 cores | 8GB | Development, testing |
| **Cluster** | 16+ cores | 32GB+ | Production, large-scale |

## Installation Guide

### Chart Upload

Download the Milvus Operator chart from the Marketplace in the Alauda Customer Portal and upload the chart to your ACP catalog. To download the `violet` tool and find usage information, refer to [Violet CLI Tool Documentation](https://docs.alauda.io/container_platform/4.2/ui/cli_tools/violet.html):

```bash
CHART=chart-milvus-operator.ALL.1.3.5.tgz
ADDR="https://your-acp-domain.com"
USER="admin@cpaas.io"
PASS="your-password"

violet push $CHART \
--platform-address "$ADDR" \
--platform-username "$USER" \
--platform-password "$PASS"
```

### Backend Storage Configuration

#### External S3-Compatible Storage (Optional)

For production deployments requiring external storage, you can use existing S3-compatible storage services. This requires:

1. Create a Kubernetes secret with storage credentials:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: milvus-storage-secret
  namespace: milvus
type: Opaque
stringData:
  accesskey: "<YOUR_ACCESS_KEY>"
  secretkey: "<YOUR_SECRET_KEY>"
```

2. Configure Milvus to use external storage in the custom resource (see Option 2B below)

#### Ceph RGW (Not Verified)

Ceph RGW should work with Milvus but is not currently verified. If you choose to use Ceph RGW:

1. Deploy Ceph storage system following the [Ceph installation guide](https://docs.alauda.io/container_platform/4.2/storage/storagesystem_ceph/installation/create_service_stand.html)

2. [Create Ceph Object Store User](https://docs.alauda.io/container_platform/4.2/storage/storagesystem_ceph/how_to/create_object_user):

```yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata:
  name: milvus-user
  namespace: rook-ceph
spec:
  store: my-store
  displayName: milvus-storage-pool
  quotas:
    maxBuckets: 100
    maxSize: -1
    maxObjects: -1
  capabilities:
    user: "*"
    bucket: "*"
```

3. Retrieve access credentials:

```bash
user_secret=$(kubectl -n rook-ceph get cephobjectstoreuser milvus-user -o jsonpath='{.status.info.secretName}')
ACCESS_KEY=$(kubectl -n rook-ceph get secret $user_secret -o jsonpath='{.data.AccessKey}' | base64 -d)
SECRET_KEY=$(kubectl -n rook-ceph get secret $user_secret -o jsonpath='{.data.SecretKey}' | base64 -d)
```

4. Create a Kubernetes secret with the Ceph RGW credentials:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: milvus-storage-secret
  namespace: milvus
type: Opaque
stringData:
  accesskey: "<YOUR_ACCESS_KEY>"
  secretkey: "<YOUR_SECRET_KEY>"
```

5. Configure Milvus to use Ceph RGW in the custom resource by setting the storage endpoint to your Ceph RGW service (e.g., `rook-ceph-rgw-my-store.rook-ceph.svc:7480`)

### Message Queue Options

Milvus requires a message queue for cluster mode deployments. You can choose between:

#### Option 1: Woodpecker

Woodpecker is an embedded Write-Ahead Log (WAL) in Milvus 2.6+. It's a cloud-native WAL designed for object storage.

**Characteristics:**
- **Simplified Deployment**: No external message queue service required
- **Cost-Efficient**: Lower operational overhead
- **High Throughput**: Optimized for batch operations with object storage
- **Storage Options**: Supports MinIO/S3-compatible storage or local file system
- **Availability**: Introduced in Milvus 2.6 as an optional WAL

Woodpecker is enabled by default in Milvus 2.6+ and uses the same object storage (MinIO) configured for your Milvus deployment. For more details, see the [Milvus Woodpecker documentation](https://milvus.io/docs/use-woodpecker.md).

**Considerations:**
- Newer technology with less production history compared to Kafka
- May require evaluation for your specific production requirements
- Best suited for deployments prioritizing simplicity and lower operational overhead

#### Option 2: Kafka

Kafka is a distributed event streaming platform that can be used as the message queue for Milvus. Kafka is a mature, battle-tested solution widely used in production environments.

**Characteristics:**
- **Production-Proven**: Battle-tested in enterprise environments for years
- **Scalability**: Horizontal scaling with multiple brokers
- **Ecosystem**: Extensive tooling, monitoring, and operational experience
- **ACP Integration**: Supported as a service on ACP

**Setup:**
1. Deploy Kafka following the [Kafka installation guide](https://docs.alauda.io/kafka/4.1/)

2. Retrieve the Kafka broker service endpoint:

```bash
# Get Kafka broker service endpoint
kubectl get svc -n kafka-namespace
```

3. Use the Kafka broker endpoint in your Milvus custom resource (e.g., `kafka://kafka-broker.kafka.svc.cluster.local:9092`)

> **Important**: Although the Milvus CRD field is named `pulsar`, it supports both Pulsar and Kafka. The endpoint scheme determines which message queue type is used:
> - `kafka://` for Kafka brokers
> - `pulsar://` for Pulsar brokers

**Considerations:**
- Requires additional operational overhead for Kafka cluster management
- Best suited for organizations with existing Kafka infrastructure and expertise
- Recommended for mission-critical production workloads requiring proven reliability

### Milvus Deployment

#### Option 1: Standalone Mode (Development/Testing)

1. Access ACP web console and navigate to "Applications" → "Create" → "Create from Catalog"

2. Select the Milvus Operator chart and deploy the operator first

3. Create a Milvus custom resource with standalone mode:

```yaml
apiVersion: milvus.io/v1beta1
kind: Milvus
metadata:
  name: milvus-standalone
  namespace: milvus
spec:
  mode: standalone
  components:
    image: build-harbor.alauda.cn/middleware/milvus:v2.6.7

  dependencies:
    etcd:
      inCluster:
        values:
          image:
            repository: build-harbor.alauda.cn/middleware/etcd
            tag: 3.5.25-r1
          replicaCount: 1
          persistence:
            size: 5Gi

    storage:
      type: MinIO
      inCluster:
        values:
          image:
            repository: build-harbor.alauda.cn/middleware/minio
            tag: RELEASE.2024-12-18T13-15-44Z
          mode: standalone
          persistence:
            size: 20Gi
          resources:
            requests:
              cpu: 100m
              memory: 128Mi

  config:
    milvus:
      log:
        level: info
```

#### Option 2: Cluster Mode (Production)

For production deployments, use cluster mode. Below are common production configurations:

**Option 2A: Production with In-Cluster Dependencies (Recommended)**

This configuration uses in-cluster etcd and MinIO, with Woodpecker as the embedded message queue:

```yaml
apiVersion: milvus.io/v1beta1
kind: Milvus
metadata:
  name: milvus-cluster
  namespace: milvus
spec:
  mode: cluster
  components:
    image: build-harbor.alauda.cn/middleware/milvus:v2.6.7

  dependencies:
    # Use in-cluster etcd
    etcd:
      inCluster:
        values:
          image:
            repository: build-harbor.alauda.cn/middleware/etcd
            tag: 3.5.25-r1
          replicaCount: 3
          persistence:
            size: 10Gi
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi

    # Use in-cluster MinIO for production
    storage:
      type: MinIO
      inCluster:
        values:
          image:
            repository: build-harbor.alauda.cn/middleware/minio
            tag: RELEASE.2024-12-18T13-15-44Z
          mode: standalone
          persistence:
            size: 100Gi
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi

  config:
    milvus:
      log:
        level: info

  # Resource allocation for production
  resources:
    requests:
      cpu: "4"
      memory: "8Gi"
    limits:
      cpu: "8"
      memory: "16Gi"
```

**Option 2B: Production with External S3-Compatible Storage**

This configuration uses in-cluster etcd with external S3-compatible storage:

```yaml
apiVersion: milvus.io/v1beta1
kind: Milvus
metadata:
  name: milvus-cluster
  namespace: milvus
spec:
  mode: cluster
  components:
    image: build-harbor.alauda.cn/middleware/milvus:v2.6.7

  dependencies:
    # Use in-cluster etcd
    etcd:
      inCluster:
        values:
          image:
            repository: build-harbor.alauda.cn/middleware/etcd
            tag: 3.5.25-r1
          replicaCount: 3
          persistence:
            size: 10Gi
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi

    # Use external S3-compatible storage
    storage:
      type: S3
      external: true
      endpoint: minio-service.minio.svc:9000
      secretRef: milvus-storage-secret

  config:
    milvus:
      log:
        level: info

  # Resource allocation for production
  resources:
    requests:
      cpu: "4"
      memory: "8Gi"
    limits:
      cpu: "8"
      memory: "16Gi"
```

4. For external storage, create the storage secret (skip for in-cluster MinIO):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: milvus-storage-secret
  namespace: milvus
type: Opaque
stringData:
  accesskey: "<YOUR_ACCESS_KEY>"
  secretkey: "<YOUR_SECRET_KEY>"
```

> **Note**: Skip this step if using in-cluster MinIO (Option 2A). The secret is only required for external storage (Option 2B).

**Option 2C: Production with Kafka Message Queue**

If you prefer to use Kafka instead of Woodpecker (recommended for mission-critical production workloads):

```yaml
apiVersion: milvus.io/v1beta1
kind: Milvus
metadata:
  name: milvus-cluster
  namespace: milvus
spec:
  mode: cluster
  components:
    image: build-harbor.alauda.cn/middleware/milvus:v2.6.7

  dependencies:
    # Use in-cluster etcd
    etcd:
      inCluster:
        values:
          image:
            repository: build-harbor.alauda.cn/middleware/etcd
            tag: 3.5.25-r1
          replicaCount: 3
          persistence:
            size: 10Gi
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi

    # Use in-cluster MinIO for production
    storage:
      type: MinIO
      inCluster:
        values:
          image:
            repository: build-harbor.alauda.cn/middleware/minio
            tag: RELEASE.2024-12-18T13-15-44Z
          mode: standalone
          persistence:
            size: 100Gi
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi

    # Use external Kafka for message queue
    # Note: The field is named 'pulsar' for historical reasons, but supports both Pulsar and Kafka
    # Use 'kafka://' scheme for Kafka, 'pulsar://' scheme for Pulsar
    pulsar:
      external: true
      endpoint: kafka://kafka-broker.kafka.svc.cluster.local:9092

  config:
    milvus:
      log:
        level: info

  # Resource allocation for production
  resources:
    requests:
      cpu: "4"
      memory: "8Gi"
    limits:
      cpu: "8"
      memory: "16Gi"
```

5. Deploy and verify the Milvus cluster reaches "Ready" status:

```bash
# Check Milvus custom resource status
kubectl get milvus -n milvus

# Check all pods are running
kubectl get pods -n milvus

# View Milvus components
kubectl get milvus -n milvus -o yaml
```

## Configuration Guide

### Accessing Milvus

1. Retrieve the Milvus service endpoint:

```bash
# For standalone mode
kubectl get svc milvus-standalone-milvus -n milvus

# For cluster mode
kubectl get svc milvus-cluster-milvus -n milvus
```

2. The default Milvus port is **19530** for gRPC API

3. Use port-forwarding for local access:

```bash
kubectl port-forward svc/milvus-standalone-milvus 19530:19530 -n milvus
```

### Getting Started with Milvus

For detailed usage instructions, API reference, and advanced features, please refer to the official [Milvus documentation](https://milvus.io/docs/).

The official documentation covers:
- Basic operations (create collections, insert vectors, search)
- Advanced features (index types, partitioning, replication)
- Client SDKs (Python, Java, Go, Node.js, C#)
- Integration with AI frameworks (LangChain, LlamaIndex, Haystack)
- Performance tuning and best practices

#### Quick Start Example (Python)

```python
from pymilvus import MilvusClient

# Connect to Milvus
client = MilvusClient(
    uri="http://milvus-standalone-milvus.milvus.svc.cluster.local:19530"
)

# Create a collection
client.create_collection(
    collection_name="demo_collection",
    dimension=384  # Match your embedding model
)

# Insert vectors
vectors = [[0.1, 0.2, ...], [0.3, 0.4, ...]]  # Your embeddings
data = [{"id": 1, "vector": v, "text": "sample"} for v in vectors]
client.insert("demo_collection", data)

# Search similar vectors
query_vector = [[0.1, 0.2, ...]]
results = client.search(
    collection_name="demo_collection",
    data=query_vector,
    limit=5
)
```

## Troubleshooting

### Common Issues

#### Pod Not Starting

**Symptoms**: Milvus pods stuck in Pending or CrashLoopBackOff state

**Solutions**:
- Check resource allocation (memory and CPU limits)
- Verify storage classes are available
- Ensure image pull secrets are configured correctly
- Review pod logs: `kubectl logs -n milvus <pod-name>`

#### Connection Refused

**Symptoms**: Unable to connect to Milvus service

**Solutions**:
- Verify Milvus service is running: `kubectl get svc -n milvus`
- Check network policies allow traffic
- Ensure port-forwarding is active if using local access
- Verify no firewall rules blocking port 19530

#### Poor Search Performance

**Symptoms**: Slow vector search queries

**Solutions**:
- Create appropriate indexes for your collections
- Increase query node resources
- Use partitioning to limit search scope
- Optimize search parameters (nprobe, ef)
- Consider using GPU-enabled indices for large-scale deployments

### Diagnostic Commands

Check Milvus health:

```bash
# Check all Milvus components
kubectl get milvus -n milvus -o wide

# Check pod status
kubectl get pods -n milvus

# Check component logs
kubectl logs -n milvus <pod-name> -c milvus

# Describe Milvus resource
kubectl describe milvus <milvus-name> -n milvus
```

Verify dependencies:

```bash
# Check in-cluster etcd pods
kubectl get pods -n milvus -l app=etcd

# Check in-cluster MinIO pods
kubectl get pods -n milvus -l app=minio

# Check Kafka connectivity (if using Kafka)
kubectl exec -it <milvus-pod> -n milvus -- nc -zv <kafka-broker> 9092
```

## Best Practices

### Collection Design

- **Schema Planning**: Define appropriate vector dimensions and field types before creating collections
- **Index Selection**: Choose index types based on your use case (HNSW for high recall, IVF for balance)
- **Partitioning**: Use partitions to logically separate data and improve search performance
- **Consistency Level**: Set appropriate consistency levels (Strong, Bounded, Eventually, Session)

### Resource Optimization

- **Memory Sizing**: Allocate memory 2-4x your vector dataset size for optimal performance
- **Query Nodes**: Scale query nodes based on search QPS requirements
- **Index Building**: Use dedicated index nodes for large collections
- **Monitoring**: Implement monitoring for resource utilization and query latency

### Security Considerations

- **Network Policies**: Restrict network access to Milvus services
- **Authentication**: Enable TLS and authentication for production deployments
- **Secrets Management**: Use Kubernetes secrets for sensitive credentials
- **RBAC**: Implement role-based access control for Milvus operator

### Backup Strategy

- **etcd Backups**: Regular backups of in-cluster etcd persistent volumes
- **MinIO Replication**: Enable replication on MinIO or use redundant storage backend
- **Collection Export**: Periodically export collection data for disaster recovery
- **Testing**: Regularly test restoration procedures

## Reference

### Configuration Parameters

**Milvus Deployment:**
- `mode`: Deployment mode (standalone, cluster)
- `components.image`: Milvus container image
- `dependencies.etcd`: etcd configuration for metadata
- `dependencies.storage`: Object storage configuration
- `dependencies.pulsar`: Message queue configuration (field named `pulsar` for historical reasons, supports both Pulsar and Kafka)
- `config.milvus`: Milvus-specific configuration

**Message Queue Options:**
- **Woodpecker**: Embedded WAL enabled by default in Milvus 2.6+, uses object storage
- **Kafka**: External Kafka service, set `pulsar.external.endpoint` to Kafka broker with `kafka://` scheme (e.g., `kafka://kafka-broker.kafka.svc.cluster.local:9092`)
- **Pulsar**: External Pulsar service, set `pulsar.external.endpoint` to Pulsar broker with `pulsar://` scheme (e.g., `pulsar://pulsar-broker.pulsar.svc.cluster.local:6650`)

> **Important**: The CRD field is named `pulsar` for backward compatibility, but you can configure either Pulsar or Kafka by using the appropriate endpoint scheme (`pulsar://` or `kafka://`).

**Index Types:**
- **FLAT**: Exact search, 100% recall, slow for large datasets
- **IVF_FLAT**: Balanced performance and accuracy
- **IVF_SQ8**: Compressed vectors, lower memory usage
- **HNSW**: High performance, high recall, higher memory usage
- **DISKANN**: Disk-based index for very large datasets

### Useful Links

- [Milvus Documentation](https://milvus.io/docs/) - Comprehensive usage guide and API reference
- [Milvus Woodpecker Guide](https://milvus.io/docs/use-woodpecker.md) - Woodpecker WAL documentation
- [Milvus Bootcamp](https://github.com/milvus-io/bootcamp) - Tutorial notebooks and examples
- [PyMilvus SDK](https://milvus.io/api-reference/pymilvus/v2.4.x/About.md) - Python client documentation
- [Milvus Operator GitHub](https://github.com/zilliztech/milvus-operator) - Operator source code
- [ACP Kafka Documentation](https://docs.alauda.io/kafka/4.2/) - Kafka installation on ACP

## Summary

This guide provides comprehensive instructions for implementing Milvus on Alauda Container Platform. The solution delivers a production-ready vector database for AI/ML applications, enabling:

- **Scalable Vector Search**: Billion-scale similarity search with millisecond latency
- **Flexible Deployment**: Support for both development (standalone) and production (cluster) modes
- **Cloud-Native Architecture**: Kubernetes-native design with automatic scaling and fault tolerance
- **Rich AI Integration**: Seamless integration with popular ML frameworks and LLM platforms

By following these practices, organizations can build robust AI applications including semantic search, recommendation systems, RAG applications, and image retrieval while maintaining the scalability and reliability required for production deployments.
