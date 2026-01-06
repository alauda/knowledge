---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
id: KB260100002
sourceSHA: 03b42f7db958b3766672b33d6c2e714c92726dc72d36a96ac4d8d8bb6893cbcb
---

# lakeFS 数据版本控制解决方案指南

## 背景

### 挑战

现代数据湖在管理数据版本控制、可重现性和协作方面面临重大挑战。传统方法往往导致：

- **数据质量问题**：难以跟踪更改并回滚有问题的数据更新
- **可重现性问题**：无法重现特定数据状态以进行分析或调试
- **协作冲突**：多个团队在没有适当隔离的情况下处理相同数据
- **测试复杂性**：在应用于生产之前测试数据转换的挑战

### 解决方案

lakeFS 为数据湖提供类似 Git 的版本控制，能够实现：

- **分支和合并**：在分支中隔离更改并安全合并
- **数据版本控制**：以提交类似的语义跟踪数据更改
- **可重现的分析**：引用特定数据版本以获得一致的结果
- **数据的 CI/CD**：为数据管道实施测试和验证工作流

## 环境信息

适用版本：>=ACP 4.1.0，lakeFS: >=1.70.1

## 快速参考

### 关键概念

- **仓库**：跟踪数据更改的分支、标签和提交的集合
- **分支**：仓库内的一个隔离开发线
- **提交**：特定时间点的仓库快照
- **合并**：将一个分支的更改合并到另一个分支

### 常见用例

