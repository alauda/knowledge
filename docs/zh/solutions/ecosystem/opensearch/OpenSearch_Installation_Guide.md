---
products:
  - Alauda Application Services
kind:
  - Solution
id: KB260300008
sourceSHA: 55617f25eeb466933058c03107fb2a4d6e462e723ff0f03b05d20d3f4e2ceb06
---

# OpenSearch 安装指南

## 概述

OpenSearch 是一个由社区驱动的开源搜索和分析套件，源自 Elasticsearch 和 Kibana。本指南涵盖在 Alauda 容器平台上部署 OpenSearch Kubernetes Operator 和创建 OpenSearch 集群实例。

### 支持的版本

| 组件                   | 支持的版本        |
| --------------------- | ------------------ |
| OpenSearch            | 2.19.3, 3.3.1      |
| OpenSearch Dashboards | 2.19.3, 3.3.0      |
| OpenSearch Operator   | 2.8.0              |

## 先决条件

- 支持动态供给的 StorageClass（用于持久卷）
- 至少有 3 个节点的 ACP 集群用于生产部署（以维持集群管理器的法定人数）
- （可选）用于外部访问的 LoadBalancer 或 Ingress Controller

## 安装 OpenSearch Operator

1. 从 [Alauda Cloud Console](https://cloud.alauda.io/) Marketplace 下载 **OpenSearch Operator** 插件。
2. 按照 [Upload Packages](https://docs.alauda.io/container_platform/4.2/extend/upload_package.html) 指南将插件上传到集群。
3. 导航到管理员 -> Marketplace -> OperatorHub。
4. 找到 **OpenSearch Cluster** 并点击安装。

## 快速开始：创建 OpenSearch 实例

本节演示如何快速部署一个带有 OpenSearch Dashboards 的 OpenSearch 集群。

### 基本集群配置

部署一个简单的 3 节点 OpenSearch 集群：

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

> \[!WARNING]
> 根据 [如何设置和更新 OpenSearch 管理员密码](./How_to_update_opensearch_admin_password.md) 更改默认密码以用于生产。

### 验证部署

检查 OpenSearch 集群的状态：

```bash
# 检查 pods
kubectl get pods -n opensearch-demo

# 检查集群健康
kubectl exec -n opensearch-demo my-opensearch-nodes-0 -- curl -sk -u admin:<password> 'https://localhost:9200/_cluster/health?pretty'
```

> `admin` 用户的默认密码是 `admin`。

### 访问 OpenSearch Dashboards

1. 设置端口转发：

   ```bash
    kubectl -n opensearch-demo port-forward service/my-opensearch-dashboards 5601:5601
   ```

2. 在浏览器中打开 <http://127.0.0.1:5601>。

3. 使用凭据登录：

   - 用户名：`admin`
   - 密码：`<password>`

   > `admin` 用户的默认密码是 `admin`。

## 理解节点角色

OpenSearch 支持多种节点角色（也称为节点类型），这些角色决定了每个节点在集群中执行的功能。正确的角色分配对集群的性能和稳定性至关重要。

默认情况下，每个节点都是集群管理器、数据、摄取和协调节点。决定节点数量、分配节点类型以及选择每种节点类型的硬件取决于您的用例。您必须考虑诸如希望保留数据的时间、文档的平均大小、典型工作负载（索引、搜索、聚合）、预期的性价比、风险承受能力等因素。

### 可用节点类型

下表提供了节点类型的描述和生产部署的最佳实践：

| 节点类型               | 描述                                                                                                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`cluster_manager`** | 管理集群的整体操作并跟踪集群状态。这包括创建和删除索引、跟踪加入和离开集群的节点、检查集群中每个节点的健康状况（通过运行 ping 请求）以及将分片分配给节点。 |
| **`data`**            | 存储和搜索数据。对本地分片执行所有与数据相关的操作（索引、搜索、聚合）。这些是集群的工作节点，需要比任何其他节点类型更多的磁盘空间。                                                                                      |
| **`ingest`**          | 在将数据存储到集群之前对其进行预处理。运行摄取管道，在将数据添加到索引之前对其进行转换。                                                                                                                                                                  |
| **`coordinating`**    | 将客户端请求委派给数据节点上的分片，收集并将结果聚合成一个最终结果，并将该结果发送回客户端。                                                                                                                                       |
| **`dynamic`**         | 将特定节点委派给自定义工作，例如机器学习（ML）任务，防止消耗数据节点的资源，从而不影响任何 OpenSearch 功能。                                                                                                     |
| **`warm`**            | 提供对可搜索快照的访问。采用技术，如频繁缓存使用的段并删除最少使用的数据段，以访问可搜索快照索引（存储在远程长期存储源中，例如 Amazon S3 或 Google Cloud Storage）。      |
| **`search`**          | 搜索节点是专用节点，仅托管搜索副本分片，帮助将搜索工作负载与索引工作负载分开。                                                                                                                                                                     |

> \[!NOTE]
> 默认情况下，没有明确指定角色的节点将成为仅协调节点。要创建仅协调节点，请将 `roles` 字段设置为空数组 `[]`。

### 容量规划和基准测试

在评估您的需求后，我们建议您使用基准测试工具，如 [OpenSearch Benchmark](https://github.com/opensearch-project/opensearch-benchmark)，来配置一个小型样本集群，并在不同的工作负载和配置下运行测试。比较和分析这些测试的系统和查询指标，以设计最佳架构。

### 何时使用每个角色

#### 小型集群（开发/测试）

对于资源有限的小型集群，将角色组合在同一节点上：

```yaml
nodePools:
  - component: all-in-one
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
      - "ingest"
```

#### 中型集群（生产）

为更好的稳定性分离集群管理器和数据角色：

```yaml
nodePools:
  # 专用集群管理器节点
  - component: masters
    replicas: 3
    diskSize: "10Gi"
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
  
  # 专用数据节点
  - component: data
    replicas: 3
    diskSize: "100Gi"
    persistence:
      pvc:
        accessModes:
        - ReadWriteOnce
        storageClass: sc-topolvm
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

#### 大型集群（高规模生产）

完全角色分离以实现最大性能和隔离：

```yaml
nodePools:
  # 专用集群管理器节点
  - component: masters
    replicas: 3
    diskSize: "30Gi"
    persistence:
      pvc:
        accessModes:
        - ReadWriteOnce
        storageClass: sc-topolvm
    resources:
      requests:
        memory: "4Gi"
        cpu: "1000m"
      limits:
        memory: "4Gi"
        cpu: "1000m"
    roles:
      - "cluster_manager"
  
  # 热数据节点（频繁访问，快速存储）
  - component: hot-data
    replicas: 5
    diskSize: "500Gi"
    persistence:
      pvc:
        accessModes:
        - ReadWriteOnce
        storageClass: sc-topolvm
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
  
  # 仅协调节点（负载均衡）
  - component: coordinators
    replicas: 2
    diskSize: "10Gi"
    persistence:
      pvc:
        accessModes:
        - ReadWriteOnce
        storageClass: sc-topolvm
    resources:
      requests:
        memory: "4Gi"
        cpu: "2000m"
      limits:
        memory: "4Gi"
        cpu: "2000m"
    roles: []  # 空角色 = 仅协调
```

### 节点角色的最佳实践

| 指导原则                  | 建议                                                   |
| ------------------------ | ------------------------------------------------------ |
| 集群管理器数量            | 始终使用 **奇数**（3、5、7）以维持法定人数            |
| 专用集群管理器            | 推荐用于数据节点超过 5 个的集群                      |
| 数据节点扩展              | 根据数据量和查询负载水平扩展                          |
| JVM 堆大小                | 设置为 **容器内存的一半**，最大 32GB                   |
| 协调节点                  | 在大型集群中使用，以减轻数据节点的请求路由负担        |

## 在受限命名空间中部署（Pod 安全准入）

默认情况下，OpenSearch Operator 创建没有安全上下文限制的初始化容器以执行：

1. 设置 `vm.max_map_count` 内核参数
2. 通过 `chown` 修复卷权限

在具有受限 Pod 安全准入（PSA）的命名空间中部署 OpenSearch 时，需要额外的配置。

### 解决方案

#### 步骤 1：预配置内核参数

由于 operator 无法设置 `vm.max_map_count`，请在所有工作节点上进行配置：

```bash
# 在每个工作节点上
sysctl -w vm.max_map_count=262144

# 使其持久化
echo "vm.max_map_count=262144" >> /etc/sysctl.conf
```

#### 步骤 2：使用安全上下文创建 OpenSearch 集群

使用适当的安全上下文部署集群：

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
    
    # 禁用需要 root 的初始化容器
    setVMMaxMapCount: false
    
    # Pod 级安全上下文
    podSecurityContext:
      runAsUser: 1000
      runAsGroup: 1000
      runAsNonRoot: true
      fsGroup: 1000
      seccompProfile:
        type: RuntimeDefault
    
    # 容器级安全上下文
    securityContext:
      allowPrivilegeEscalation: false
      privileged: false
      runAsNonRoot: true
      runAsUser: 1000
      runAsGroup: 1000
      capabilities:
        drop:
          - ALL
      readOnlyRootFilesystem: false  # OpenSearch 需要写入某些路径
  
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
    
    # Dashboards 安全上下文
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

当初始化容器被禁用时，您必须确保卷可由 UID 1000 写入。`fsGroup` 设置会自动处理此问题：

```yaml
podSecurityContext:
  fsGroup: 1000  # Kubernetes 将自动将卷的所有权更改为该组
```

如果使用的 StorageClass 不支持 fsGroup，请确保底层存储预先配置了正确的权限。

## 配置参考

### 常见配置选项

| 字段                                  | 默认值  | 描述                                                            |
| ------------------------------------- | ------- | ---------------------------------------------------------------- |
| `spec.general.version`                | -       | OpenSearch 版本（必需）                                          |
| `spec.general.httpPort`               | `9200`  | HTTP API 端口                                                    |
| `spec.general.setVMMaxMapCount`       | `false` | 启用 vm.max_map_count 初始化容器                               |
| `spec.nodePools[].replicas`           | -       | 节点池中的节点数量                                              |
| `spec.nodePools[].diskSize`           | -       | 每个节点的存储大小                                            |
| `spec.nodePools[].jvm`                | auto    | JVM 堆设置（例如，`-Xmx4G -Xms4G`）                              |
| `spec.nodePools[].roles`              | -       | 节点角色（cluster_manager、data、ingest，或为空以协调）       |
| `spec.dashboards.enable`              | `false` | 启用 OpenSearch Dashboards                                       |
| `spec.dashboards.version`             | -       | Dashboards 版本                                                 |
| `spec.security.tls.transport.generate`| `false` | 自动生成传输 TLS 证书                                          |
| `spec.security.tls.http.generate`     | `false` | 自动生成 HTTP TLS 证书                                          |

### 自定义 OpenSearch 配置

通过 `additionalConfig` 添加自定义 OpenSearch 设置：

```yaml
spec:
  general:
    additionalConfig:
      # 应用于所有节点的全局设置
      indices.query.bool.max_clause_count: "2048"
  nodePools:
    - component: data
      additionalConfig:
        # 节点池特定设置
        node.attr.zone: zone-a
      roles:
        - "data"
```

## 参考

1. [OpenSearch Kubernetes Operator 文档](https://github.com/opensearch-project/opensearch-k8s-operator/blob/main/docs/userguide/main.md)
2. [OpenSearch 官方文档](https://docs.opensearch.org/3.3/about/)
3. [如何设置和更新 OpenSearch 管理员密码](./How_to_update_opensearch_admin_password.md)
4. [OpenSearch 节点角色](https://opensearch.org/docs/latest/tuning-your-cluster/#node-roles)
