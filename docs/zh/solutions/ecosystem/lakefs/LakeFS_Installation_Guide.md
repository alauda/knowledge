---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3,4.4'
id: KB260700104
sourceSHA: d46568762444b187d5213f4bbdbc6abf77fe870588851ddb38cd2c3fd9d57de5
---

<!--
  Authoring model (oss-operator-factory): this guide is authored ONCE by hand. On later
  lakeFS releases, only the slots fenced with `factory:auto:*` markers below are updated by
  the factory pipeline (version, supported versions, known limitations).
  Do NOT hand-edit inside a factory:auto block — those are regenerated from component.yaml /
  release evidence. Prose outside the markers is human-owned and preserved across releases.
-->

# Alauda 对 lakeFS 的支持 — 安装指南

## 概述

**Alauda 对 lakeFS 的支持** 是 Alauda 应用服务 (S2, certified) 打包的上游 [lakeFS](https://lakefs.io/) 数据版本控制系统，列在 Alauda Cloud 市场上，并可以从 ACP OperatorHub 安装。

lakeFS 为您的对象存储提供了 Git 的工作流。它位于您已经使用的存储前面，让您可以：

- **分支** 您的数据 — 立即创建整个数据集的隔离副本，无需复制数据。
- **提交** 更改，并保留完整的可审计历史，记录谁在何时更改了什么。
- **合并** 分支回到 `main`，一旦您的作业或管道验证了其输出。
- **回滚** 到任何早期的提交，当一个错误的作业损坏了数据集时。
- 通过 **Web 控制台**、`lakectl` 命令行或 **S3 兼容网关** 工作，因此现有工具（Spark、Trino、pandas、AWS CLI）可以在不更改代码的情况下读取和写入 lakeFS 存储库。

在 Alauda 容器平台 (ACP) 上，lakeFS 作为 Operator 提供，您可以从市场中安装。创建一个 `LakeFS` 资源后，服务将启动并保持一致。

### 支持的版本

<!-- factory:auto:supported-versions BEGIN -->

| 项目                               | 版本                    |
| ---------------------------------- | ---------------------- |
| ACP                                | 4.1, 4.2, 4.3, 4.4     |
| 架构                              | amd64 (x86_64), arm64 |
| 网络                              | IPv4, IPv6             |
| Alauda 对 lakeFS 的支持 (包)      | v1.84.1                |
| lakeFS                             | 1.84.1                 |
| 上游 Helm chart                   | 1.12.18                |
| 许可证                            | Apache-2.0             |

<!-- factory:auto:supported-versions END -->

## 先决条件

- 一个支持上述版本的 ACP 集群，并且对目标业务集群具有 `cluster-admin` 访问权限。
- 在您集群的 OperatorHub 中可用的 **Alauda 对 lakeFS 的支持** 插件。如果尚未上传，管理员可以使用 `violet` CLI 推送它：
  ```bash
  violet push lakefs-operator.<version>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- 针对目标集群配置的 `kubectl`。
- **关于 lakeFS 数据存储位置的决定** — 请参见下一节。在安装之前做出决定；稍后更改意味着移动数据。

## 在安装之前决定存储

lakeFS 保持两种不同的内容，并且它们是单独配置的：

|                    | 内容                                                               | 存储位置                                            |
| ------------------ | ------------------------------------------------------------------ | -------------------------------------------------- |
| **元数据存储**    | 提交图 — 分支、提交及每个分支指向的对象                           | 磁盘上的嵌入式键值存储，**或** PostgreSQL           |
| **块存储**        | 对象数据本身                                                       | 磁盘上的目录，**或** S3 兼容对象存储               |

该包默认将两者设置为 **local**（嵌入式存储，本地目录）。这让您可以一键获得一个可用的 lakeFS，这是评估的正确选择 — 但请注意两个后果：

1. **它仅为单副本。** 嵌入式元数据存储无法在多个 pod 之间共享，因此 `replicaCount` 必须保持为 `1`。
2. **本地意味着容器文件系统，除非您附加卷。** 如果没有卷，当 pod 重启时，您的存储库及其历史将丢失。

因此，有三种合理的形状：

| 形状               | 元数据                       | 块                       | 副本数 | 用于                                          |
| ------------------- | ---------------------------- | ------------------------ | ------ | --------------------------------------------- |
| 开箱即用           | 嵌入式，容器文件系统        | 容器文件系统            | 1      | 初步查看；数据不持久                          |
| 评估，持久         | 嵌入式，位于 PVC 上         | 位于同一 PVC 上         | 1      | 演示和必须在重启后存活的小型试验            |
| **生产**           | **PostgreSQL**               | **S3 兼容存储**        | 2+     | 实际工作负载                                  |

后两者的完整配置如下。

该包配置的所有三个本地路径都位于一个目录下，因此一个 **挂载在 `/home/lakefs` 的单个卷** 可以持久化所有内容：

```
/home/lakefs/metadata   嵌入式元数据键值存储
/home/lakefs/data       对象数据
/home/lakefs/cache      提交数据缓存
```

## 安装 Operator

1. 在 ACP 控制台中，转到 **管理员 > 市场 > OperatorHub**，选择目标集群，找到 **Alauda 对 lakeFS 的支持**，然后点击 **安装**。
2. 保持默认通道（`alpha`）。对于 **安装位置**，建议的命名空间是 **`lakefs`**。
3. 确认安装。

### 验证 Operator

```bash
kubectl -n lakefs get csv | grep lakefs
kubectl -n lakefs get deploy
```

预期：条目 `lakefs-operator.v<version>` 达到状态 `Succeeded`，Operator 自身的 Deployment 显示 `1/1` 准备就绪。

## 快速开始：启动 lakeFS

### 1. 选择加密密钥

`secrets.authEncryptSecretKey` 是 **必需的**。lakeFS 使用它来加密存储的凭证，因此：

- 使用 **长随机字符串** — 例如 `openssl rand -hex 32`；
- **之后绝不要更改它。** 轮换密钥会使已经存储的每个凭证无法解密，这会锁定您对自己安装的访问。

将其副本保留在您存放其他秘密的地方。

### 2. 创建 LakeFS 资源

从控制台打开已安装的 Operator 并创建一个 **LakeFS** 实例 — 表单要求输入加密密钥并预填充其余内容。要从命令行执行此操作，以下是 **评估，持久** 形状：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: lakefs-data
  namespace: lakefs
spec:
  accessModes: ["ReadWriteOnce"]
  # storageClassName: <your-storage-class>   # 仅在集群未标记一个为默认时省略
  resources:
    requests:
      storage: 20Gi
---
apiVersion: lakefs-operator.alauda.io/v1
kind: LakeFS
metadata:
  name: lakefs
  namespace: lakefs
spec:
  replicaCount: 1
  secrets:
    authEncryptSecretKey: "REPLACE-WITH-A-LONG-RANDOM-STRING"
  extraVolumes:
    - name: lakefs-data
      persistentVolumeClaim:
        claimName: lakefs-data
  extraVolumeMounts:
    - name: lakefs-data
      mountPath: /home/lakefs
```

```bash
kubectl apply -f lakefs.yaml
```

> 如果您的集群未将 StorageClass 标记为默认，请显式设置 `storageClassName`。
> 使用 `kubectl get storageclass` 检查。

### 3. 等待其启动

```bash
kubectl -n lakefs get deploy lakefs
kubectl -n lakefs get pvc lakefs-data
```

预期：Deployment 达到 `1/1`，并且声明为 `Bound`。

### 4. 完成首次设置

打开控制台并创建第一个管理员。没有 Ingress 时，转发服务：

```bash
kubectl -n lakefs port-forward svc/lakefs 8000:80
# 然后打开 http://localhost:8000
```

设置页面要求输入管理员用户名，并返回 **访问密钥 ID 和秘密访问密钥**。现在复制它们 — 秘密仅显示一次。它们是 `lakectl`、S3 网关和 API 所有身份验证所需的。

对于 **评估** 部署 — 使用随附的嵌入式元数据存储 — 您可以通过在首次应用资源之前将 `installation` 块放入 `lakefsConfig` 来无监督地完成此步骤：

```yaml
  lakefsConfig: |
    installation:
      user_name: admin
      access_key_id: AKIAIOSFODNN7EXAMPLE
      secret_access_key: <a-long-random-secret>
```

> **当元数据存储为 PostgreSQL 时，这不起作用。** 使用 `database.type: postgres`，服务器正常启动但保持未初始化，所有 API 调用都被拒绝，显示 `credentials not found`。通过上述设置页面设置 PostgreSQL 支持的部署，或在 pod 内部运行设置命令：
>
> ```bash
> kubectl -n lakefs exec deploy/lakefs -- /app/lakefs setup --user-name admin
> ```
>
> 该命令打印它创建的访问密钥 ID 和秘密访问密钥 — 复制它们，因为不会再次显示。它生成自己的密钥对并忽略您设置的任何 `installation` 值。

### 5. 尝试 Git 类似的工作流

`lakectl` 随镜像一起提供，因此您可以在不安装任何内容的情况下运行整个回合：

```bash
POD=$(kubectl -n lakefs get pod -l app.kubernetes.io/instance=lakefs -o name | head -1)

kubectl -n lakefs exec $POD -- sh -c '
  export LAKECTL_SERVER_ENDPOINT_URL=http://lakefs.lakefs.svc.cluster.local:80
  export LAKECTL_CREDENTIALS_ACCESS_KEY_ID=<access-key-id>
  export LAKECTL_CREDENTIALS_SECRET_ACCESS_KEY=<secret-access-key>

  # 一个由本地块存储支持的存储库（默认分支：main）
  /app/lakectl repo create lakefs://demo local://demo

  # 在 main 上提交一个文件
  echo hello > /tmp/f1.txt
  /app/lakectl fs upload -s /tmp/f1.txt lakefs://demo/main/f1.txt
  /app/lakectl commit lakefs://demo/main -m "first commit"

  # 分支、修改、合并回去
  /app/lakectl branch create lakefs://demo/feature -s lakefs://demo/main
  echo world > /tmp/f2.txt
  /app/lakectl fs upload -s /tmp/f2.txt lakefs://demo/feature/f2.txt
  /app/lakectl commit lakefs://demo/feature -m "add f2"
  /app/lakectl merge lakefs://demo/feature lakefs://demo/main

  # 现在两个文件都在 main 上
  /app/lakectl fs ls lakefs://demo/main/
  /app/lakectl log lakefs://demo/main
'
```

预期：`f1.txt` 和 `f2.txt` 都列在 `main` 上，日志显示合并。

同一存储库可以通过 S3 网关在同一端点访问，因此 S3 客户端可以使用相同的访问密钥对访问 `s3://demo/main/f1.txt`。

## 生产配置

对于实际工作负载，将元数据存储移动到 PostgreSQL，将块存储移动到 S3 兼容存储。只有这样，您才能运行多个副本。

```yaml
apiVersion: lakefs-operator.alauda.io/v1
kind: LakeFS
metadata:
  name: lakefs
  namespace: lakefs
spec:
  replicaCount: 2

  secrets:
    authEncryptSecretKey: "REPLACE-WITH-A-LONG-RANDOM-STRING"
    databaseConnectionString: "postgres://lakefs:REPLACE-PASSWORD@postgres.example.svc:5432/lakefs?sslmode=disable"

  resources:
    requests:
      cpu: 500m
      memory: 1Gi

  ingress:
    enabled: true
    ingressClassName: ""          # 空 = 集群的默认 ingress 类
    hosts:
      - host: lakefs.example.com
        paths: ["/"]

  lakefsConfig: |
    database:
      type: postgres
      # 连接字符串来自上面的 Secret — 不要在此处重复
    blockstore:
      type: s3
      s3:
        endpoint: https://s3.example.com
        force_path_style: true    # 大多数 S3 兼容存储（MinIO、Ceph RGW）所需
        region: us-east-1
        credentials:
          access_key_id: "REPLACE-ACCESS-KEY"
          secret_access_key: "REPLACE-SECRET-KEY"
    stats:
      enabled: false
    security:
      check_latest_version: false
```

首先创建数据库和存储桶。两个 `secrets.*` 值存储在 Kubernetes Secret 中，而不是 ConfigMap 中。

您针对该部署创建的存储库必须使用 `s3://` 存储命名空间，例如 `lakectl repo create lakefs://demo s3://my-bucket/demo`。

**在首次使用之前设置它。** PostgreSQL 支持的部署在未初始化时启动，并且在您完成设置之前将拒绝每个请求 — 通过设置页面，或使用 `kubectl -n lakefs exec deploy/lakefs -- /app/lakefs setup --user-name admin`。请参见 [完成首次设置](#4-complete-the-first-time-setup) 中的说明。

## 配置参考

`spec` 下的所有内容都传递给底层 Helm chart，因此可以设置任何 chart 值。最重要的值：

| 字段                                | 含义                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `secrets.authEncryptSecretKey`       | **必需。** 加密存储的凭证。绝不要更改它。                                                                            |
| `secrets.databaseConnectionString`   | PostgreSQL 连接字符串，当 `database.type` 为 `postgres` 时。                                                        |
| `lakefsConfig`                       | lakeFS 自身的配置文件，格式为 YAML。这是选择元数据存储、块存储和首次启动设置的地方。                               |
| `replicaCount`                       | 除非元数据存储为 PostgreSQL，否则保持为 `1`。                                                                      |
| `extraVolumes` / `extraVolumeMounts` | 附加 PVC — 挂载到 `/home/lakefs` 以持久化本地元数据存储、数据和缓存。                                              |
| `service.type`, `service.port`       | 服务在集群中的暴露方式（默认是 `ClusterIP`）。                                                                      |
| `ingress.enabled`, `ingress.hosts`   | 外部访问控制台、API 和 S3 网关。                                                                                     |
| `resources`                          | CPU 和内存请求及限制。                                                                                              |

该包的两个行为与上游 chart 默认值不同，故意为之：

- **Pod 以非特权用户身份运行** — 以非根用户身份，丢弃所有 Linux 能力并应用默认 seccomp 配置文件。如果您附加卷，它的 `fsGroup` 会为您设置，以便 lakeFS 可以写入。
- **禁用出站遥测和版本检查**，因此部署不会调用互联网，并在隔离集群上保持不变。

## 已知限制

<!-- factory:auto:known-limitations BEGIN -->

- **随附的默认设置为单副本。** 嵌入式元数据存储无法在 pod 之间共享，因此 `replicaCount` 必须保持为 `1`，直到您将元数据存储移动到 PostgreSQL。在此之前扩展将产生不一致的结果。
- **开箱即用的数据不持久。** 如果没有附加卷，本地元数据存储和块存储位于容器文件系统上，并在重启时丢失。在 `/home/lakefs` 附加 PVC（评估）或使用 PostgreSQL + S3（生产）。
- **加密密钥无法轮换。** `secrets.authEncryptSecretKey` 加密存储的凭证；在现有安装中更改它会使其无法解密。选择一次并保留副本。
- **没有从旧的 `lakeFS` chart 插件的升级路径。** 这是一个单独的新发布 Operator 包。请全新安装；现有的基于 chart 的条目不会升级到它。要跨越数据，请将新部署指向相同的 PostgreSQL 数据库和 S3 存储桶。
- **不包括 lakeFS 企业功能。** 此包是 Apache-2.0 开源 lakeFS。企业专属功能（超出内置模型的 RBAC、SSO、审计日志）不可用。
- **无监督设置在 PostgreSQL 元数据存储中不起作用。** `lakefsConfig` 中的 `installation` 块仅初始化评估部署。使用 `database.type: postgres` 时，部署启动但保持未初始化，直到您通过设置页面或使用 `/app/lakefs setup` 完成设置。请参见 [完成首次设置](#4-complete-the-first-time-setup) 中的说明。

<!-- factory:auto:known-limitations END -->

## 卸载

```bash
kubectl -n lakefs delete lakefs lakefs
```

工作负载被移除。您自己创建的 PVC **不会** 被删除 — 一旦您确定不再需要数据，请单独删除它：

```bash
kubectl -n lakefs delete pvc lakefs-data
```

然后从 **管理员 > 市场 > OperatorHub** 卸载 Operator，或：

```bash
kubectl -n lakefs delete subscription lakefs-operator
kubectl -n lakefs delete csv -l operators.coreos.com/lakefs-operator.lakefs
```

> 在卸载 Operator 之前 **删除 `LakeFS` 资源**。Operator 是移除底层发布的工具；如果它先消失，资源无法完成删除，其命名空间将停留在 `Terminating` 状态。

## 常见问题解答

**问：Pod 无法启动，卷声明保持 `Pending`。**
集群没有默认 StorageClass，或者请求的大小无法满足。运行 `kubectl -n lakefs describe pvc lakefs-data` 查看原因，并显式设置 `storageClassName`。

**问：我重启了 Pod，我的存储库消失了。**
没有附加卷，因此本地元数据存储位于容器文件系统上。按照快速开始中的说明重新安装，并在 `/home/lakefs` 挂载 PVC。

**问：我可以运行多个副本吗？**
只有在 PostgreSQL 作为元数据存储时。请参见 [生产配置](#production-configuration)。

**问：我丢失了设置页面上的秘密访问密钥。**
使用管理员帐户登录控制台并创建新的访问密钥对。原始秘密仅显示一次，无法恢复。

**问：现有的 S3 工具可以读取 lakeFS 存储库吗？**
可以。lakeFS 在同一端点上公开了 S3 兼容网关。将工具指向 lakeFS 服务地址，使用 lakeFS 访问密钥对，并将对象地址设置为 `s3://<repository>/<branch>/<path>`。

**问：我该如何升级？**
从市场升级 Operator。它将 lakeFS Deployment 升级到匹配的版本，并保持您的元数据存储和块存储不变。
