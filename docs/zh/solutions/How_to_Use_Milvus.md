---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
id: KB260400005
sourceSHA: b41423199b988482b5781c0e004048b898b2ebbecf25c9ea41c82325c21b35c7
---

# Milvus 向量数据库解决方案指南

## 背景

### 挑战

现代 AI/ML 应用程序需要高效的相似性搜索和大规模向量操作。传统数据库在以下方面面临困难：

- **向量搜索性能**：无法高效地搜索数百万个高维向量
- **可扩展性限制**：在多个节点上扩展向量操作的困难
- **复杂的部署**：部署和管理分布式向量数据库的挑战
- **集成复杂性**：与现有 ML 流水线和 AI 框架的集成困难

### 解决方案

Milvus 是一个开源向量数据库，旨在支持可扩展的相似性搜索和 AI 应用程序，提供：

- **高性能向量搜索**：十亿级向量搜索，毫秒级延迟
- **多种索引类型**：支持多种索引算法（IVF、HNSW、ANNOY、DiskANN）
- **云原生架构**：Kubernetes 原生设计，具有自动扩展和容错能力
- **丰富的生态系统**：与流行的 ML 框架（PyTorch、TensorFlow、LangChain、LlamaIndex）集成

## 环境信息

适用版本：>=ACP 4.2.0，Milvus: >=v2.4.0

## 快速参考

### 关键概念

- **集合**：一组向量及其相关模式的容器
- **向量嵌入**：用于相似性搜索的数据（文本、图像、音频）的数值表示
- **索引**：加速向量相似性搜索的数据结构
- **分区**：集合的逻辑划分，以提高搜索性能和数据管理
- **消息队列**：集群模式所需。选项包括：
  - **Woodpecker**：Milvus 2.6+ 中嵌入的 WAL（更简单的部署）
  - **Kafka**：外部分布式事件流平台（经过实战检验，生产证明）

### 常见用例

