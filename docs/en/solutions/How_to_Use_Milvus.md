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

### Important Deployment Considerations

| Aspect | Standalone Mode | Cluster Mode |
|--------|----------------|--------------|
| **PodSecurity Compatibility** | ✓ Supported (set `runAsNonRoot: true`) | ✓ Supported |
| **Production Readiness** | Development/testing only | Production-ready |
| **Resource Requirements** | Lower (4 cores, 8GB RAM) | Higher (16+ cores, 32GB+ RAM) |
| **Scalability** | Limited | Horizontal scaling |
| **Complexity** | Simple to deploy | More components to manage |

> **✓ PodSecurity Compliance**: Both standalone and cluster modes are fully compatible with ACP's PodSecurity "restricted" policy. Simply add `components.runAsNonRoot: true` to your Milvus custom resource (see deployment examples below).

## Prerequisites

Before implementing Milvus, ensure you have:

- ACP v4.2.0 or later
- Basic understanding of vector embeddings and similarity search concepts
- Access to your cluster's container image registry (registry addresses vary by cluster)

- ACP v4.2.0 or later
- Basic understanding of vector embeddings and similarity search concepts
- Access to your cluster's container image registry (registry addresses vary by cluster)

> **Note**: ACP v4.2.0 and later supports in-cluster MinIO and etcd deployment through the Milvus Operator. External storage (S3-compatible) and external message queue (Kafka) are optional.

> **Important**: Different ACP clusters may use different container registry addresses. The documentation uses `build-harbor.alauda.cn` as an example, but you may need to replace this with your cluster's registry (e.g., `registry.alauda.cn:60070`). See the [Troubleshooting section](#image-pull-authentication-errors) for details.

### Storage Requirements

- **etcd**: Minimum 10GB storage per replica for metadata (in-cluster deployment)
- **MinIO**: Sufficient capacity for your vector data and index files (in-cluster deployment)
- **Memory**: RAM should be 2-4x the vector dataset size for optimal performance

### Resource Recommendations

| Deployment Mode | Minimum CPU | Minimum Memory | Recommended Use |
|-----------------|-------------|----------------|-----------------|
| **Standalone** | 4 cores | 8GB | Development, testing |
| **Cluster** | 16+ cores | 32GB+ | Production, large-scale |

### Pre-Deployment Checklist

Before deploying Milvus, complete this checklist to ensure a smooth deployment:

- [ ] **Cluster Registry Address**: Verify your cluster's container registry address
  ```bash
  # Check existing deployments for registry address
  kubectl get deployment -n <namespace> -o jsonpath='{.items[0].spec.template.spec.containers[0].image}'
  ```

- [ ] **Storage Class**: Verify storage classes are available and check binding mode
  ```bash
  kubectl get storageclasses
  kubectl get storageclass <storage-class-name> -o jsonpath='{.volumeBindingMode}'
  ```
  Prefer storage classes with `Immediate` binding mode.

- [ ] **Namespace**: Create a dedicated namespace for Milvus
  ```bash
  kubectl create namespace milvus
  ```

- [ ] **PodSecurity Policy**: Verify if your cluster enforces PodSecurity policies (most ACP clusters do by default)
  ```bash
  kubectl get namespace <namespace> -o jsonpath='{.metadata.labels}'
  ```
  If `pod-security.kubernetes.io/enforce=restricted`, the Milvus operator will automatically handle PodSecurity compliance when you set `components.runAsNonRoot: true` in your Milvus CR. No manual patching required.

- [ ] **Message Queue Decision**: Decide which message queue to use for cluster mode:
  - Woodpecker (embedded, simpler) - No additional setup required
  - Kafka (external, production-proven) - Deploy Kafka service first

- [ ] **Storage Decision**: Decide storage configuration:
  - In-cluster MinIO (simpler, recommended for most cases)
  - External S3-compatible storage (for production with existing storage infrastructure)

- [ ] **Resource Availability**: Ensure sufficient resources in the cluster
  ```bash
  kubectl top nodes
  ```

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

