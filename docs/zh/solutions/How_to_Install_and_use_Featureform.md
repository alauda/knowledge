---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB1756692696-9DEE
sourceSHA: c3d1cd1e8c5104b89d7c476d381b93e0ebee74bf02704bcc11575f884272fe46
---

# Featureform

## 概述

Featureform 是一个开源的机器学习特征平台，旨在构建、管理和部署机器学习特征。

它简化了特征工程工作流程，使数据科学家和机器学习工程师能够专注于模型开发，而不是处理特征基础设施的复杂性。

## 核心概念

### 特征

特征是机器学习模型用于做出预测的输入数据。在 Featureform 中，特征包含以下核心组件：

- **实体列**：作为主键或索引，标识特征所属的对象
- **值列**：特征的具体数值或类别值
- **时间戳列**：可选的时间信息，用于跟踪特征随时间的变化

特征是机器学习模型训练和推理的核心输入，与实体关联，以提供预测所需的信息。

特征不是原始数据，而是数据源处理和转换的结果。

原始数据需要经过 Featureform 的数据源注册、转换处理等步骤，才能成为可用的特征。高质量的特征直接影响训练模型的性能。

例如：

- 在欺诈检测中，原始数据包括用户交易记录，如交易金额、客户出生日期、客户位置等，但用于训练的特征是客户的平均交易金额。

### 标签

标签是机器学习模型旨在预测的目标变量。在监督学习中，标签是已知的正确答案，模型学习特征与标签之间的关系以进行预测。

例如：

- 在欺诈检测中，每笔交易的标签是“欺诈”或“正常”。

### 实体

实体是特征和标签描述的对象，作为数据的主键或索引。

例如：

- **客户**：用户 ID、客户 ID 等。

实体作为连接特征和标签的桥梁，允许多个特征和标签组织在一起，形成完整的训练数据。在 Featureform 中，实体通过装饰器定义，并可以与多个特征和标签关联。

### 训练集

训练集是用于训练机器学习模型的数据集合，通过特征和标签中定义的实体字段自动连接。训练集包含：

- **特征值**：模型训练的输入数据
- **标签值**：模型旨在预测的目标值

训练集将特征、标签和实体组织在一起，为模型训练提供完整的数据结构。实体关联通过在定义特征和标签时指定实体列（如用户 ID、产品 ID 等）来实现。Featureform 系统根据这些实体列自动连接数据。

## 核心概念关系

- **实体**是数据的主体，定义了我们想要分析的对象
- **特征**与实体相关联，提供预测所需的属性信息
- **标签**是我们想要预测的目标
- **训练集**将特征、标签和实体组织在一起，形成完整的训练数据

## 提供者（数据基础设施提供者）

提供者是 Featureform 中负责数据存储和计算的后端系统。它们提供：

- **离线存储**：存储原始数据，执行数据转换，构建训练集（例如，PostgreSQL、BigQuery、Spark 等）
- **在线存储**：为实时推理提供低延迟特征服务（例如，Redis、Pinecone 等）
- **文件存储**：为某些离线存储系统提供底层存储支持（例如，S3、HDFS、Azure Blob 等）

提供者采用虚拟特征存储架构，允许数据科学家在现有基础设施上使用统一的抽象接口，同时数据保持在原始系统中。

## 不可变 API 设计

Featureform 采用不可变 API 设计，这是其与其他特征平台的一个关键区别。在 Featureform 中，所有特征、标签和训练集在创建后都是不可变的，这意味着：

- **资源不能被修改**：一旦特征、标签或训练集被创建和应用，其定义和逻辑不能更改
- **版本管理**：如果需要修改，必须创建新变体，而不是覆盖现有资源
- **协作安全**：团队成员可以安全地使用其他人创建的资源，而无需担心上游逻辑的变化
- **实验管理**：支持为实验创建多个变体，每个变体都有独立的生命周期

这种设计确保了机器学习资源的一致性和可靠性，避免了由于资源修改导致的训练失败或推理错误。通过变体系统，数据科学家可以管理资源的不同版本，同时保持生产环境的稳定性。

## 变体

变体是 Featureform 中实现版本管理和实验支持的核心机制。每个特征、标签或训练集可以有多个变体，每个变体代表不同的版本或实验配置。

### 变体的好处

