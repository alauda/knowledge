---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB1757664849-0DAB
sourceSHA: c55fdf2f3e87e7c9200ea4ec55d84ac87457efa1c73c1fab4f9b96e8dc2224ba
---

# 标签工作室

## 概述

标签工作室是一个开源的多类型数据标注和注释工具，提供标准化的输出格式。它支持多种数据类型的标注，包括图像、音频、文本、时间序列和视频。

它包含以下主要组件：

- **后端服务**：基于 Django 的 Python 网络服务，提供 REST API、Python SDK 和机器学习集成
- **前端界面**：基于 React 的网页 UI，提供完整的注释界面，包括项目管理、数据管理、注释工具和结果导出
- **数据库**：支持 PostgreSQL 13+ 数据库，用于存储项目数据和注释结果
- **缓存系统**：使用 Redis 进行缓存和任务队列管理（可选）

标签工作室帮助团队构建和维护高质量的数据标注工作流：从简单的图像分类到复杂的多模态数据注释任务。

## 核心概念

### 项目

项目是标签工作室中数据标注的基本组织单元，包括：

- **项目设置**：注释配置、数据导入设置、用户权限等
- **数据管理**：数据导入、存储和版本控制
- **注释界面**：可配置的注释工具和界面
- **注释结果**：注释数据的存储和管理

每个项目都有独立的配置和数据空间，支持多用户协作注释。

### 标注界面

标注界面是用户执行数据注释的核心工具，支持：

- **多种注释类型**：图像分类、目标检测、文本分类、命名实体识别等
- **可配置界面**：通过配置语言自定义注释界面
- **模板支持**：提供各种预定义的注释模板
- **快捷键支持**：快捷功能以提高注释效率

标注界面使用一种特别设计的配置语言，可以灵活适应各种注释需求。

### 数据管理器

数据管理器是项目数据的核心管理工具，提供：

- **数据导入**：支持从文件、云存储（AWS S3、Google Cloud Storage）导入数据
- **数据格式**：支持 JSON、CSV、TSV 等格式
- **数据预览**：查看和预览待注释的数据
- **数据过滤**：按状态、注释者、标签和其他条件过滤数据

数据管理器支持批量操作和高级搜索功能。

### 注释

注释是用户对数据添加的标签和评论，包括：

- **注释数据**：用户添加的标签、边界框、分割区域
- **注释元数据**：注释时间、注释者、置信度和其他信息
- **注释状态**：草稿、已完成、跳过和其他状态
- **注释质量**：注释质量评分和验证

注释数据以标准化的 JSON 格式存储，便于后续处理和分析。

### 机器学习集成

标签工作室提供强大的机器学习集成能力：

- **预注释**：使用机器学习模型进行预注释以提高效率
- **在线学习**：在注释过程中进行实时训练和模型更新
- **主动学习**：智能选择需要注释的复杂样本
- **模型比较**：比较不同模型的预测结果

支持多种机器学习框架和模型格式。

## 核心概念关系

- **项目**是组织注释任务和数据的基本容器
- **标注界面**定义了用户如何与数据进行注释交互
- **数据管理器**处理项目内的数据导入、存储和组织
- **注释**存储实际的标注结果和元数据
- **机器学习集成**连接外部模型进行预注释和主动学习

## 主要功能

### 多用户注释

- **用户管理**：支持用户注册、登录和基本权限管理
- **协作注释**：多个用户同时对同一项目进行注释
- **注释分配**：灵活的任务分配和进度跟踪
- **质量控制**：注释质量评估和一致性检查

### 多类型数据支持

- **图像数据**：图像分类、目标检测、语义分割
- **文本数据**：文本分类、命名实体识别、情感分析
- **音频数据**：音频分类、语音识别、音频转录
- **视频数据**：视频分类、目标跟踪、动作识别
- **时间序列**：时间序列分类、事件识别
- **多模态数据**：支持组合注释，如图像+文本、视频+音频

### 灵活的注释配置

- **配置语言**：使用 XML 配置语言定义注释界面
- **模板库**：提供各种预定义的注释模板
- **注释工具**：支持多种内置注释工具
- **界面自定义**：支持基本的界面配置和布局

### 数据导入/导出

- **多种格式**：支持 JSON、CSV 等常见格式
- **数据导入**：支持从本地文件和 URL 导入数据
- **数据导出**：支持以多种格式导出注释结果
- **批量操作**：支持数据的批量导入和导出