| 场景                          | 推荐方法                             | 章节参考                                   |
| ----------------------------- | ------------------------------------ | ------------------------------------------- |
| **数据版本控制**              | 创建仓库并提交更改                   | [基本操作](https://docs.lakefs.io/)        |
| **协作开发**                  | 使用功能分支进行隔离工作             | [分支策略](https://docs.lakefs.io/)        |
| **数据质量验证**              | 实施预提交钩子和测试                 | [数据验证](https://docs.lakefs.io/)       |
| **生产部署**                  | 将验证后的更改合并到主分支           | [生产工作流](https://docs.lakefs.io/)     |

## 先决条件

在实施 lakeFS 之前，请确保您具备：

- ACP v4.1.0 或更高版本
- 用于元数据存储的 PostgreSQL 实例
- 对象存储后端（推荐使用 Ceph RGW 或 MinIO）
- 对 Git 工作流和数据湖概念的基本理解

### 存储要求

- **PostgreSQL**：元数据的最低 10GB 存储
- **对象存储**：足够的容量以存储您的数据资产
- **备份策略**：定期备份 PostgreSQL 数据库

## 安装指南

### 图表上传

从 Alauda 客户门户的 Marketplace 下载 lakeFS 图表，并将 lakeFS 图表上传到您的 ACP 目录。要下载 `violet` 工具并查找使用信息，请参阅 [Violet CLI 工具文档](https://docs.alauda.io/container_platform/4.1/ui/cli_tools/violet.html)：

```bash
CHART=lakefs.ALL.1.7.9.tgz
ADDR="https://your-acp-domain.com"
USER="admin@cpaas.io"
PASS="your-password"

violet push $CHART \
--platform-address "$ADDR" \
--platform-username "$USER" \
--platform-password "$PASS"
```

### 后端存储配置

#### 推荐：Ceph RGW 设置

1. 按照 [Ceph 安装指南](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/installation/create_service_stand.html) 部署 Ceph 存储系统

2. [创建 Ceph 对象存储用户](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/create_object_user):

```yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata:
  name: lakefs-user
  namespace: rook-ceph
spec:
  store: my-store
  displayName: lakefs-storage-pool
  quotas:
    maxBuckets: 100
    maxSize: -1
    maxObjects: -1
  capabilities:
    user: "*"
    bucket: "*"
```

3. 检索访问凭证：

```bash
user_secret=$(kubectl -n rook-ceph get cephobjectstoreuser lakefs-user -o jsonpath='{.status.info.secretName}')
ACCESS_KEY=$(kubectl -n rook-ceph get secret $user_secret -o jsonpath='{.data.AccessKey}' | base64 -d)
SECRET_KEY=$(kubectl -n rook-ceph get secret $user_secret -o jsonpath='{.data.SecretKey}' | base64 -d)
```

#### 替代：MinIO 设置

按照 [MinIO 安装指南](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_minio/installation.html) 部署 MinIO

### PostgreSQL 数据库设置

1. 按照 [PostgreSQL 安装指南](https://docs.alauda.io/postgresql/4.1/installation.html) 部署 PostgreSQL

2. 为 lakeFS 创建数据库：

   连接到 PostgreSQL pod 并执行创建命令：

   ```bash
   # 列出 pods 以查找 PostgreSQL pod
   kubectl get pods

   # 执行数据库创建命令（将 <postgres-pod-name> 替换为实际名称）
   kubectl exec -it <postgres-pod-name> -- psql -U postgres -c "CREATE DATABASE lakefs;"
   ```

### lakeFS 部署

1. 访问 ACP Web 控制台，导航到“应用程序” → “创建” → “从目录创建”

2. 选择 lakeFS 图表

3. 配置部署值：

> **注意**：
>
> 1. 将 `<YOUR_ACCESS_KEY>` 和 `<YOUR_SECRET_KEY>` 替换为从 Ceph 用户密钥检索步骤中获得的实际凭证。
> 2. 更新 `databaseConnectionString`，将 `<DB_USER>`、`<DB_PASSWORD>` 和 `<DB_HOST>` 替换为您的实际 PostgreSQL 用户名、密码和服务名称。

```yaml
image:
  repository: your-registry-domain.com/3rdparty/treeverse/lakefs

lakefsConfig: |
  database:
    type: postgres
  blockstore:
    type: s3
    s3:
      force_path_style: true
      endpoint: "http://rook-ceph-rgw-my-store.rook-ceph.svc:7480"
      discover_bucket_region: false
      credentials:
        access_key_id: "<YOUR_ACCESS_KEY>"
        secret_access_key: "<YOUR_SECRET_KEY>"

secrets:
  databaseConnectionString: "postgres://<DB_USER>:<DB_PASSWORD>@<DB_HOST>:5432/lakefs"

service:
  type: NodePort

livenessProbe:
  failureThreshold: 30
  periodSeconds: 10
  timeoutSeconds: 2
```

4. 部署并验证应用程序达到“就绪”状态

## 配置指南

### 访问 lakeFS

1. 检索 NodePort 服务端点：

```bash
kubectl get svc lakefs-service -n your-namespace
```

2. 通过 NodePort 访问 lakeFS Web UI

3. 从 Web UI 下载初始凭证

### 开始使用 lakeFS

有关详细的使用说明、工作流和高级功能，请参阅官方 [lakeFS 文档](https://docs.lakefs.io/)。

官方文档涵盖：

- 基本操作（分支、提交、合并）
- 高级功能（钩子、保留策略、跨仓库操作）
- 与数据工具的集成（Spark、Airflow、dbt 等）
- API 参考和 CLI 使用
- 最佳实践和用例

## 故障排除

### 常见问题

#### 认证问题

**症状**：无法访问 lakeFS UI 或 API

**解决方案**：

- 验证凭证在部署中是否正确设置
- 检查 PostgreSQL 连接字符串格式
- 验证对象存储凭证

#### 性能问题

**症状**：操作缓慢或超时

**解决方案**：

- 监控 PostgreSQL 性能
- 检查对象存储延迟
- 审查组件之间的网络连接

### 诊断命令

检查 lakeFS 健康状况：

```bash
curl http://lakefs-service:8000/health
```

验证 PostgreSQL 连接：

```bash
kubectl exec -it lakefs-pod -- pg_isready -h postgres-service -p 5432
```

## 最佳实践

### 仓库结构

- 按域或团队组织数据
- 使用描述性分支名称（feature/、bugfix/、hotfix/）
- 实施清晰的提交消息约定

### 安全考虑

- 定期轮换访问凭证
- 对仓库访问实施最小权限原则
- 对敏感操作启用审计日志

### 备份策略

- 定期备份 PostgreSQL 元数据数据库
- 通过后端配置实现对象存储冗余
- 定期测试恢复程序

## 参考

### 配置参数

**lakeFS 部署：**

- `databaseConnectionString`：PostgreSQL 连接字符串
- `blockstore.type`：存储后端类型（s3、gs、azure）
- `blockstore.s3.endpoint`：对象存储端点
- `blockstore.s3.credentials`：访问凭证

### 有用链接

- [lakeFS 文档](https://docs.lakefs.io/) - 综合使用指南和 API 参考
- [PostgreSQL Operator 文档](https://docs.alauda.io/postgresql/4.1/functions/index.html)
- [Ceph 对象存储指南](https://docs.alauda.io/container_platform/4.1/storage/storagesystem_ceph/how_to/create_object_user.html)

## 总结

本指南提供了在 Alauda 容器平台上实施 lakeFS 的全面说明。该解决方案提供类似 Git 的数据湖版本控制，能够实现：

- **可重现的数据分析**：跟踪和引用特定数据版本
- **协作开发**：通过分支和合并隔离更改
- **数据质量保证**：实施验证工作流
- **生产可靠性**：对数据更改进行受控推广

通过遵循这些实践，组织可以显著提高其数据管理能力，同时保持现代数据湖架构的灵活性和可扩展性。