- **版本管理**：为同一资源创建不同版本，支持 A/B 测试和实验
- **实验支持**：允许数据科学家尝试不同的特征工程方法，而不影响生产环境
- **协作开发**：团队成员可以并行开发不同的变体，而不会相互干扰
- **回滚支持**：当新版本出现问题时，可以快速回滚到先前的稳定版本

## 文档和参考

Featureform 提供全面的官方文档和 SDK 参考，帮助用户有效理解和使用平台特性：

### 官方文档

- **主文档**： <https://docs.featureform.com/>
  - Comprehensive introduction to Featureform's core concepts and workflows
  - 包括架构设计、部署指南和最佳实践
  - 提供常见用例和示例代码

### SDK 参考

- **Python SDK**： <https://sdk.featureform.com/>
  - 完整的 Python API 参考文档
  - 支持本地模式和托管实例
  - 包括所有操作的详细描述，如注册、应用和服务

## 系统架构

Featureform 采用微服务架构，具有以下核心组件：

### 核心服务

1. **API 服务器**
   - 提供 gRPC API 接口
   - 作为 gRPC 网关，将请求转发到元数据服务和特征服务器
   - 提供统一的资源管理和特征服务接口

2. **协调器**
   - 监控 etcd 中的任务变化
   - 协调任务调度和执行
   - 管理各种运行器以执行特定任务

3. **特征服务器**
   - 提供特征服务（在线特征查询、批量特征服务）
   - 提供训练数据服务（训练集数据、列信息）
   - 提供向量搜索功能（支持嵌入特征）

4. **元数据服务**
   - 提供用于元数据管理的 gRPC 接口
   - 存储所有资源的定义和元数据（特征、标签、训练集、源数据等）
   - 管理资源之间的依赖关系和状态

### 数据存储

1. **etcd**
   - 存储配置信息和集群状态
   - 提供分布式锁和协调服务

2. **Meilisearch**
   - 提供特征和元数据的搜索功能
   - 支持全文搜索和模糊匹配
   - 数据源：当资源更改时，元数据服务自动写入，元数据仪表板在标签更新时写入

### 监控和可观察性

1. **Prometheus**
   - 收集系统指标和性能数据
   - 为仪表板提供指标查询支持

2. **仪表板**
   - 提供查看系统状态的 Web 界面
   - 显示特征统计、性能指标和资源信息
   - 纯前端页面，仅提供只读查看功能

3. **元数据仪表板**
   - 提供访问元数据服务的 HTTP API 接口
   - 将元数据服务的 gRPC 接口转换为 HTTP 接口
   - 为仪表板前端提供资源查询、搜索和标签管理功能
   - 支持源数据预览和文件统计

### 网络和访问

1. **Ingress 控制器（Nginx）**
   - 管理外部流量路由和负载均衡
   - 提供 SSL 终止和反向代理
   - 处理 HTTP 请求和缓存功能

## 组件调用关系

```
用户 → 仪表板
          ↓
   Ingress 控制器（Nginx）
     ↓                   ↓
  Prometheus       元数据仪表板 → Meilisearch
     │                ↓        ↓        ↑
     │ 协调器 → etcd ← 元数据服务 ← API 服务器 ← SDK 客户端
     │                ↑        ↑                  │
     └────────────→ 特征服务器 ←──────────────┘

```

# Featureform 部署指南

本文档提供了如何将 Featureform 部署到 Kubernetes 集群的详细说明，以及必要的配置参数。

## 发布

下载 Featureform 安装文件： `featureform.amd64.v0.12.1-2.tgz`

使用 violet 命令发布到平台仓库：

```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password featureform.amd64.v0.12.1-2.tgz
```

## 部署

### 限制

**每个命名空间仅允许一个 `Featureform` 应用。**

在同一命名空间中部署多个实例可能会导致资源冲突和其他问题。

**架构支持限制：仅支持 x86 架构，不支持 ARM 架构。**

### 存储准备

Featureform 数据存储在 etcd 中，这需要持久存储以确保数据持久性。
集群需要预先安装 CSI 或准备好 `PersistentVolume`。

### 创建应用

1. 转到 `Alauda Container Platform` 视图，选择将要部署 Featureform 的命名空间。

2. 在左侧导航中选择 `Applications` / `Applications`，然后点击打开页面右侧的 `Create` 按钮。

3. 在弹出对话框中选择 `Create from Catalog`，然后页面将跳转到 `Catalog` 视图。