### 机器学习集成

- **ML 后端**：支持基本的机器学习后端集成
- **预注释**：支持使用模型预测结果进行预注释
- **API 集成**：提供 REST API 和 Python SDK 进行集成

## 文档和参考

标签工作室提供全面的官方文档和 API 参考，帮助用户深入理解和使用平台功能：

### 官方文档

- **主要文档**： <https://labelstud.io/guide/>
  - 标签工作室核心概念和工作流的详细介绍
  - 包括安装指南、快速入门和最佳实践
  - 提供常见用例、示例代码、教程和 API 参考

# 标签工作室部署指南

本文档提供了如何将标签工作室部署到 Kubernetes 集群的详细说明和常见配置参数。

## 发布

下载标签工作室安装文件： `label-studio.ALL.v1.20.0-1.tgz`

使用 violet 命令发布到平台仓库：

```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password label-studio.ALL.v1.20.0-1.tgz
```

## 部署

### 准备存储

标签工作室将数据存储在数据库中，并需要持久存储。集群需要预先安装 CSI 或准备好 `PersistentVolume`。

### 准备数据库

标签工作室支持以下数据库：

- **PostgreSQL**：版本 13 或更高

可以使用 `Data Services` 提供的 `PostgreSQL operator` 创建 `PostgreSQL 集群`。

在 `Data Services` 中检查 `PostgreSQL` 实例详细信息中的访问地址和密码。

### 准备 Redis（可选）

Redis 不是必需的，但建议在生产环境中使用。

可以使用 `Data Services` 创建一个 `Redis` 实例。

**注意**：标签工作室仅支持以 `standalone` 模式访问 Redis。

- 在 `standalone` 模式下创建 `Redis`：

  1. 创建 `Redis` 实例时，选择 `Redis Sentinel` 作为 `Architecture`。

  2. 设置所有参数后，切换到 `YAML` 模式，将 `spec.arch` 更改为 `standalone`，然后单击 `Create` 按钮。

  3. 创建后，切换到 `Alauda Container Platform` 视图，找到名为 `rfr-<Redis 实例名称>-read-write` 的 `Service`，这是该 Redis 实例的访问地址。

### 创建应用程序

1. 转到 `Alauda Container Platform` 视图，选择将部署标签工作室的命名空间。

2. 在左侧导航中选择 `Applications` / `Applications`，然后在右侧页面单击 `Create` 按钮。

3. 在弹出对话框中，选择 `Create from Catalog`，然后页面将跳转到 `Catalog` 视图。

4. 找到 `3rdparty/chart-label-studio` 并单击 `Create` 创建此应用程序。

5. 在 `Catalog` / `Create label-studio` 表单中，填写 `Name`（建议为 `label-studio`）和 `Values` 中的 `Custom` 配置，然后单击 `Create` 按钮完成创建。`Custom` 内容将在下面描述。创建后也可以通过 `Update` 应用程序方法进行修改。

## 配置

用户可以修改 `Application` 的 `Custom Values` 以调整配置。主要关注的配置如下：

### 1. 配置存储

#### 1.1 配置存储类和存储大小

可以通过添加以下配置来指定存储类：

```yaml
label-studio:
  persistence:
    storageClass: storage-class-name
    size: 20Gi                               # 替换为实际所需空间大小
```

### 2. 配置数据库

#### 2.1 配置 PostgreSQL

可以通过设置以下字段配置 PostgreSQL 访问信息：

```yaml
global:
  pgConfig:
    host: localhost                          # PostgreSQL 访问地址
    port: 5432                               # PostgreSQL 访问端口，默认：5432
    dbName: labelstudio                      # 数据库名称，注意：数据库将自动创建
    userName: postgres                       # 数据库用户名
    password:
      secretName: postgre-secret             # 存储数据库访问密码的 Secret 名称
      secretKey: password                    # 存储数据库访问密码的 Secret 键
```

#### 2.2 配置 Redis

可以通过设置以下字段配置 Redis 访问信息：