| 场景                      | 推荐方法                                      | 章节参考                                       |
| ------------------------- | --------------------------------------------- | ----------------------------------------------- |
| **语义搜索**              | 创建带有文本嵌入的集合                        | [基本操作](https://milvus.io/docs/)            |
| **图像检索**              | 使用视觉模型嵌入                             | [图像搜索](https://milvus.io/docs/)            |
| **RAG 应用**              | 与 LangChain/LlamaIndex 集成                  | [RAG 流水线](https://milvus.io/docs/)          |
| **生产部署**              | 使用集群模式和适当的消息队列                 | [生产工作流](https://milvus.io/docs/)          |

### 消息队列选择指南

| 因素                      | Woodpecker                                | Kafka                                            |
| ------------------------- | ----------------------------------------- | ------------------------------------------------ |
| **操作开销**              | 低（嵌入式）                              | 高（外部服务）                                  |
| **生产成熟度**            | 新（Milvus 2.6+）                         | 经受考验                                        |
| **可扩展性**              | 与对象存储良好兼容                        | 优秀的水平扩展                                  |
| **部署复杂性**            | 简单                                      | 复杂                                            |
| **最佳适用**              | 简单性、较低成本、新部署                  | 关键任务工作负载、现有 Kafka 用户              |

### 重要部署注意事项

| 方面                        | 独立模式                                  | 集群模式                                      |
| --------------------------- | ------------------------------------------ | ---------------------------------------------- |
| **PodSecurity 兼容性**      | ✓ 支持（设置 `runAsNonRoot: true`）       | ✓ 支持                                        |
| **生产就绪性**              | 仅限开发/测试                             | 生产就绪                                      |
| **资源要求**                | 较低（4 核心，8GB RAM）                   | 较高（16+ 核心，32GB+ RAM）                   |
| **可扩展性**                | 有限                                      | 水平扩展                                      |
| **复杂性**                  | 部署简单                                  | 需要管理更多组件                              |

> **✓ PodSecurity 合规性**：独立模式和集群模式均完全兼容 ACP 的 PodSecurity "restricted" 策略。只需在您的 Milvus 自定义资源中添加 `components.runAsNonRoot: true`（见下面的部署示例）。

## 先决条件

在实施 Milvus 之前，请确保您具备：

- ACP v4.2.0 或更高版本
- 对向量嵌入和相似性搜索概念的基本理解
- 访问集群的容器镜像注册表（注册表地址因集群而异）

> **注意**：ACP v4.2.0 及更高版本通过 Milvus Operator 支持集群内 MinIO 和 etcd 部署。外部存储（兼容 S3）和外部消息队列（Kafka）是可选的。

### 存储要求

- **etcd**：每个副本至少 10GB 存储用于元数据（集群内部署）
- **MinIO**：足够的容量用于您的向量数据和索引文件（集群内部署）
- **内存**：RAM 应为向量数据集大小的 2-4 倍，以获得最佳性能

### 资源建议

| 部署模式     | 最低 CPU | 最低内存 | 推荐用途               |
| ------------ | -------- | -------- | ---------------------- |
| **独立模式** | 4 核心   | 8GB      | 开发、测试             |
| **集群模式** | 16+ 核心 | 32GB+    | 生产、大规模           |

### 部署前检查清单

在部署 Milvus 之前，请完成此检查清单以确保顺利部署：

- [ ] **集群注册表地址**：验证您的集群容器注册表地址
  ```bash
  # 检查现有部署的注册表地址
  kubectl get deployment -n <namespace> -o jsonpath='{.items[0].spec.template.spec.containers[0].image}'
  ```

- [ ] **存储类**：验证存储类是否可用并检查绑定模式
  ```bash
  kubectl get storageclasses
  kubectl get storageclass <storage-class-name> -o jsonpath='{.volumeBindingMode}'
  ```
  优先选择绑定模式为 `Immediate` 的存储类。

- [ ] **命名空间**：为 Milvus 创建专用命名空间
  ```bash
  kubectl create namespace milvus
  ```

- [ ] **PodSecurity 策略**：验证您的集群是否强制执行 PodSecurity 策略（大多数 ACP 集群默认执行）
  ```bash
  kubectl get namespace <namespace> -o jsonpath='{.metadata.labels}'
  ```
  如果 `pod-security.kubernetes.io/enforce=restricted`，则在您设置 Milvus CR 中的 `components.runAsNonRoot: true` 时，Milvus operator 将自动处理 PodSecurity 合规性。无需手动修补。

- [ ] **消息队列决策**：决定在集群模式下使用哪个消息队列：
  - Woodpecker（嵌入式，更简单） - 无需额外设置
  - Kafka（外部，经过生产验证） - 首先部署 Kafka 服务

- [ ] **存储决策**：决定存储配置：
  - 集群内 MinIO（更简单，推荐用于大多数情况）
  - 外部兼容 S3 的存储（用于具有现有存储基础设施的生产环境）

- [ ] **资源可用性**：确保集群中有足够的资源
  ```bash
  kubectl top nodes
  ```

## 安装指南

### 图表上传

从 Alauda 客户门户的 Marketplace 下载 Milvus Operator 图表，并将图表上传到您的 ACP 目录。要下载 `violet` 工具并查找使用信息，请参阅 [Violet CLI 工具文档](https://docs.alauda.io/container_platform/4.2/ui/cli_tools/violet.html)：

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

> **重要**：在部署之前，请验证图表中的镜像注册表地址与您的集群注册表匹配。如果您的集群使用不同的注册表（例如，`registry.alauda.cn:60070` 而不是 `build-harbor.alauda.cn`），您需要更新镜像引用。请参阅 [镜像拉取身份验证错误](#image-pull-authentication-errors) 在故障排除部分。

### 后端存储配置

#### 外部兼容 S3 的存储（可选）

对于需要外部存储的生产部署，您可以使用现有的兼容 S3 的存储服务。这需要：

1. 创建一个包含存储凭据的 Kubernetes 秘密：

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

2. 在自定义资源中配置 Milvus 使用外部存储（见下面的选项 2B）

#### Ceph RGW（未验证）

Ceph RGW 应该可以与 Milvus 一起使用，但目前尚未验证。如果您选择使用 Ceph RGW：

1. 按照 [Ceph 安装指南](https://docs.alauda.io/container_platform/4.2/storage/storagesystem_ceph/installation/create_service_stand.html) 部署 Ceph 存储系统

2. [创建 Ceph 对象存储用户](https://docs.alauda.io/container_platform/4.2/storage/storagesystem_ceph/how_to/create_object_user):

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

3. 检索访问凭据：

```bash
user_secret=$(kubectl -n rook-ceph get cephobjectstoreuser milvus-user -o jsonpath='{.status.info.secretName}')
ACCESS_KEY=$(kubectl -n rook-ceph get secret $user_secret -o jsonpath='{.data.AccessKey}' | base64 -d)
SECRET_KEY=$(kubectl -n rook-ceph get secret $user_secret -o jsonpath='{.data.SecretKey}' | base64 -d)
```

4. 创建一个包含 Ceph RGW 凭据的 Kubernetes 秘密：

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

5. 在自定义资源中配置 Milvus 使用 Ceph RGW，将存储端点设置为您的 Ceph RGW 服务（例如，`rook-ceph-rgw-my-store.rook-ceph.svc:7480`）

### 消息队列选项

Milvus 在集群模式部署中需要消息队列。您可以选择：

> **重要**：对于集群模式，设置 `dependencies.msgStreamType: woodpecker` 以使用 Woodpecker 作为消息队列。不要在集群模式下使用 `msgStreamType: rocksmq` - rocksmq 仅适用于独立模式。

#### 选项 1：Woodpecker

Woodpecker 是 Milvus 2.6+ 中嵌入的写前日志（WAL）。它是为对象存储设计的云原生 WAL。

**特点：**

- **简化部署**：无需外部消息队列服务
- **成本效益**：较低的操作开销
- **高吞吐量**：针对对象存储的批量操作进行了优化
- **存储选项**：支持 MinIO/S3 兼容存储或本地文件系统
- **可用性**：在 Milvus 2.6 中引入，作为可选的 WAL

Woodpecker 在 Milvus 2.6+ 中默认启用，并使用为您的 Milvus 部署配置的相同对象存储（MinIO）。有关更多详细信息，请参阅 [Milvus Woodpecker 文档](https://milvus.io/docs/use-woodpecker.md)。

**注意事项：**

- 新技术，生产历史较少
- 可能需要根据您的特定生产要求进行评估
- 最适合优先考虑简单性和较低操作开销的部署

#### 选项 2：Kafka

Kafka 是一个分布式事件流平台，可以用作 Milvus 的消息队列。Kafka 是一个成熟的、经过实战检验的解决方案，广泛用于生产环境。

**特点：**

- **生产证明**：在企业环境中经过多年的实战检验
- **可扩展性**：通过多个代理进行水平扩展
- **生态系统**：广泛的工具、监控和操作经验
- **ACP 集成**：作为 ACP 上的服务得到支持

**设置：**

1. 按照 [Kafka 安装指南](https://docs.alauda.io/kafka/4.1/) 部署 Kafka

2. 检索 Kafka 代理服务端点：

```bash
# 获取 Kafka 代理服务端点
kubectl get svc -n kafka-namespace
```

3. 在您的 Milvus 自定义资源中使用 Kafka 代理端点（例如，`kafka://kafka-broker.kafka.svc.cluster.local:9092`）

> **重要**：尽管 Milvus CRD 字段名为 `pulsar`，但它支持 Pulsar 和 Kafka。端点方案决定使用哪种消息队列类型：
>
> - `kafka://` 用于 Kafka 代理
> - `pulsar://` 用于 Pulsar 代理

**注意事项：**

- 需要额外的操作开销来管理 Kafka 集群
- 最适合具有现有 Kafka 基础设施和专业知识的组织
- 推荐用于需要经过验证的可靠性的关键任务生产工作负载

### Milvus 部署

#### 选项 1：独立模式（开发/测试）

1. 访问 ACP Web 控制台，导航到“应用程序”→“创建”→“从目录创建”

2. 选择 Milvus Operator 图表并首先部署操作员

3. 创建一个独立模式的 Milvus 自定义资源：

```yaml
apiVersion: milvus.io/v1beta1
kind: Milvus
metadata:
  name: milvus-standalone
  namespace: milvus
  labels:
    app: milvus
spec:
  mode: standalone
  components:
    disableMetric: true
    standalone:
      ingress:
        labels:
          ingressLabel: value
        annotations:
          ingressAnnotation: value
        hosts:
          - milvus.milvus.io
      serviceLabels:
        myLabel: value
      serviceAnnotations:
        myAnnotation: value

  dependencies:
    etcd:
      inCluster:
        deletionPolicy: Delete
        pvcDeletion: true
        values:
          replicaCount: 1
    storage:
      inCluster:
        deletionPolicy: Delete
        pvcDeletion: true
        values:
          mode: standalone
          resources:
            requests:
              memory: 100Mi
          persistence:
            size: 20Gi
    rocksmq:
      persistence:
        enabled: true
        persistentVolumeClaim:
          spec:
            resources:
              limits:
                storage: 20Gi

  config:
    milvus:
      log:
        level: info
    component:
      proxy:
        timeTickInterval: 150
```

> **重要**：`components.runAsNonRoot: true` 设置启用 PodSecurity 合规性。操作员将自动将所有所需的安全上下文应用于 Milvus 容器及其依赖项（etcd、MinIO）。

#### 选项 2：集群模式（生产）

对于生产部署，请使用集群模式。以下是常见的生产配置：

**选项 2A：使用 Woodpecker 的生产**

此配置使用集群内 etcd 和 MinIO，Woodpecker 作为嵌入式消息队列：

```yaml
apiVersion: milvus.io/v1beta1
kind: Milvus
metadata:
  name: milvus-cluster
  namespace: milvus
  labels:
    app: milvus
spec:
  mode: cluster
  components:
    disableMetric: true
    proxy:
      serviceLabels:
        myLabel: value
      serviceAnnotations:
        myAnnotation: value
      ingress:
        labels:
          ingressLabel: value
        annotations:
          ingressAnnotation: value
        hosts:
          - milvus.milvus.io

  dependencies:
    # 启用 Woodpecker 作为消息队列（推荐用于集群模式）
    msgStreamType: woodpecker
    etcd:
      inCluster:
        deletionPolicy: Delete
        pvcDeletion: true
        values:
          replicaCount: 1
    storage:
      inCluster:
        deletionPolicy: Delete
        pvcDeletion: true
        values:
          mode: standalone
          persistence:
            size: 20Gi

  config:
    milvus:
      log:
        level: info
    component:
      proxy:
        timeTickInterval: 150
```

> **注意**：Woodpecker 设置为 `msgStreamType: woodpecker`。Woodpecker 使用相同的 MinIO 存储其 WAL，提供了一个更简单的部署，无需外部消息队列服务。

**选项 2B：使用外部兼容 S3 的存储的生产**

此配置使用集群内 etcd 和外部兼容 S3 的存储：

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
    # 使用集群内 etcd
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

    # 使用外部兼容 S3 的存储
    storage:
      type: S3
      external: true
      endpoint: minio-service.minio.svc:9000
      secretRef: milvus-storage-secret

  config:
    milvus:
      log:
        level: info

  # 生产资源分配
  resources:
    requests:
      cpu: "4"
      memory: "8Gi"
    limits:
      cpu: "8"
      memory: "16Gi"
```

4. 对于外部存储，创建存储秘密（如果使用集群内 MinIO，则跳过）：

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

> **注意**：如果使用集群内 MinIO（选项 2A），则跳过此步骤。该秘密仅在外部存储（选项 2B）时需要。

**选项 2C：使用 Kafka 消息队列的生产**

如果您更喜欢使用 Kafka 而不是 Woodpecker（推荐用于关键任务生产工作负载）：

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
    # 使用集群内 etcd
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

    # 使用集群内 MinIO 进行生产
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

    # 使用外部 Kafka 作为消息队列
    # 注意：该字段名为 'pulsar' 是出于历史原因，但支持 Pulsar 和 Kafka
    # 使用 'kafka://' 方案用于 Kafka，'pulsar://' 方案用于 Pulsar
    pulsar:
      external: true
      endpoint: kafka://kafka-broker.kafka.svc.cluster.local:9092

  config:
    milvus:
      log:
        level: info

  # 生产资源分配
  resources:
    requests:
      cpu: "4"
      memory: "8Gi"
    limits:
      cpu: "8"
      memory: "16Gi"
```

5. 部署并验证 Milvus 集群达到“就绪”状态：

```bash
# 检查 Milvus 自定义资源状态
kubectl get milvus -n milvus

# 检查所有 pod 是否在运行
kubectl get pods -n milvus

# 查看 Milvus 组件
kubectl get milvus -n milvus -o yaml
```

## 配置指南

### 访问 Milvus

1. 检索 Milvus 服务端点：

```bash
# 对于独立模式
kubectl get svc milvus-standalone-milvus -n milvus

# 对于集群模式
kubectl get svc milvus-cluster-milvus -n milvus
```

2. 默认 Milvus 端口为 **19530**，用于 gRPC API

3. 使用端口转发进行本地访问：

```bash
kubectl port-forward svc/milvus-standalone-milvus 19530:19530 -n milvus
```

### 开始使用 Milvus

有关详细的使用说明、API 参考和高级功能，请参阅官方 [Milvus 文档](https://milvus.io/docs/)。

官方文档涵盖：

- 基本操作（创建集合、插入向量、搜索）
- 高级功能（索引类型、分区、复制）
- 客户端 SDK（Python、Java、Go、Node.js、C#）
- 与 AI 框架的集成（LangChain、LlamaIndex、Haystack）
- 性能调优和最佳实践

#### 快速开始示例（Python）

```python
from pymilvus import MilvusClient

# 连接到 Milvus
client = MilvusClient(
    uri="http://milvus-standalone-milvus.milvus.svc.cluster.local:19530"
)

# 创建集合
client.create_collection(
    collection_name="demo_collection",
    dimension=384  # 与您的嵌入模型匹配
)

# 插入向量
vectors = [[0.1, 0.2, ...], [0.3, 0.4, ...]]  # 您的嵌入
data = [{"id": 1, "vector": v, "text": "sample"} for v in vectors]
client.insert("demo_collection", data)

# 搜索相似向量
query_vector = [[0.1, 0.2, ...]]
results = client.search(
    collection_name="demo_collection",
    data=query_vector,
    limit=5
)
```

## 故障排除

### 快速故障排除检查清单

使用此检查清单快速识别和解决常见部署问题：

| 症状                                                                     | 可能原因                          | 解决方案部分                                                                              |
| ------------------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------- |
| Pods 卡在 Pending 状态，出现 PodSecurity 违规                           | PodSecurity 策略                  | [PodSecurity Admission Violations](#podsecurity-admission-violations)                     |
| Pods 失败，出现 ErrImagePull 或 ImagePullBackOff                        | 错误的注册表或身份验证          | [Image Pull Authentication Errors](#image-pull-authentication-errors)                     |
| PVCs 卡在 Pending 状态，出现“等待消费者”                                 | 存储类绑定模式                    | [PVC Pending - Storage Class Binding Mode](#pvc-pending---storage-class-binding-mode)     |
| etcd Pods 失败，出现“无效的引用格式”                                   | 镜像前缀错误                      | [etcd Invalid Image Name Error](#etcd-invalid-image-name-error)                           |
| 多附加卷错误                                                            | 存储类访问模式                   | [Multi-Attach Volume Errors](#multi-attach-volume-errors)                                 |
| Milvus panic：MinIO PutObjectIfNoneMatch 失败                           | MinIO PVC 损坏                    | [MinIO Storage Corruption Issues](#minio-storage-corruption-issues)                       |
| Milvus 独立 Pod 崩溃（退出代码 134）                                    | 健康检查和非根兼容性             | [Milvus Standalone Pod Crashes (Exit Code 134)](#milvus-standalone-pod-crashes-exit-code-134) |
| Milvus 集群 Pod panic，出现“mq rocksmq 仅在独立模式下有效”             | 消息队列类型不正确                | [Cluster Mode Message Queue Configuration](#cluster-mode-message-queue-configuration)     |
| 无法连接到 Milvus 服务                                                  | 网络或服务问题                    | [Connection Refused](#connection-refused)                                                 |
| 向量搜索性能差                                                        | 索引或资源问题                    | [Poor Search Performance](#poor-search-performance)                                       |

### 常见问题

#### Pod 无法启动

**症状**：Milvus Pods 卡在 Pending 或 CrashLoopBackOff 状态

**解决方案**：

- 检查资源分配（内存和 CPU 限制）
- 验证存储类是否可用
- 确保镜像拉取秘密配置正确
- 查看 Pod 日志：`kubectl logs -n milvus <pod-name>`

#### 连接被拒绝

**症状**：无法连接到 Milvus 服务

**解决方案**：

- 验证 Milvus 服务是否在运行：`kubectl get svc -n milvus`
- 检查网络策略是否允许流量
- 如果使用本地访问，请确保端口转发处于活动状态
- 验证没有防火墙规则阻止端口 19530

#### 搜索性能差

**症状**：向量搜索查询缓慢

**解决方案**：

- 为您的集合创建适当的索引
- 增加查询节点资源
- 使用分区限制搜索范围
- 优化搜索参数（nprobe、ef）
- 考虑在大规模部署中使用 GPU 加速索引

#### PodSecurity Admission Violations

**症状**：Milvus Pods 因 PodSecurity 错误而无法创建：

```
Error creating: pods is forbidden: violates PodSecurity "restricted:latest":
- runAsNonRoot != true (pod or container must set securityContext.runAsNonRoot=true)
```

**原因**：Milvus 自定义资源缺少 `components.runAsNonRoot: true` 设置。

**解决方案**：将 `components.runAsNonRoot: true` 添加到您的 Milvus 自定义资源中：

```yaml
spec:
  components:
    runAsNonRoot: true  # PodSecurity 合规性所需
    image: build-harbor.alauda.cn/middleware/milvus:v2.6.7
```

Milvus operator 将自动应用所有所需的安全上下文：

- `runAsNonRoot: true`（Pod 和容器级别）
- `runAsUser: 1000`（与上游匹配）
- `allowPrivilegeEscalation: false`
- `capabilities.drop: [ALL]`
- `seccompProfile.type: RuntimeDefault`

这适用于：

- Milvus 独立/集群部署
- 初始化容器（配置）
- etcd StatefulSets
- MinIO 部署

**验证**：

```bash
# 检查所有 Pods 是否在运行
kubectl get pods -n <namespace>

# 验证安全上下文是否已应用
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.securityContext}'
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.containers[*].securityContext}'
```

#### Milvus 独立 Pod 崩溃（退出代码 134）

**症状**：Milvus 独立 Pod 反复崩溃，退出代码为 134（SIGABRT）。

**原因**：这是 Milvus v2.6.7 在 PodSecurity "restricted" 策略下运行时的已知兼容性问题。此问题已在更新的 Milvus operator 镜像中修复。

**解决方案**：

1. 确保您使用的是更新的 Milvus operator 镜像（v1.3.5-6e82465e 或更高版本）
2. 将 `components.runAsNonRoot: true` 添加到您的 Milvus 自定义资源中：

```yaml
spec:
  components:
    runAsNonRoot: true  # PodSecurity 合规性所需
    image: build-harbor.alauda.cn/middleware/milvus:v2.6.7
```

3. 如果您之前没有此设置，请删除并重新创建 Milvus CR：

```bash
kubectl delete milvus <name> -n <namespace>
kubectl apply -f <your-milvus-cr>.yaml
```

操作员将自动处理所有 PodSecurity 要求，当设置 `runAsNonRoot: true` 时。

#### 集群模式消息队列配置

**症状**：Milvus 集群组件 Pods（mixcoord、datanode、proxy、querynode）因以下错误而 panic：

```
panic: mq rocksmq is only valid in standalone mode
```

**原因**：Milvus 自定义资源配置为 `msgStreamType: rocksmq` 用于集群模式。`rocksmq` 消息流类型仅在独立模式下有效。对于集群模式，您必须使用 `woodpecker`。

**解决方案**：将 `dependencies.msgStreamType` 从 `rocksmq` 更改为 `woodpecker`：

**不正确（用于集群模式）**：

```yaml
spec:
  dependencies:
    msgStreamType: rocksmq  # 错误 - 仅适用于独立模式
```

**正确（用于集群模式）**：

```yaml
spec:
  dependencies:
    msgStreamType: woodpecker  # 在集群模式下使用 woodpecker
```

**使用 Woodpecker 的完整集群模式示例**：

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
    msgStreamType: woodpecker  # 集群模式下使用 woodpecker
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

在更正配置后，删除并重新创建 Milvus 实例：

```bash
kubectl delete milvus <name> -n <namespace>
kubectl apply -f <your-milvus-cr>.yaml
```

**消息队列类型参考**：

- **独立模式**：使用 `msgStreamType: rocksmq`（或省略，默认为 rocksmq）
- **集群模式**：使用 `msgStreamType: woodpecker`
- **外部 Kafka/Pulsar**：使用 `dependencies.pulsar.external.endpoint`，并使用适当的方案

#### PVC Pending - 存储类绑定模式

**症状**：持久卷声明保持在 Pending 状态，事件如下：

```
Warning  ProvisioningFailed  persistentvolumeclaim  <storage-class>
storageclass.storage.k8s.io "<storage-class>" is waiting for a consumer to be found
```

**原因**：某些存储类（例如，Topolvm）使用 `volumeBindingMode: WaitForFirstConsumer`，这会延迟 PVC 绑定，直到调度使用 PVC 的 Pod。然而，一些控制器和操作员可能在此延迟绑定模式下存在问题。

**解决方案**：在 Milvus 部署中使用 `volumeBindingMode: Immediate` 的存储类：

1. **列出可用的存储类**：

```bash
kubectl get storageclasses
```

2. **检查存储类绑定模式**：

```bash
kubectl get storageclass <storage-class-name> -o jsonpath='{.volumeBindingMode}'
```

3. **在您的 Milvus CR 中使用 Immediate 绑定存储类**：

```yaml
dependencies:
  etcd:
    inCluster:
      values:
        persistence:
          storageClass: <immediate-binding-storage-class>  # 例如，jpsu2-rook-cephfs-sc
  storage:
    inCluster:
      values:
        persistence:
          storageClass: <immediate-binding-storage-class>
```

常见的具有 Immediate 绑定的存储类包括基于 CephFS 的存储类（例如，`jpsu2-rook-cephfs-sc`）。

#### 多附加卷错误

**症状**：Pods 失败，出现多附加错误：

```
Warning  FailedMount  Unable to attach or mount volumes:
unmounted volumes=[<volume-name>], unattached volumes=[<volume-name>]:
timed out waiting for the condition
Multi-Attach error: Volume is already used by pod(s) <pod-name>
```

**原因**：当多个 Pods 尝试同时使用同一个持久卷，而存储类不支持读写多（RWX）访问模式时，会发生这种情况。

**解决方案**：验证您的存储类是否支持所需的访问模式：

1. **检查存储类访问模式**：

```bash
kubectl get storageclass <storage-class-name> -o jsonpath='{.allowedTopologies}'
```

2. **为您的部署使用适当的存储类**：
   - **独立模式**：ReadWriteOnce (RWO) 足够
   - **集群模式**：如果多个 Pods 需要共享访问，请使用 ReadWriteMany (RWX)，或者确保每个 Pod 拥有自己的 PVC

3. **对于 CephFS 存储类**，RWX 通常得到支持，并推荐用于 Milvus 集群部署。

#### MinIO 存储损坏问题

**症状**：Milvus 独立 Pod 崩溃，panic 与 MinIO 相关：

```
panic: CheckIfConditionWriteSupport failed: PutObjectIfNoneMatch not supported or failed.
BucketName: milvus-test, ObjectKey: files/wp/conditional_write_test_object,
Error: Resource requested is unreadable, please reduce your request rate
```

或 MinIO 日志显示：

```
Error: Following error has been printed 3 times.. UUID on positions 0:0 do not match with
expected... inconsistent drive found
Error: Storage resources are insufficient for the write operation
```

**原因**：MinIO 持久卷声明（PVC）因先前部署而损坏。这可能发生在：

- MinIO 部署被删除但 PVC 被保留
- 多个 MinIO 部署使用同一 PVC
- MinIO 数据因不完整的写入或崩溃而变得不一致

**解决方案**：通过卸载 Helm 发布并删除 PVC 完全重新创建 MinIO：

```bash
# 1. 检查 MinIO Helm 发布
helm list -n <namespace>

# 2. 卸载 MinIO Helm 发布（默认保留 PVC）
helm uninstall milvus-<name>-minio -n <namespace>

# 3. 列出 PVC 以查找 MinIO PVC
kubectl get pvc -n <namespace> | grep minio

# 4. 删除损坏的 MinIO PVC
kubectl delete pvc -n <namespace> milvus-<name>-minio

# 5. 删除 Milvus CR 以触发完全重新创建
kubectl delete milvus <name> -n <namespace>

# 6. 重新创建 Milvus 实例
kubectl apply -f <your-milvus-cr>.yaml
```

Milvus operator 将自动：

- 使用 Helm 部署一个全新的 MinIO 实例
- 创建一个新的 PVC，数据干净
- 正确初始化 MinIO 存储桶

**验证**：

```bash
# 检查新的 MinIO Pod 是否在运行
kubectl get pods -n <namespace> -l app.kubernetes.io/instance=<name>

# 验证 MinIO Helm 发布是否已部署
helm list -n <namespace> | grep minio

# 检查 Milvus 是否可以连接到 MinIO
kubectl logs -n <namespace> deployment/milvus-<name>-milvus-standalone | grep -i minio
```

> **注意**：在遇到 MinIO 损坏时，始终删除 Helm 发布和 PVC。仅删除部署或 Pod 不会修复基础数据损坏。

### 部署验证

在部署 Milvus 后，验证部署是否成功：

```bash
# 1. 检查 Milvus 自定义资源状态
# 应显示“健康”状态
kubectl get milvus -n <namespace>

# 2. 检查所有 Pods 是否在运行
# 所有 Pods 应处于“运行”状态，没有重启
kubectl get pods -n <namespace>

# 3. 验证所有依赖项是否健康
# etcd 应为 1/1 就绪
kubectl get pod -n <namespace> -l app.kubernetes.io/component=etcd

# MinIO 应在运行
kubectl get pod -n <namespace> | grep minio

# 4. 检查服务是否已创建
kubectl get svc -n <namespace>

# 5. 验证 PVC 是否已绑定
kubectl get pvc -n <namespace>

# 6. 检查 MinIO 健康状况以防损坏
kubectl logs -n <namespace> deployment/milvus-<name>-minio | grep -i "error\|inconsistent\|corrupt"
# 应返回没有错误

# 7. 检查 Milvus 日志以查找错误
kubectl logs -n <namespace> deployment/milvus-<name>-milvus-standalone -c milvus --tail=50 | grep -i "panic\|fatal\|error"

# 8. 端口转发并测试连接
kubectl port-forward svc/milvus-<name>-milvus 19530:19530 -n <namespace>

# 在另一个终端中测试连接
nc -zv localhost 19530
```

健康的独立部署的预期输出：

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

**验证 PodSecurity 合规性**：

```bash
# 检查 Pod 安全上下文（所有应显示 PodSecurity 合规设置）
kubectl get pod milvus-standalone-milvus-standalone-<suffix> -n milvus -o jsonpath='{.spec.securityContext}'
# 输出应包括：{"runAsNonRoot":true,"runAsUser":1000}

kubectl get pod milvus-standalone-milvus-standalone-<suffix> -n milvus -o jsonpath='{.spec.containers[0].securityContext}'
# 输出应包括：{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"seccompProfile":{"type":"RuntimeDefault"}}
```

### 诊断命令

检查 Milvus 健康状况：

```bash
# 检查所有 Milvus 组件
kubectl get milvus -n milvus -o wide

# 检查 Pod 状态
kubectl get pods -n milvus

# 检查组件日志
kubectl logs -n milvus <pod-name> -c milvus

# 描述 Milvus 资源
kubectl describe milvus <milvus-name> -n milvus
```

验证依赖项：

```bash
# 检查集群内 etcd Pods
kubectl get pods -n milvus -l app=etcd

# 检查集群内 MinIO Pods
kubectl get pods -n milvus -l app=minio

# 检查 Kafka 连接性（如果使用 Kafka）
kubectl exec -it <milvus-pod> -n milvus -- nc -zv <kafka-broker> 9092
```

## 最佳实践

### 集合设计

### ACP 4.2+ 的 GPU 部署指南

#### 概述

Milvus 支持 GPU 加速的向量相似性搜索和索引操作。本指南涵盖在 Alauda 容器平台（ACP）版本 4.2.0 或更高版本上部署启用 GPU 的 Milvus 实例。

#### 先决条件

- **GPU 节点**：具有 NVIDIA GPU（Tesla V100、A100 等）的 Kubernetes 节点
- **存储类**：使用具有可用容量的存储类（例如，`sc-topolvm`）
- **容器注册表访问**：确保集群可以访问 `192.168.129.232/middleware/milvus` 注册表
- **Milvus Operator**：版本 1.3.5 或更高，支持 GPU

#### 启用 GPU 的 Milvus 镜像

使用来自您内部注册表的启用 GPU 的 Milvus 镜像：

```yaml
image: 192.168.129.232/middleware/milvus:v2.6.7-gpu-9b18d4ae
```

此镜像包括：

- 用于 GPU 加速的 CUDA 运行时
- 启用 GPU 的索引和搜索算法
- 针对 Tesla V100 GPU 的向量操作进行了优化

#### 资源要求

| 部署模式     | 最低 CPU | 最低内存 | GPU    | 推荐用途               |
| ------------ | -------- | -------- | ------ | ---------------------- |
| **独立模式** | 4 核心   | 8GB RAM  | 1 GPU  | 开发、测试             |
| **集群模式** | 16+ 核心 | 32GB+ RAM| 1+ GPU | 生产、大规模           |

**重要**：GPU 分配需要：

- `nvidia.com/gpu: 1` 资源请求和限制
- `nvidia.com/gpu.product` 节点选择器用于 GPU 类型

#### 部署示例：启用 GPU 的集群模式

创建一个名为 `milvus-gpu-cluster.yaml` 的文件：

```yaml
apiVersion: milvus.io/v1beta1
kind: Milvus
metadata:
  name: milvus-gpu
  namespace: milvus-gpu
  labels:
    app: milvus
spec:
  mode: cluster
  components:
    disableMetric: true
    indexNode:
      replicas: 1
      resources:
        limits:
          nvidia.com/gpu: "1"
    queryNode:
      replicas: 1
      resources:
        limits:
          nvidia.com/gpu: "1"
    proxy:
      serviceLabels:
        myLabel: value
      serviceAnnotations:
        myAnnotation: value
      ingress:
        labels:
          ingressLabel: value
        annotations:
          ingressAnnotation: value
        hosts:
          - milvus.milvus.io

  dependencies:
    msgStreamType: woodpecker
    etcd:
      inCluster:
        deletionPolicy: Delete
        pvcDeletion: true
        values:
          replicaCount: 1
    storage:
      inCluster:
        deletionPolicy: Delete
        pvcDeletion: true
        values:
          mode: standalone
          persistence:
            size: 20Gi

  config:
    milvus:
      log:
        level: info
    component:
      proxy:
        timeTickInterval: 150
```

> **注意**：此示例为 indexNode 和 queryNode 分配 1 个 GPU。根据您的 GPU 节点容量和工作负载要求调整 `nvidia.com/gpu` 资源限制。

#### 验证 GPU 利用率

部署后，验证 Milvus 是否正在使用 GPU：

**1. 检查 Milvus 日志**：GPU 加速操作将在日志中出现

```bash
kubectl logs -n milvus-gpu deployment/milvus-gpu-milvus-standalone -c milvus
```

**2. 检查 GPU 资源**：验证 GPU 是否分配给 Pod

```bash
kubectl get pod -n milvus-gpu -o jsonpath='{.items[0].spec.containers[0].resources.limits}'
```

**3. 端口转发并测试**：本地访问服务以进行测试

```bash
kubectl port-forward -n milvus-gpu svc/milvus-gpu-milvus 19530:19530 &
```

**4. 创建启用 GPU 的索引**：创建一个集合，使用 GPU 索引类型

```python
from pymilvus import MilvusClient

client = MilvusClient(uri="http://localhost:19530")

# 创建带有 GPU 索引的集合
client.create_collection(
    collection_name="gpu_collection",
    dimension=768,
    index_type="GPU_IVF_FLAT",
    metric_type="L2"
)
```

#### GPU 配置注意事项

- **GPU 的索引类型**：
  - `GPU_IVF_FLAT`：快速搜索，较低内存使用
  - `GPU_IVF_PQ`：性能和准确性的平衡
  - `GPU_BRUTE_FORCE`：强制 GPU 进行暴力搜索

- **查询节点 GPU 设置**：根据可用 GPU 内存调整缓存大小

#### 常见 GPU 部署问题及解决方案

| 问题                              | 解决方案                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| **镜像拉取错误**                  | 使用内部注册表（`192.168.129.232`）而不是 Docker Hub                              |
| **未找到 GPU 设备**               | GPU 已分配给 Pod，但在容器中不可见（预期用于 GPU Milvus 镜像）                      |
| **Pod 卡在 ContainerCreating**    | 检查镜像拉取进度和存储供应                                                            |
| **初始化缓慢**                    | GPU 镜像较大（4GB+），允许镜像拉取时间                                               |

### 集合设计

- **模式规划**：在创建集合之前定义适当的向量维度和字段类型
- **索引选择**：根据用例选择索引类型（HNSW 适合高召回率，IVF 平衡性能）
- **分区**：使用分区逻辑分隔数据，提高搜索性能
- **一致性级别**：设置适当的一致性级别（强、一致、最终、会话）

### 资源优化

- **内存大小**：为最佳性能分配内存为向量数据集大小的 2-4 倍
- **查询节点**：根据搜索 QPS 要求扩展查询节点
- **索引构建**：为大型集合使用专用索引节点
- **监控**：实施监控以跟踪资源利用率和查询延迟

### 安全考虑

- **网络策略**：限制对 Milvus 服务的网络访问
- **身份验证**：为生产部署启用 TLS 和身份验证
- **秘密管理**：使用 Kubernetes 秘密存储敏感凭据
- **RBAC**：为 Milvus operator 实施基于角色的访问控制

### 备份策略

- **etcd 备份**：定期备份集群内 etcd 持久卷
- **MinIO 复制**：在 MinIO 上启用复制或使用冗余存储后端
- **集合导出**：定期导出集合数据以进行灾难恢复
- **测试**：定期测试恢复程序

## 参考

### 配置参数

**Milvus 部署：**

- `mode`：部署模式（独立、集群）
- `components.image`：Milvus 容器镜像
- `dependencies.msgStreamType`：消息队列类型 - `woodpecker`（推荐，嵌入式）、`pulsar`（外部）或 `kafka`（外部）
- `dependencies.etcd`：元数据的 etcd 配置
- `dependencies.storage`：对象存储配置
- `dependencies.pulsar`：外部消息队列配置（字段名为 `pulsar` 是出于历史原因，但支持 Pulsar 和 Kafka）
- `config.milvus`：Milvus 特定配置

**消息队列选项：**

- **Woodpecker**（`msgStreamType: woodpecker`）：Milvus 2.6+ 中嵌入的 WAL，使用对象存储，支持独立和集群模式
- **Kafka**（通过 `pulsar.external.endpoint`）：外部 Kafka 服务，将端点设置为 `kafka://kafka-broker.kafka.svc.cluster.local:9092`
- **Pulsar**（通过 `pulsar.external.endpoint`）：外部 Pulsar 服务，将端点设置为 `pulsar://pulsar-broker.pulsar.svc.cluster.local:6650`

> **重要**：CRD 字段名为 `pulsar` 是出于向后兼容性，但您可以通过使用适当的端点方案（`pulsar://` 或 `kafka://`）配置 Pulsar 或 Kafka。

**索引类型：**

- **FLAT**：精确搜索，100% 召回率，适用于大型数据集时较慢
- **IVF_FLAT**：平衡性能和准确性
- **IVF_SQ8**：压缩向量，较低内存使用
- **HNSW**：高性能，高召回率，较高内存使用
- **DISKANN**：用于非常大数据集的基于磁盘的索引

### 有用链接

- [Milvus 文档](https://milvus.io/docs/) - 综合使用指南和 API 参考
- [Milvus Woodpecker 指南](https://milvus.io/docs/use-woodpecker.md) - Woodpecker WAL 文档
- [Milvus Bootcamp](https://github.com/milvus-io/bootcamp) - 教程笔记和示例
- [PyMilvus SDK](https://milvus.io/api-reference/pymilvus/v2.4.x/About.md) - Python 客户端文档
- [Milvus Operator GitHub](https://github.com/zilliztech/milvus-operator) - 操作员源代码
- [ACP Kafka 文档](https://docs.alauda.io/kafka/4.2/) - ACP 上的 Kafka 安装

## 总结

本指南提供了在 Alauda 容器平台上实施 Milvus 的综合说明。该解决方案提供了一个生产就绪的向量数据库，用于 AI/ML 应用程序，使得：

- **可扩展的向量搜索**：十亿级相似性搜索，毫秒级延迟
- **灵活的部署**：支持开发（独立）和生产（集群）模式
- **云原生架构**：Kubernetes 原生设计，具有自动扩展和容错能力
- **丰富的 AI 集成**：与流行的 ML 框架和 LLM 平台无缝集成

通过遵循这些实践，组织可以构建强大的 AI 应用程序，包括语义搜索、推荐系统、RAG 应用和图像检索，同时保持生产部署所需的可扩展性和可靠性。