4. 找到 `3rdparty/chart-featureform`，然后点击 `Create` 创建此应用。

5. 在 `Catalog` / `Create featureform` 表单中，填写 `Name`（建议填写为 `featureform`）和 `Values` 中的 `Custom` 配置，然后点击 `Create` 按钮完成创建。`Custom` 的内容将在下面描述。您也可以通过 `Update` 应用方法在创建后进行修改。

## 配置

用户可以修改 `Application` 的 `Custom Values` 以调整配置。关键配置如下：

### 1. 配置镜像仓库

#### 1.1 配置镜像仓库地址

虽然 `Chart` 已经配置了 `ImageWhiteList` 以自动替换工作负载使用的镜像。

但是，当使用 Kubernetes Jobs 运行 `Featureform` 任务时，镜像拉取失败可能导致任务失败。因此，建议配置正确的镜像注册表地址。

配置字段如下：

```yaml
global:
  repo: <镜像仓库地址>/3rdparty/featureform
ingress-nginx:
  controller:
    admissionWebhook:
      patch:
        image:
          registry: <镜像仓库地址>/3rdparty
    image:
      registry: <镜像仓库地址>/3rdparty
```

如何获取 `镜像仓库地址`：

- 在 `Administrator` 视图中，检查相应集群详细信息页面的 `Overview` 标签页下的 `镜像仓库地址` 字段。

#### 1.2 配置镜像仓库拉取凭证

如果从镜像仓库拉取镜像时需要身份验证，请添加以下配置：

```yaml
global:
  registry:
    imagePullSecrets:
    - name: global-registry-auth
  # for etcd
  imagePullSecrets:
  - global-registry-auth
ingress-nginx:
  imagePullSecrets:
  - name: global-registry-auth
meilisearch:
  image:
    pullSecret: global-registry-auth
```

### 2. 配置 etcd

#### 2.1 配置反亲和性

当在本地节点磁盘上使用存储时（例如，topolvm），为了确保高可用性，etcd pod 需要在不同节点上运行。添加以下配置以实现此目的：

```yaml
etcd:
  podAntiAffinityPreset: hard
```

#### 2.2 配置存储类

通过添加以下配置指定存储类：

```yaml
global:
  storageClass: storage-class-name
```

### 3. 配置仪表板身份验证

#### 3.1 启用 Ingress 身份验证

添加以下配置以启用仪表板的基本身份验证。默认用户名和密码均为 `featureform`。

```yaml
ingress:
  auth:
    enabled: true
    username: featureform # 可选，默认用户名为 featureform
    password: featureform # 可选，默认密码为 featureform
```

## 访问地址

### 1. 外部访问地址

`Featureform` 通过 `nginx-ingress-controller` 提供外部访问。检查其 `Service` 以获取访问地址。

`Service` 名称为： `application-name-ingress-nginx-controller`。

此 `Service` 类型为 `LoadBalancer`。如果环境中没有提供外部 IP 的 `LoadBalancer` 控制器，您可以通过 `node IP` 加上其 `NodePort` 进行访问。

### 2. API 访问地址

`Featureform` SDK 需要访问 API 服务 `featureform-api-server`。

要在集群内访问 API，您可以通过 `featureform-api-server` 的 `ClusterIP` 加上端口 7878 进行访问。

**注意：**

尽管 ingress 配置包含 API 访问地址，但由于 ingress 启用了客户端证书验证机制，而 Featureform SDK 当前不支持配置客户端证书，因此无法通过 ingress 路径访问 API 服务。

# Featureform 快速入门

## 概述

本快速入门演示将引导您完成以下三个主要步骤：

1. **准备数据** - 设置 PostgreSQL 数据库并加载演示数据

2. **配置 Featureform** - 定义数据源、特征和训练集等资源

3. **模拟训练和查询** - 使用定义的特征进行模型训练和特征查询

通过本演示，您将学习如何使用 Featureform 构建特征工程管道，从原始数据到可用的机器学习特征。

## 文件描述

- [setup-env.sh](/featureform/quickstart/setup-env.sh) - 设置演示中使用的环境变量
- [load-data.py](/featureform/quickstart/load-data.py) - 数据库准备脚本，用于连接 PostgreSQL 并执行 data.sql
- [data.sql](/featureform/quickstart/data.sql) - 包含演示数据的 PostgreSQL 数据库转储文件
- [definitions.py](/featureform/quickstart/definitions.py) - Featureform 资源定义文件
- [training.py](/featureform/quickstart/training.py) - 训练脚本
- [serving.py](/featureform/quickstart/serving.py) - 服务脚本
- [requirements.txt](/featureform/quickstart/requirements.txt) - Python 依赖包