```yaml
global:
  redisConfig:
    host: "redis://your-redis-host:6379/1"    # Redis 连接地址，格式：redis://[:password]@host:port/db
    password:                                 # 可选，密码可以包含在主机中或通过 Secret 单独提供
      secretName: "redis-secret"              # 存储 Redis 访问密码的 Secret 名称
      secretKey: "password"                   # 存储 Redis 密码的 Secret 键
    ssl:                                      # 可选
      redisSslCertReqs: "optional"            # SSL 证书要求："" 表示不需要，"optional"，"required"
      redisSslSecretName: "redis-ssl-secret"  # SSL 证书 Secret 名称
      redisSslCaCertsSecretKey: "ca.crt"      # CA 证书 Secret 键
      redisSslCertFileSecretKey: "tls.crt"    # 客户端证书 Secret 键
      redisSslKeyFileSecretKey: "tls.key"     # 客户端私钥 Secret 键
```

### 3. 配置访问方法

默认情况下，使用 `LoadBalancer` 提供访问地址。

#### 3.1 修改服务类型

可以通过设置以下字段修改 `Service` 类型：

```yaml
label-studio:
  app:
    service:
      type: LoadBalancer                     # 可以更改为 NodePort 或 ClusterIP
```

#### 3.2 启用 Ingress

可以通过设置以下字段配置 Ingress。启用 Ingress 后，服务类型通常更改为 ClusterIP：

```yaml
label-studio:
  app:
    ingress:
      enabled: true                          # 启用 Ingress 功能
      host: localhost                        # 访问域名（必须是 DNS 名称，而不是 IP 地址）
      tls:
        - secretName: certificate-secret     # 存储 TLS 证书的 Secret 名称
global:
  extraEnvironmentVars:
    LABEL_STUDIO_HOST: https://label-studio.example.com       # 前端资源加载的 Web 访问 URL
```

### 4. 配置用户管理

#### 4.1 禁用用户注册

可以通过设置以下字段禁用用户注册：

```yaml
global:
  extraEnvironmentVars:
    LABEL_STUDIO_DISABLE_SIGNUP_WITHOUT_LINK: true
```

## 访问地址

### 1. 通过服务访问

`标签工作室` 通过 `Service` 提供外部访问。检查其 `Service` 以获取访问地址。

`Service` 名称为：`<Application Name>-ls-app`。

如果 `Service` 类型为 `LoadBalancer`，并且环境中的负载均衡器控制器已分配访问地址，请通过该地址访问。

如果 `Service` 类型为 `LoadBalancer` 或 `NodePort`，则可以通过 `node IP` 及其 `NodePort` 进行访问。

### 2. 通过 Ingress 访问

如果启用了 Ingress，请通过配置的 LABEL_STUDIO_HOST 进行访问。

## 用户管理

标签工作室没有默认的用户名和密码。用户可以通过在登录页面填写电子邮件和密码来完成新用户注册。

**注意**：