> **Important**: Before deploying, verify the image registry address in the chart matches your cluster's registry. If your cluster uses a different registry (e.g., `registry.alauda.cn:60070` instead of `build-harbor.alauda.cn`), you'll need to update the image references. See [Image Pull Authentication Errors](#image-pull-authentication-errors) in the Troubleshooting section.

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

> **Important**: For cluster mode, set `dependencies.msgStreamType: woodpecker` to use Woodpecker as the message queue. Do **not** use `msgStreamType: rocksmq` for cluster mode - rocksmq is only for standalone mode.

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
    runAsNonRoot: true  # Enable PodSecurity compliance

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

> **Important**: The `components.runAsNonRoot: true` setting enables PodSecurity compliance. The operator will automatically apply all required security contexts to the Milvus containers and their dependencies (etcd, MinIO).

#### Option 2: Cluster Mode (Production)

For production deployments, use cluster mode. Below are common production configurations:

**Option 2A: Production with Woodpecker (Recommended)**

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
    runAsNonRoot: true  # Enable PodSecurity compliance

  dependencies:
    # Enable Woodpecker as message queue (recommended for cluster mode)
    msgStreamType: woodpecker

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

> **Note**: Woodpecker is set with `msgStreamType: woodpecker`. Woodpecker uses the same MinIO storage for its WAL, providing a simpler deployment without external message queue services.

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

### Quick Troubleshooting Checklist

Use this checklist to quickly identify and resolve common deployment issues:

| Symptom | Likely Cause | Solution Section |
|---------|--------------|------------------|
| Pods stuck in Pending with PodSecurity violations | PodSecurity policy | [PodSecurity Admission Violations](#podsecurity-admission-violations) |
| Pods fail with ErrImagePull or ImagePullBackOff | Wrong registry or authentication | [Image Pull Authentication Errors](#image-pull-authentication-errors) |
| PVCs stuck in Pending with "waiting for consumer" | Storage class binding mode | [PVC Pending - Storage Class Binding Mode](#pvc-pending---storage-class-binding-mode) |
| etcd pods fail with "invalid reference format" | Image prefix bug | [etcd Invalid Image Name Error](#etcd-invalid-image-name-error) |
| Multi-Attach volume errors | Storage class access mode | [Multi-Attach Volume Errors](#multi-attach-volume-errors) |
| Milvus panic: MinIO PutObjectIfNoneMatch failed | MinIO PVC corruption | [MinIO Storage Corruption Issues](#minio-storage-corruption-issues) |
| Milvus standalone pod crashes (exit code 134) | Health check & non-root compatibility | [Milvus Standalone Pod Crashes (Exit Code 134)](#milvus-standalone-pod-crashes-exit-code-134) |
| Milvus cluster pod panic with "mq rocksmq is only valid in standalone mode" | Incorrect message queue type | [Cluster Mode Message Queue Configuration](#cluster-mode-message-queue-configuration) |
| Cannot connect to Milvus service | Network or service issues | [Connection Refused](#connection-refused) |
| Slow vector search performance | Index or resource issues | [Poor Search Performance](#poor-search-performance) |

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

#### PodSecurity Admission Violations

**Symptoms**: Milvus pods fail to create with PodSecurity errors:

```
Error creating: pods is forbidden: violates PodSecurity "restricted:latest":
- runAsNonRoot != true (pod or container must set securityContext.runAsNonRoot=true)
```

**Cause**: The Milvus custom resource is missing the `components.runAsNonRoot: true` setting.

**Solution**: Add `components.runAsNonRoot: true` to your Milvus custom resource:

```yaml
spec:
  components:
    runAsNonRoot: true  # Required for PodSecurity compliance
    image: build-harbor.alauda.cn/middleware/milvus:v2.6.7
```

The Milvus operator will automatically apply all required security contexts:
- `runAsNonRoot: true` (pod and container level)
- `runAsUser: 1000` (matching upstream)
- `allowPrivilegeEscalation: false`
- `capabilities.drop: [ALL]`
- `seccompProfile.type: RuntimeDefault`

This applies to:
- Milvus standalone/cluster deployments
- Init containers (config)
- etcd StatefulSets
- MinIO deployments

**Verification**:
```bash
# Check if all pods are running
kubectl get pods -n <namespace>

# Verify security contexts are applied
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.securityContext}'
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.containers[*].securityContext}'
```

#### Milvus Standalone Pod Crashes (Exit Code 134)

**Symptoms**: Milvus standalone pod repeatedly crashes with exit code 134 (SIGABRT).

**Cause**: This was a known compatibility issue with Milvus v2.6.7 when running under PodSecurity "restricted" policies. The issue has been fixed in updated Milvus operator images.

**Solution**:

1. Ensure you're using the updated Milvus operator image (v1.3.5-6e82465e or later)
2. Add `components.runAsNonRoot: true` to your Milvus custom resource:

```yaml
spec:
  components:
    runAsNonRoot: true  # Required for PodSecurity compliance
    image: build-harbor.alauda.cn/middleware/milvus:v2.6.7
```

3. Delete and recreate the Milvus CR if you previously deployed without this setting:

```bash
kubectl delete milvus <name> -n <namespace>
kubectl apply -f <your-milvus-cr>.yaml
```

The operator will automatically handle all PodSecurity requirements when `runAsNonRoot: true` is set.

#### Cluster Mode Message Queue Configuration

**Symptoms**: Milvus cluster component pods (mixcoord, datanode, proxy, querynode) panic with the following error:

```
panic: mq rocksmq is only valid in standalone mode
```

**Cause**: The Milvus custom resource is configured with `msgStreamType: rocksmq` for cluster mode. The `rocksmq` message stream type is only valid for standalone mode. For cluster mode, you must use `woodpecker` instead.

**Solution**: Change `dependencies.msgStreamType` from `rocksmq` to `woodpecker`:

**Incorrect (for cluster mode)**:
```yaml
spec:
  dependencies:
    msgStreamType: rocksmq  # WRONG - only for standalone mode
```

**Correct (for cluster mode)**:
```yaml
spec:
  dependencies:
    msgStreamType: woodpecker  # Use woodpecker for cluster mode
```

**Complete cluster mode example with Woodpecker**:
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
    runAsNonRoot: true
  dependencies:
    msgStreamType: woodpecker  # Woodpecker for cluster mode
    etcd:
      inCluster:
        values:
          image:
            repository: build-harbor.alauda.cn/middleware/etcd
            tag: 3.5.25-r1
          replicaCount: 3
    storage:
      inCluster:
        values:
          image:
            repository: build-harbor.alauda.cn/middleware/minio
            tag: RELEASE.2024-12-18T13-15-44Z
```

After correcting the configuration, delete and recreate the Milvus instance:

```bash
kubectl delete milvus <name> -n <namespace>
kubectl apply -f <your-milvus-cr>.yaml
```

**Message Queue Type Reference**:
- **Standalone mode**: Use `msgStreamType: rocksmq` (or omit, defaults to rocksmq)
- **Cluster mode**: Use `msgStreamType: woodpecker`
- **External Kafka/Pulsar**: Use `dependencies.pulsar.external.endpoint` with appropriate scheme

#### PVC Pending - Storage Class Binding Mode

**Symptoms**: PersistentVolumeClaims remain in Pending state with events like:

```
Warning  ProvisioningFailed  persistentvolumeclaim  <storage-class>
storageclass.storage.k8s.io "<storage-class>" is waiting for a consumer to be found
```

**Cause**: Some storage classes (e.g., Topolvm) use `volumeBindingMode: WaitForFirstConsumer`, which delays PVC binding until a Pod using the PVC is scheduled. However, some controllers and operators may have issues with this delayed binding mode.

**Solution**: Use a storage class with `volumeBindingMode: Immediate` for Milvus deployments:

1. **List available storage classes**:

```bash
kubectl get storageclasses
```

2. **Check storage class binding mode**:

```bash
kubectl get storageclass <storage-class-name> -o jsonpath='{.volumeBindingMode}'
```

3. **Use Immediate binding storage class** in your Milvus CR:

```yaml
dependencies:
  etcd:
    inCluster:
      values:
        persistence:
          storageClass: <immediate-binding-storage-class>  # e.g., jpsu2-rook-cephfs-sc
  storage:
    inCluster:
      values:
        persistence:
          storageClass: <immediate-binding-storage-class>
```

Common storage classes with Immediate binding include CephFS-based storage classes (e.g., `jpsu2-rook-cephfs-sc`).

#### Multi-Attach Volume Errors

**Symptoms**: Pods fail with multi-attach error:

```
Warning  FailedMount  Unable to attach or mount volumes:
unmounted volumes=[<volume-name>], unattached volumes=[<volume-name>]:
timed out waiting for the condition
Multi-Attach error: Volume is already used by pod(s) <pod-name>
```

**Cause**: This occurs when multiple Pods attempt to use the same PersistentVolume simultaneously with a storage class that doesn't support read-write-many (RWX) access mode.

**Solution**: Verify your storage class supports the required access mode:

1. **Check storage class access modes**:

```bash
kubectl get storageclass <storage-class-name> -o jsonpath='{.allowedTopologies}'
```

2. **Use appropriate storage class** for your deployment:
   - **Standalone mode**: ReadWriteOnce (RWO) is sufficient
   - **Cluster mode**: Use ReadWriteMany (RWX) if multiple pods need shared access, or ensure each pod has its own PVC

3. **For CephFS storage classes**, RWX is typically supported and recommended for Milvus cluster deployments.

#### MinIO Storage Corruption Issues

**Symptoms**: Milvus standalone pod crashes with panic related to MinIO:

```
panic: CheckIfConditionWriteSupport failed: PutObjectIfNoneMatch not supported or failed.
BucketName: milvus-test, ObjectKey: files/wp/conditional_write_test_object,
Error: Resource requested is unreadable, please reduce your request rate
```

Or MinIO logs show:

```
Error: Following error has been printed 3 times.. UUID on positions 0:0 do not match with
expected... inconsistent drive found
Error: Storage resources are insufficient for the write operation
```

**Cause**: The MinIO persistent volume claim (PVC) has corrupted data from previous deployments. This can happen when:
- The MinIO deployment was deleted but the PVC was retained
- Multiple MinIO deployments used the same PVC
- The MinIO data became inconsistent due to incomplete writes or crashes

**Solution**: Completely recreate MinIO by uninstalling the Helm release and deleting the PVC:

```bash
# 1. Check MinIO Helm release
helm list -n <namespace>

# 2. Uninstall the MinIO Helm release (keeps PVC by default)
helm uninstall milvus-<name>-minio -n <namespace>

# 3. List PVCs to find the MinIO PVC
kubectl get pvc -n <namespace> | grep minio

# 4. Delete the corrupted MinIO PVC
kubectl delete pvc -n <namespace> milvus-<name>-minio

# 5. Delete the Milvus CR to trigger full recreation
kubectl delete milvus <name> -n <namespace>

# 6. Recreate the Milvus instance
kubectl apply -f <your-milvus-cr>.yaml
```

The Milvus operator will automatically:
- Deploy a fresh MinIO instance using Helm
- Create a new PVC with clean data
- Initialize the MinIO bucket properly

**Verification**:
```bash
# Check new MinIO pod is running
kubectl get pods -n <namespace> -l app.kubernetes.io/instance=<name>

# Verify MinIO Helm release is deployed
helm list -n <namespace> | grep minio

# Check Milvus can connect to MinIO
kubectl logs -n <namespace> deployment/milvus-<name>-milvus-standalone | grep -i minio
```

> **Note**: Always delete both the Helm release AND the PVC when encountering MinIO corruption. Deleting only the deployment or pod will not fix the underlying data corruption.

### Deployment Verification

After deploying Milvus, verify the deployment is successful:

```bash
# 1. Check Milvus custom resource status
# Should show "Healthy" status
kubectl get milvus -n <namespace>

# 2. Check all pods are running
# All pods should be in "Running" state with no restarts
kubectl get pods -n <namespace>

# 3. Verify all dependencies are healthy
# etcd should be 1/1 Ready
kubectl get pod -n <namespace> -l app.kubernetes.io/component=etcd

# MinIO should be Running
kubectl get pod -n <namespace> | grep minio

# 4. Check services are created
kubectl get svc -n <namespace>

# 5. Verify PVCs are bound
kubectl get pvc -n <namespace>

# 6. Check MinIO health for corruption
kubectl logs -n <namespace> deployment/milvus-<name>-minio | grep -i "error\|inconsistent\|corrupt"
# Should return no errors

# 7. Check Milvus logs for errors
kubectl logs -n <namespace> deployment/milvus-<name>-milvus-standalone -c milvus --tail=50 | grep -i "panic\|fatal\|error"

# 8. Port-forward and test connectivity
kubectl port-forward svc/milvus-<name>-milvus 19530:19530 -n <namespace>

# In another terminal, test the connection
nc -zv localhost 19530
```

Expected output for a healthy standalone deployment:

```
# kubectl get pods -n milvus
NAME                                          READY   STATUS    RESTARTS   AGE
milvus-standalone-etcd-0                      1/1     Running   0          5m
milvus-standalone-minio-7f6f9d8b4c-x2k9q      1/1     Running   0          5m
milvus-standalone-milvus-standalone-6b8c9d    1/1     Running   0          3m

# kubectl get milvus -n milvus
NAME               MODE        STATUS    Updated
milvus-standalone   standalone   Healthy   True
```

**Verify PodSecurity Compliance**:

```bash
# Check pod security contexts (all should show PodSecurity-compliant settings)
kubectl get pod milvus-standalone-milvus-standalone-<suffix> -n milvus -o jsonpath='{.spec.securityContext}'
# Output should include: {"runAsNonRoot":true,"runAsUser":1000}

kubectl get pod milvus-standalone-milvus-standalone-<suffix> -n milvus -o jsonpath='{.spec.containers[0].securityContext}'
# Output should include: {"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"seccompProfile":{"type":"RuntimeDefault"}}
```

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
- `dependencies.msgStreamType`: Message queue type - `woodpecker` (recommended, embedded), `pulsar` (external), or `kafka` (external)
- `dependencies.etcd`: etcd configuration for metadata
- `dependencies.storage`: Object storage configuration
- `dependencies.pulsar`: External message queue configuration (field named `pulsar` for historical reasons, supports both Pulsar and Kafka)
- `config.milvus`: Milvus-specific configuration

**Message Queue Options:**
- **Woodpecker** (`msgStreamType: woodpecker`): Embedded WAL in Milvus 2.6+, uses object storage, supports both standalone and cluster modes
- **Kafka** (via `pulsar.external.endpoint`): External Kafka service, set endpoint to `kafka://kafka-broker.kafka.svc.cluster.local:9092`
- **Pulsar** (via `pulsar.external.endpoint`): External Pulsar service, set endpoint to `pulsar://pulsar-broker.pulsar.svc.cluster.local:6650`

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