## 使用步骤

### 1. 准备 PostgreSQL 和 Redis

确保您有可用的 PostgreSQL 和 Redis 服务。您可以通过以下方式启动它们：

#### 准备 PostgreSQL

使用 `Data Services` 提供的 `PostgreSQL operator` 创建一个 `PostgreSQL 集群`。

在 `Data Services` 的 `PostgreSQL` 实例详细信息中检查访问地址和访问密码。

#### 准备 Redis

使用 `Data Services` 创建一个 `Redis` 实例。

**注意：** Featureform 仅支持以 `standalone` 模式访问 Redis。

- 在 `standalone` 模式下创建 `Redis`：

  1. 创建 `Redis` 实例时，选择 `Redis Sentinel` 作为 `Architecture`。

  2. 设置所有参数后，切换到 `YAML` 模式，将 `spec.arch` 更改为 `standalone`，然后点击 `Create` 按钮。

  3. 创建后，切换到 `Alauda Container Platform` 视图，查找名为 `rfr-<Redis 实例名称>-read-write` 的 `Service`，这是该 Redis 实例的访问地址。

### 2. 安装依赖

**Python 版本要求：**

- 支持 Python 3.7 - 3.10

```bash
pip install -r requirements.txt
```

### 3. 配置环境变量

编辑 `setup-env.sh` 文件以设置数据库连接信息，然后使用以下命令导出环境变量：

```bash
source setup-env.sh
```

#### setup-env.sh 文件内容描述

`setup-env.sh` 文件包含演示所需的所有环境变量配置：

```bash
#!/bin/bash

# Featureform 配置
export FF_GET_EQUIVALENT_VARIANTS=false
export FEATUREFORM_HOST=localhost:7878
export FEATUREFORM_VARIANT=demo

# PostgreSQL 数据库连接配置
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_USER=postgres
export POSTGRES_PASSWORD=password
export POSTGRES_DATABASE=postgres
export POSTGRES_SSLMODE=require

# Redis 连接配置
export REDIS_HOST=localhost
export REDIS_PORT=6379
export REDIS_PASSWORD=""
```

**重要说明：**

- **FF_GET_EQUIVALENT_VARIANTS**：必须设置为 `false` 以避免获取错误的变体版本

- **FEATUREFORM_HOST**：`Featureform` API 地址，请根据您的环境进行配置

- **FEATUREFORM_VARIANT**：由于 Featureform 采用不可变 API，未提供删除和更新接口，因此要重新执行，请将此值修改为新的值，然后重新执行 `source setup-env.sh`，否则可能会出现错误

- **POSTGRES_xx**：请根据您的环境进行配置

- **REDIS_xx**：请根据您的环境进行配置

### 4. 运行数据库准备脚本

```bash
python load-data.py
```

此脚本将：

- 连接到 PostgreSQL 数据库
- 创建必要的数据库（如果不存在）
- 执行 data.sql 文件中的所有 SQL 语句
- data.sql 文件中的 SQL 语句包括创建 transactions 表并插入演示数据

#### 演示数据描述

`data.sql` 文件包含用于演示欺诈检测场景的交易数据集：

- `transactions` 表包含以下字段：
  - `transactionid` - 交易 ID
  - `customerid` - 客户 ID
  - `customerdob` - 客户出生日期
  - `custlocation` - 客户位置
  - `custaccountbalance` - 客户账户余额
  - `transactionamount` - 交易金额
  - `timestamp` - 交易时间戳
  - `isfraud` - 是否为欺诈交易（标签）

该数据集可用于训练机器学习模型以检测欺诈交易。

### 5. 运行 Featureform 定义

```bash
python definitions.py
```

此脚本是 Featureform 演示的核心，将注册和定义所有必要的资源。主要组件包括：

#### 5.1 注册用户和提供者