- 默认配置允许任何人注册新用户
- 所有用户具有相同的功能权限，可以访问所有项目
- 要限制用户注册，请配置环境变量 `LABEL_STUDIO_DISABLE_SIGNUP_WITHOUT_LINK=true`（见：[4.1 禁用用户注册](#41-disable-user-registration)）

# 标签工作室快速入门

## S3 集成

标签工作室支持与 S3 兼容存储的集成，用于导入数据和导出注释。这包括 Amazon S3、MinIO 和其他 S3 兼容存储服务。

### 先决条件

- 具有适当权限的 S3 兼容存储桶
- 访问凭证（Access Key ID 和 Secret Access Key）

#### 使用 ACP MinIO 作为 S3 存储

> 注意：ACP MinIO 只是一个可选选择。您可以使用任何 S3 兼容存储（例如，Amazon S3、Ceph RGW 等）。

您可以使用 ACP 内置的 MinIO 作为 S3 存储：

1. **对象存储**：在管理员视图中，转到 `Storage` / `Object Storage` 检查是否已创建 MinIO。如果没有，请单击 **Configure Now** 开始设置过程。

2. **部署 MinIO Operator**：`Create Object Storage` 过程有两个步骤。首先，单击 **Deploy Operator** 按照页面指导部署 MinIO Operator。

3. **创建 MinIO 集群**：在 MinIO Operator 部署后，继续第二步 `Create Cluster`。填写所需信息：

   - **名称**：集群名称
   - **Access Key** 和 **Secret Key**：管理员凭证
   - **资源配置**：资源分配设置
   - **存储池配置**：存储池设置
   - **访问配置**：访问方法设置

   单击 **Create Cluster** 创建 MinIO 集群。

4. **获取访问信息**：MinIO 集群访问地址可以在 **Access Method** 选项卡中找到。

5. **管理存储桶和凭证**：使用 `mc` 客户端访问 MinIO 集群，创建存储桶，并生成低权限的 Access Keys/Secret Keys。有关使用细节，请参见 [MinIO 客户端文档](https://docs.min.io/community/minio-object-store/reference/minio-mc.html)。

### 使用 S3 与标签工作室

1. **访问存储设置**
   - 打开标签工作室项目
   - 转到 **Settings** > **Cloud Storage**

2. **添加源存储**
   - 单击 **Add Source Storage**
   - 选择 **AWS S3** 作为存储类型
   - 填写所需信息：
     - **Storage Title**：存储连接的名称
     - **Bucket Name**：S3 存储桶名称
     - **Region Name**：存储区域（例如，AWS S3 的 us-east-1，MinIO 可为空）
     - **S3 Endpoint**：可选自定义 S3 端点（AWS S3 留空，MinIO 必填）
     - **Access Key ID**：访问密钥
     - **Secret Access Key**：秘密密钥
     - **Session Token**：可选的临时凭证会话令牌
     - **Bucket Prefix**：存储桶中的可选路径前缀（例如，`data/`、`input/`）
     - **File Filter Regex**：可选的正则表达式以过滤文件（例如，`.*csv` 或 `.*(jpe?g|png|tiff)`）
   - 配置可选设置：
     - **将每个存储桶对象视为源文件**：媒体文件勾选，JSON 任务文件取消勾选
     - **递归扫描**：启用以递归扫描子目录
     - **使用预签名 URL**：启用以直接浏览器访问 S3（推荐）
     - **过期分钟数**：启用 **使用预签名 URL** 时的 URL 过期时间（默认：15 分钟）
   - 单击 **Check Connection** 测试连接
   - 单击 **Add Storage** 创建存储连接

3. **添加目标存储**（可选）
   - 单击 **Add Target Storage** 将注释导出到 S3
   - 填写与源存储类似的 S3 参数
   - 其他目标存储参数：
     - **SSE KMS Key ID**：可选的 KMS 密钥，用于服务器端加密
   - 配置可选设置：
     - **可以从存储中删除对象**：启用以允许从存储中删除注释
   - 单击 **Check Connection** 测试连接
   - 单击 **Add Storage** 创建存储连接

4. **上传数据到 S3**
   - 将数据文件上传到配置的 S3 存储桶和前缀路径
   - 确保数据文件可以使用配置的访问凭证访问
   - 使用 `mc` 客户端或 AWS CLI 进行批量上传

5. **导入数据**
   - 单击 `Source Cloud Storage` 下的 **Sync Storage** 从 S3 导入数据
   - 每当向 S3 存储桶添加新数据时，请使用同步

6. **执行注释**
   - 在标签工作室界面访问导入的数据
   - 使用配置的标注界面完成注释

7. **导出注释**
   - 单击 **Export** 按钮以下载各种格式的注释结果（JSON、CSV 等）
   - 或单击 **Sync Storage** 将注释推送到 S3 的 `Target Cloud Storage`
   - **注意**：目标存储以 JSON 格式导出注释。使用标签工作室 SDK 将 JSON 注释转换为其他格式（CSV、COCO、Pascal VOC、YOLO 等）。有关详细信息，请参见 [SDK 转换器](https://github.com/HumanSignal/label-studio-sdk/tree/master/src/label_studio_sdk/converter)。

8. **将数据和注释应用于模型训练/验证**
   - 使用 `mc` 客户端或 AWS Python SDK（boto3）从 S3 下载训练数据和注释。有关实现细节，请参见 [S3 示例](https://boto3.amazonaws.com/v1/documentation/api/latest/guide/s3-examples.html)。
   - 如有需要，使用标签工作室 SDK 转换注释格式。
   - 将数据集成到机器学习管道中。
   - 使用注释进行模型训练或验证。

### 存储结构建议

- 对于不同项目，使用不同的存储桶或不同的路径前缀以避免数据冲突。
- 目标和源可以使用同一个 S3 存储桶，但使用不同的路径前缀（例如，源使用 `input/`，目标使用 `output/`），或者使用不同的存储桶以更好地隔离数据和访问控制。

## 其他资源

有关更多标签工作室教程和指南，请参见 [Getting Started With Label Studio](https://labelstud.io/learn/getting-started-with-label-studio/)