```python
# 注册默认用户
ff.register_user("demo").make_default_owner()

# 注册 PostgreSQL 提供者
postgres = ff.register_postgres(
    name=f"postgres-{variant}",
    host=os.getenv("POSTGRES_HOST", "localhost"),
    port=os.getenv("POSTGRES_PORT", "5432"),
    user=os.getenv("POSTGRES_USER", "postgres"),
    password=os.getenv("POSTGRES_PASSWORD", "password"),
    database=os.getenv("POSTGRES_DATABASE", "postgres"),
    sslmode=os.getenv("POSTGRES_SSLMODE", "require"),
)

# 注册 Redis 提供者
redis = ff.register_redis(
    name=f"redis-{variant}",
    host=os.getenv("REDIS_HOST", "localhost"),
    port=int(os.getenv("REDIS_PORT", "6379")),
    password=os.getenv("REDIS_PASSWORD", ""),
)
```

#### 5.2 注册数据源

```python
# 注册 transactions 表
transactions = postgres.register_table(
    name="transactions",
    table="transactions",
    variant=variant,
)
```

#### 5.3 定义特征转换

```python
# SQL 转换：计算每个客户的平均交易金额
@postgres.sql_transformation(variant=variant)
def average_user_transaction():
    return f"SELECT CustomerID as user_id, avg(TransactionAmount) " \
           f"as avg_transaction_amt from {{{{transactions.{variant}}}}} GROUP BY user_id"
```

在这里，原始数据被转换为后续使用的新数据。

#### 5.4 定义实体、特征和标签

```python
@ff.entity
class Customer:
    # 特征：客户平均交易金额，其中 avg_transaction_amt 来自上述 average_user_transaction 转换
    avg_transactions = ff.Feature(
        average_user_transaction[["user_id", "avg_transaction_amt"]],
        type=ff.Float32,
        inference_store=redis,
        variant=variant,
    )

    # 标签：是否为欺诈交易
    fraudulent = ff.Label(
        transactions[["customerid", "isfraud"]],
        type=ff.Bool,
        variant=variant,
    )
```

#### 5.5 注册训练集

```python
# 注册训练集，包括标签和特征
ff.register_training_set(
    name="fraud_training",
    label=("fraudulent", variant),
    features=[("avg_transactions", variant)],
    variant=variant,
)
```

#### 5.6 应用定义

```python
# 连接到 Featureform 服务器并应用所有定义
client = ff.Client(host=os.getenv("FEATUREFORM_HOST", "localhost:7878"), insecure=True)
client.apply()
```

`client.apply()` 默认是同步的，这将等待 Featureform 开始处理训练集并等待处理完成。这意味着脚本将阻塞，直到所有资源（包括训练集）被处理。

成功执行将输出如下结果：

```
Applying Run: amazed_volhard
Creating user demo
Creating provider postgres-demo
Creating provider redis-demo
Creating source transactions demo
Creating source average_user_transaction demo
Creating entity customer
Creating feature avg_transactions demo
Creating label fraudulent demo
Creating training-set fraud_training demo

COMPLETED
 Resource Type              Name (Variant)                                      Status      Error
 Provider                   postgres-demo ()                                    READY
 Provider                   redis-demo ()                                       READY
 SourceVariant              transactions (demo)                                 READY
 Transformation             average_user_transaction (demo)                     READY
 FeatureVariant             avg_transactions (demo)                             READY
 LabelVariant               fraudulent (demo)                                   READY
 TrainingSetVariant         fraud_training (demo)                               READY
```

在处理期间，`Status` 将显示为 `PENDING`。

当处理失败时，`Status` 将显示为 `FAILED`，`Error` 将包含相关错误日志。

**此脚本演示了 Featureform 的核心概念：**

- **提供者**：数据源连接器（PostgreSQL、Redis）
- **实体**：业务对象（客户）
- **特征**：机器学习模型的输入（avg_transactions）
- **标签**：模型的训练目标（fraudulent）
- **训练集**：特征和标签的组合
- **变体**：支持多版本管理

### 6. 运行训练脚本

```bash
python training.py
```

此脚本演示了如何使用 Featureform 获取训练数据。让我们看看它的主要组件：

#### 6.1 获取训练集

```python
# 获取之前定义的 fraud_training 训练集
dataset = client.training_set("fraud_training", variant)
```

#### 6.2 训练循环

```python
# 训练循环
for i, data in enumerate(dataset):
    # 训练数据
    print(data)
    # 训练过程
    # 在这里进行训练
    if i > 25:
        break

```

**脚本功能描述：**

- 连接到 Featureform 服务
- 获取名为 "fraud_training" 的训练集
- 迭代训练数据，其中每个 `data` 包含特征和标签
- 在实际应用中，这里数据将真正提交给模型的训练任务

**输出示例：**

```
Features: [array([25.])] , Label: [False]
Features: [array([27999.])] , Label: [True]
Features: [array([459.])] , Label: [False]
Features: [array([2060.])] , Label: [True]
Features: [array([1762.5])] , Label: [False]
Features: [array([676.])] , Label: [False]
Features: [array([566.])] , Label: [False]
...
```

### 7. 运行查询脚本

```bash
python serving.py
```

此脚本演示了如何使用 Featureform 进行特征查询和推理。让我们看看它的主要组件：

#### 7.1 特征查询

```python
# 查询特定客户的特征
customer_feat = client.features(
    features=[("avg_transactions", variant)],
    entities={"customer": "C1214240"},
)

print("客户结果: ")
print(customer_feat)

```

**脚本功能描述：**

- 连接到 Featureform 服务
- 查询客户 ID 为 "C1214240" 的 `avg_transactions` 特征
- 这是实时预测的典型在线推理场景

**输出示例：**

```
客户结果:
[319.0]
```

**实际应用场景：**

- 当新客户进行交易时，实时查询客户的平均交易金额特征
- 与其他特征结合，用于欺诈检测的实时推理
- 支持批量查询多个客户的特征

# 常见问题解答

## 常见问题

### 1. 执行 apply 时出错：

```
"UNKNOWN:Error received from peer  {grpc_message:"grpc: error unmarshalling request: string field contains invalid UTF-8", grpc_status:13"
```

- **原因**：Featureform SDK 版本与服务器版本不匹配
- **解决方案**：更新 Featureform SDK 版本至 1.21.1

### 2. 执行 apply 时出错：

```
"UNKNOWN:Error received from peer  {grpc_message:"resource SOURCE_VARIANT xxxx (xxx) has changed. Please use a new variant.", grpc_status:13}"
```

- **原因**：变体没有改变，但其关联内容已更改。
- **解决方案**：使用新变体重新应用

### 3. 执行 apply 时出错：

```
"UNKNOWN:Error received from peer  {grpc_message:"resource not found. LABEL_VARIANT xxxx (xxx) err: Key Not Found: LABEL_VARIANT__xxxxx__xxxx", grpc_status:5}"
```

- **原因**：引用的变体不存在。
- **解决方案**：使用正确的变体重新应用

### 4. apply 完成后，`Status` 为 `FAILED`，`Error` 为：

```
transformation failed to complete: job failed while running .....
```

- **原因**：Kubernetes Job 执行失败
- **解决方案**：检查 Kubernetes 集群中的 Job 事件和日志，并根据相关信息处理失败

### 5. apply 完成后，`Status` 为 `FAILED`，`Error` 包含以下信息：

```
....create table error: unknown command `HEXISTS` .....
```

- **原因**：Redis 错误地使用了 Sentinel 访问地址
- **解决方案**：更换 Redis 实例或更新 Redis 访问地址

### 6. apply 完成后，`Status` 为 `FAILED`，`Error` 为：

```
Featureform cannot connect to the provider during health check: (REDIS_ONLINE - client_initialization) dial tcp ......
```

- **原因**：Redis 地址不可达
- **解决方案**：检查 Redis 状态或更新 Redis 访问地址

### 7. apply 完成后，`Status` 为 `FAILED`，`Error` 为：

```
Featureform cannot connect to the provider during health check: (POSTGRES_OFFLINE - ping) dial tcp:
```

- **原因**：PostgreSQL 地址不可达
- **解决方案**：检查 PostgreSQL 状态或更新 PostgreSQL 访问地址

### 8. apply 完成后，`Status` 为 `FAILED`，`Error` 为：

```
Featureform cannot connect to the provider during health check: (POSTGRES_OFFLINE - ping) pq: pg_hba.conf rejects connection ....
```

- **原因**：PostgreSQL 访问被拒绝
- **解决方案**：检查配置的 PostgreSQL 用户名、密码和 SSL 模式是否正确，并验证 PostgreSQL 数据库用户权限设置

### 9. apply 完成后，`Status` 卡在 `PENDING`，`coordinator` 容器重启

- **原因**：etcd 监视接口无法处理令牌自动轮换，令牌过期后程序退出并出现错误
- **解决方案**：更新变体并重新执行 apply
