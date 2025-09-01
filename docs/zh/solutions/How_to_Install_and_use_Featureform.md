---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB1756692696-9DEE
sourceSHA: 361e326bb480c16fd4b60b49905320846c923ed811f7f047dbaf7056edae34c2
---

# 特性表单

## 概述

特性表单是一款开源的机器学习特性平台，旨在构建、管理和部署机器学习特性。

它简化了特性工程工作流程，使数据科学家和机器学习工程师能够专注于模型开发，而不是处理特性基础设施的复杂性。

## 核心概念

### 特性

特性是机器学习模型用于进行预测的输入数据。在特性表单中，特性包含以下核心组件：

- **实体列**：作为主键或索引，标识特性所属的对象
- **值列**：特性的具体数值或类别值
- **时间戳列**：可选的时间信息，用于跟踪特性随时间的变化

特性是机器学习模型训练和推理的核心输入，与实体关联，以提供进行预测所需的信息。

特性不是原始数据，而是数据源处理和转换的结果。

原始数据需要经过特性表单的数据源注册、转换处理等步骤，才能成为可用的特性。高质量的特性直接影响训练模型的性能。

例如：

- 在欺诈检测中，原始数据包括用户交易记录，如交易金额、客户出生日期、客户位置等，但用于训练的特性是客户的平均交易金额。

### 标签

标签是机器学习模型旨在预测的目标变量。在监督学习中，标签是已知的正确答案，模型学习特性与标签之间的关系以进行预测。

例如：

- 在欺诈检测中，每笔交易的标签是“欺诈”或“正常”。

### 实体

实体是由特性和标签描述的对象，作为数据的主键或索引。

例如：

- **客户**：用户ID、客户ID等。

实体作为连接特性和标签的桥梁，允许多个特性和标签组织在一起，形成完整的训练数据。在特性表单中，实体通过装饰器定义，并可以与多个特性和标签关联。

### 训练集

训练集是用于训练机器学习模型的数据集合，通过特性和标签中定义的实体字段自动连接。训练集包含：

- **特性值**：模型训练的输入数据
- **标签值**：模型旨在预测的目标值

训练集将特性、标签和实体组织在一起，为模型训练提供完整的数据结构。实体关联通过在定义特性和标签时指定实体列（如用户ID、产品ID等）来实现。特性表单系统根据这些实体列自动连接数据。

## 核心概念关系

- **实体**是数据的主体，定义了我们想要分析的对象
- **特性**与实体关联，提供进行预测所需的属性信息
- **标签**是我们想要预测的目标
- **训练集**将特性、标签和实体组织在一起，形成完整的训练数据

## 提供者（数据基础设施提供者）

提供者是特性表单中的后端系统，负责数据存储和计算。它们提供：

- **离线存储**：存储原始数据，执行数据转换，构建训练集（例如，PostgreSQL、BigQuery、Spark等）
- **在线存储**：为实时推理提供低延迟特性服务（例如，Redis、Pinecone等）
- **文件存储**：为某些离线存储系统提供底层存储支持（例如，S3、HDFS、Azure Blob等）

提供者采用虚拟特性存储架构，使数据科学家能够在现有基础设施上使用统一的抽象接口，同时数据保持在原始系统中。

## 不可变API设计

特性表单采用不可变API设计，这是其与其他特性平台的关键区别。在特性表单中，所有特性、标签和训练集在创建后都是不可变的，这意味着：

- **资源不能被修改**：一旦特性、标签或训练集被创建和应用，其定义和逻辑不能更改
- **版本管理**：如果需要修改，必须创建新的变体，而不是覆盖现有资源
- **协作安全**：团队成员可以安全地使用他人创建的资源，而无需担心上游逻辑的变化
- **实验管理**：支持为实验创建多个变体，每个变体具有独立的生命周期

这种设计确保了机器学习资源的一致性和可靠性，避免了由于资源修改导致的训练失败或推理错误。通过变体系统，数据科学家可以管理不同版本的资源，同时保持生产环境的稳定性。

## 变体

变体是特性表单中实现版本管理和实验支持的核心机制。每个特性、标签或训练集可以有多个变体，每个变体代表不同的版本或实验配置。

### 变体的好处

- **版本管理**：为同一资源创建不同版本，支持A/B测试和实验
- **实验支持**：允许数据科学家尝试不同的特性工程方法，而不影响生产环境
- **协作开发**：团队成员可以并行开发不同的变体，而不相互干扰
- **回滚支持**：当新版本出现问题时，快速回滚到先前的稳定版本

## 文档和参考

特性表单提供全面的官方文档和SDK参考，帮助用户有效理解和使用平台特性：

### 官方文档

- **主文档**： <https://docs.featureform.com/>
  - 对特性表单核心概念和工作流程的全面介绍
  - 包括架构设计、部署指南和最佳实践
  - 提供常见用例和示例代码

### SDK参考

- **Python SDK**： <https://sdk.featureform.com/>
  - 完整的Python API参考文档
  - 支持本地模式和托管实例
  - 包括所有操作的详细描述，如注册、应用和服务

## 系统架构

特性表单采用微服务架构，具有以下核心组件：

### 核心服务

1. **API服务器**
   - 提供gRPC API接口
   - 充当gRPC网关，将请求转发到元数据服务和特性服务器
   - 向外部提供统一的资源管理和特性服务接口

2. **协调器**
   - 监控etcd中的任务变化
   - 协调任务调度和执行
   - 管理各种运行器以执行特定任务

3. **特性服务器**
   - 提供特性服务（在线特性查询、批量特性服务）
   - 提供训练数据服务（训练集数据、列信息）
   - 提供向量搜索功能（支持嵌入特性）

4. **元数据服务**
   - 提供用于元数据管理的gRPC接口
   - 存储所有资源的定义和元数据（特性、标签、训练集、源数据等）
   - 管理资源之间的依赖关系和状态

### 数据存储

1. **etcd**
   - 存储配置信息和集群状态
   - 提供分布式锁和协调服务

2. **Meilisearch**
   - 提供特性和元数据的搜索功能
   - 支持全文搜索和模糊匹配
   - 数据源：资源变化时，元数据服务自动写入，元数据仪表板在标签更新时写入

### 监控和可观察性

1. **Prometheus**
   - 收集系统指标和性能数据
   - 为仪表板提供指标查询支持

2. **仪表板**
   - 提供查看系统状态的Web界面
   - 显示特性统计、性能指标和资源信息
   - 纯前端页面，仅提供只读查看功能

3. **元数据仪表板**
   - 提供访问元数据服务的HTTP API接口
   - 将元数据服务的gRPC接口转换为HTTP接口
   - 为仪表板前端提供资源查询、搜索和标签管理功能
   - 支持源数据预览和文件统计

### 网络和访问

1. **Ingress控制器（Nginx）**
   - 管理外部流量路由和负载均衡
   - 提供SSL终止和反向代理
   - 处理HTTP请求和缓存功能

## 组件调用关系

```
用户 → 仪表板
          ↓
   Ingress控制器（Nginx）
     ↓                   ↓
  Prometheus       元数据仪表板 → Meilisearch
     │                ↓        ↓        ↑
     │ 协调器 → etcd ← 元数据服务 ← API服务器 ← SDK客户端
     │                ↑        ↑                  │
     └────────────→ 特性服务器 ←──────────────┘

```

# 特性表单部署指南

本文档提供了如何将特性表单部署到Kubernetes集群的详细说明，以及必要的配置参数。

## 发布

下载特性表单安装文件： `featureform.amd64.v0.12.1-1.tgz`

使用violet命令发布到平台仓库：

```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password featureform.amd64.v0.12.1-1.tgz
```

## 部署

### 限制

**每个命名空间仅允许一个`Featureform`应用。**

在同一命名空间中部署多个实例可能会导致资源冲突和其他问题。

**架构支持限制：仅支持x86架构，不支持ARM架构。**

### 存储准备

特性表单数据存储在etcd中，需要持久存储以确保数据持久性。
集群需要安装CSI或`创建本地存储`（方法如下所述，仅限非生产环境）。

#### 创建本地存储

使用kubectl create创建以下资源，以准备本地目录作为PersistentVolumes供使用。

```yaml
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: etcd-1
spec:
  capacity:
    storage: 10Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  local:
    path: /var/lib/etcd-1
  nodeAffinity:
    required:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: In
          values:
          - xxx.xxx.xxx.xxx
```

注意事项：

1. 在spec.local.path中指定的路径必须存在并设置为777权限，例如：
   `bash
       mkdir -p /var/lib/etcd-1
       chmod 777 /var/lib/etcd-1
       `

2. 根据您的环境替换matchExpressions中的占位符值xxx.xxx.xxx.xxx。

3. 在部署高可用性etcd时，根据副本数量准备多个`PersistentVolume`。

###

### 创建应用

1. 转到`Alauda容器平台`视图，选择将要部署特性表单的命名空间。

2. 在左侧导航中选择`应用` / `应用程序`，然后单击打开页面右侧的`创建`按钮。

3. 在弹出对话框中，选择`从目录创建`，然后页面将跳转到`目录`视图。

4. 找到`3rdparty/chart-featureform`，然后单击`创建`以创建此应用。

5. 在`目录` / `创建特性表单`表单中，填写`名称`（建议填写为`featureform`）和`自定义`配置在`值`中，然后单击`创建`按钮以完成创建。`自定义`的内容将在下面描述。您也可以通过`更新`应用方法在创建后进行修改。

## 配置

用户可以修改`应用`的`自定义值`以调整配置。关键配置如下：

### 1. 配置镜像仓库

#### 1.1 配置镜像仓库地址

尽管`Chart`已经配置了`ImageWhiteList`以自动替换工作负载使用的镜像。

但是，当使用Kubernetes Jobs运行`Featureform`任务时，镜像拉取失败可能导致任务失败。因此，建议配置正确的镜像注册表地址。

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

如何获取`镜像仓库地址`：

- 在`管理员`视图中，查看相应集群详细信息页面的`概述`选项卡下的`镜像仓库地址`字段。

#### 1.2 配置镜像仓库拉取凭据

如果在从镜像仓库拉取镜像时需要身份验证，请添加以下配置：

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

### 2. 配置etcd

#### 2.1 配置反亲和性

当使用本地节点磁盘上的存储（例如，topolvm）时，为确保高可用性，etcd pods需要在不同的节点上运行。添加以下配置以实现此目的：

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

## 访问地址

### 1. 外部访问地址

`Featureform`通过`nginx-ingress-controller`提供外部访问。检查其`服务`以获取访问地址。

`服务`名称为：`application-name-ingress-nginx-controller`。

此`服务`类型为`LoadBalancer`。如果环境中没有`LoadBalancer`控制器提供外部IP，则可以通过`节点IP`加其`NodePort`进行访问。

### 2. API访问地址

`Featureform` SDK需要访问API服务`featureform-api-server`。

要在集群内访问API，可以通过`featureform-api-server`的`ClusterIP`加端口7878进行访问。

**注意：**

尽管ingress配置包含API访问地址，但由于ingress启用了客户端证书验证机制，而特性表单SDK目前不支持配置客户端证书，因此无法通过ingress路径访问API服务。

# 特性表单快速入门

## 概述

本快速入门演示将引导您完成以下三个主要步骤：

1. **准备数据** - 设置PostgreSQL数据库并加载演示数据

2. **配置特性表单** - 定义数据源、特性和训练集等资源

3. **模拟训练和查询** - 使用定义的特性进行模型训练和特性查询

通过本演示，您将学习如何使用特性表单构建特性工程管道，从原始数据到可用的机器学习特性。

## 文件描述

- [setup-env.sh](/featureform/quickstart/setup-env.sh) - 设置演示所需的环境变量
- [load-data.py](/featureform/quickstart/load-data.py) - 连接到PostgreSQL并执行data.sql的数据库准备脚本
- [data.sql](/featureform/quickstart/data.sql) - 包含演示数据的PostgreSQL数据库转储文件
- [definitions.py](/featureform/quickstart/definitions.py) - 特性表单资源定义文件
- [training.py](/featureform/quickstart/training.py) - 训练脚本
- [serving.py](/featureform/quickstart/serving.py) - 服务脚本
- [requirements.txt](/featureform/quickstart/requirements.txt) - Python依赖包

## 使用步骤

### 1. 准备PostgreSQL和Redis

确保您有可用的PostgreSQL和Redis服务。您可以通过以下方式启动它们：

#### 准备PostgreSQL

使用`数据服务`提供的`PostgreSQL operator`创建一个`PostgreSQL集群`。

在`数据服务`的`PostgreSQL`实例详细信息中检查访问地址和访问密码。

#### 准备Redis

使用`数据服务`创建一个`Redis`实例。

**注意：** 特性表单仅支持以`standalone`模式访问Redis。

- 在`standalone`模式下创建`Redis`：

  1. 创建`Redis`实例时，选择`Redis Sentinel`作为`架构`。

  2. 设置所有参数后，切换到`YAML`模式，将`spec.arch`更改为`standalone`，然后单击`创建`按钮。

  3. 创建后，切换到`Alauda容器平台`视图，查找名为`rfr-<Redis实例名称>-read-write`的`服务`，这是该Redis实例的访问地址。

### 2. 安装依赖

**Python版本要求：**

- 支持Python 3.7 - 3.10

```bash
pip install -r requirements.txt
```

### 3. 配置环境变量

编辑`setup-env.sh`文件以设置数据库连接信息，然后使用以下命令导出环境变量：

```bash
source setup-env.sh
```

#### setup-env.sh文件内容描述

`setup-env.sh`文件包含演示所需的所有环境变量配置：

```bash
#!/bin/bash

# 特性表单配置
export FF_GET_EQUIVALENT_VARIANTS=false
export FEATUREFORM_HOST=localhost:7878
export FEATUREFORM_VARIANT=demo

# PostgreSQL数据库连接配置
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_USER=postgres
export POSTGRES_PASSWORD=password
export POSTGRES_DATABASE=postgres
export POSTGRES_SSLMODE=require

# Redis连接配置
export REDIS_HOST=localhost
export REDIS_PORT=6379
export REDIS_PASSWORD=""
```

**重要说明：**

- **FF_GET_EQUIVALENT_VARIANTS**：必须设置为`false`以避免获取错误的变体版本

- **FEATUREFORM_HOST**：`Featureform` API地址，请根据您的环境进行配置

- **FEATUREFORM_VARIANT**：由于特性表单采用不可变API，不提供删除和更新接口，因此要重新执行，请将此值修改为新的值，然后重新执行`source setup-env.sh`，否则可能会出现错误

- **POSTGRES_xx**：请根据您的环境进行配置

- **REDIS_xx**：请根据您的环境进行配置

### 4. 运行数据库准备脚本

```bash
python load-data.py
```

该脚本将：

- 连接到PostgreSQL数据库
- 创建必要的数据库（如果不存在）
- 执行data.sql文件中的所有SQL语句
- data.sql文件中的SQL语句包括创建交易表和插入演示数据

#### 演示数据描述

`data.sql`文件包含用于演示欺诈检测场景的交易数据集：

- `transactions`表包含以下字段：
  - `transactionid` - 交易ID
  - `customerid` - 客户ID
  - `customerdob` - 客户出生日期
  - `custlocation` - 客户位置
  - `custaccountbalance` - 客户账户余额
  - `transactionamount` - 交易金额
  - `timestamp` - 交易时间戳
  - `isfraud` - 是否为欺诈交易（标签）

该数据集可用于训练机器学习模型以检测欺诈交易。

### 5. 运行特性表单定义

```bash
python definitions.py
```

该脚本是特性表单演示的核心，将注册和定义所有必要的资源。主要组件如下：

#### 5.1 注册用户和提供者

```python
# 注册默认用户
ff.register_user("demo").make_default_owner()

# 注册PostgreSQL提供者
postgres = ff.register_postgres(
    name=f"postgres-{variant}",
    host=os.getenv("POSTGRES_HOST", "localhost"),
    port=os.getenv("POSTGRES_PORT", "5432"),
    user=os.getenv("POSTGRES_USER", "postgres"),
    password=os.getenv("POSTGRES_PASSWORD", "password"),
    database=os.getenv("POSTGRES_DATABASE", "postgres"),
    sslmode=os.getenv("POSTGRES_SSLMODE", "require"),
)

# 注册Redis提供者
redis = ff.register_redis(
    name=f"redis-{variant}",
    host=os.getenv("REDIS_HOST", "localhost"),
    port=int(os.getenv("REDIS_PORT", "6379")),
    password=os.getenv("REDIS_PASSWORD", ""),
)
```

#### 5.2 注册数据源

```python
# 注册交易表
transactions = postgres.register_table(
    name="transactions",
    table="transactions",
    variant=variant,
)
```

#### 5.3 定义特性转换

```python
# SQL转换：计算每个客户的平均交易金额
@postgres.sql_transformation(variant=variant)
def average_user_transaction():
    return f"SELECT CustomerID as user_id, avg(TransactionAmount) " \
           f"as avg_transaction_amt from {{{{transactions.{variant}}}}} GROUP BY user_id"
```

在这里，原始数据被转换为后续使用的新数据。

#### 5.4 定义实体、特性和标签

```python
@ff.entity
class Customer:
    # 特性：客户平均交易金额，其中avg_transaction_amt来自上面的average_user_transaction转换
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
# 注册训练集，包括标签和特性
ff.register_training_set(
    name="fraud_training",
    label=("fraudulent", variant),
    features=[("avg_transactions", variant)],
    variant=variant,
)
```

#### 5.6 应用定义

```python
# 连接到特性表单服务器并应用所有定义
client = ff.Client(host=os.getenv("FEATUREFORM_HOST", "localhost:7878"), insecure=True)
client.apply()
```

`client.apply()`默认是同步的，这将等待特性表单开始处理训练集，并等待处理完成。这意味着脚本将在所有资源（包括训练集）处理完成之前阻塞。

成功执行将输出如下结果：

```
应用运行：amazed_volhard
创建用户demo
创建提供者postgres-demo
创建提供者redis-demo
创建源transactions demo
创建源average_user_transaction demo
创建实体customer
创建特性avg_transactions demo
创建标签fraudulent demo
创建训练集fraud_training demo

完成
 资源类型              名称（变体）                                      状态      错误
 提供者                   postgres-demo ()                                    准备就绪
 提供者                   redis-demo ()                                       准备就绪
 源变体              transactions (demo)                                 准备就绪
 转换             average_user_transaction (demo)                     准备就绪
 特性变体             avg_transactions (demo)                             准备就绪
 标签变体               fraudulent (demo)                                   准备就绪
 训练集变体         fraud_training (demo)                               准备就绪
```

在处理期间，`状态`将显示为`PENDING`。

当处理失败时，`状态`将显示为`FAILED`，`错误`将包含相关错误日志。

**该脚本演示了特性表单的核心概念：**

- **提供者**：数据源连接器（PostgreSQL、Redis）
- **实体**：业务对象（客户）
- **特性**：机器学习模型的输入（avg_transactions）
- **标签**：模型的训练目标（fraudulent）
- **训练集**：特性和标签的组合
- **变体**：支持多版本管理

### 6. 运行训练脚本

```bash
python training.py
```

该脚本演示了如何使用特性表单获取训练数据。让我们看看其主要组件：

#### 6.1 获取训练集

```python
# 获取之前定义的fraud_training训练集
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

- 连接到特性表单服务
- 获取名为“fraud_training”的训练集
- 遍历训练数据，其中每个`data`包含特性和标签
- 在实际应用中，这里将真正提交数据到模型的训练任务

**输出示例：**

```
特性: [array([25.])] , 标签: [False]
特性: [array([27999.])] , 标签: [True]
特性: [array([459.])] , 标签: [False]
特性: [array([2060.])] , 标签: [True]
特性: [array([1762.5])] , 标签: [False]
特性: [array([676.])] , 标签: [False]
特性: [array([566.])] , 标签: [False]
...
```

### 7. 运行查询脚本

```bash
python serving.py
```

该脚本演示了如何使用特性表单进行特性查询和推理。让我们看看其主要组件：

#### 7.1 特性查询

```python
# 查询特定客户的特性
customer_feat = client.features(
    features=[("avg_transactions", variant)],
    entities={"customer": "C1214240"},
)

print("客户结果: ")
print(customer_feat)

```

**脚本功能描述：**

- 连接到特性表单服务
- 查询客户ID为"C1214240"的`avg_transactions`特性
- 这是实时预测的典型在线推理场景

**输出示例：**

```
客户结果:
[319.0]
```

**实际应用场景：**

- 当新客户进行交易时，实时查询客户的平均交易金额特性
- 与其他特性结合，用于欺诈检测的实时推理
- 支持对多个客户的特性进行批量查询

# 常见问题解答

## 常见问题

### 1. 执行apply时出错：

```
"UNKNOWN:Error received from peer  {grpc_message:"resource SOURCE_VARIANT xxxx (xxx) has changed. Please use a new variant.", grpc_status:13}"
```

- **原因**：变体没有改变，但其关联内容已更改。
- **解决方案**：使用新的变体重新应用

### 2. 执行apply时出错：

```
"UNKNOWN:Error received from peer  {grpc_message:"resource not found. LABEL_VARIANT xxxx (xxx) err: Key Not Found: LABEL_VARIANT__xxxxx__xxxx", grpc_status:5}"
```

- **原因**：引用的变体不存在。
- **解决方案**：使用正确的变体重新应用

### 3. apply完成后，`状态`为`FAILED`，`错误`为：

```
transformation failed to complete: job failed while running .....
```

- **原因**：Kubernetes Job执行失败
- **解决方案**：检查Kubernetes集群中的Job事件和日志，并根据相关信息处理失败

### 4. apply完成后，`状态`为`FAILED`，`错误`包含以下信息：

```
....create table error: unknown command `HEXISTS` .....
```

- **原因**：Redis错误地使用了Sentinel访问地址
- **解决方案**：替换Redis实例或更新Redis访问地址

### 5. apply完成后，`状态`为`FAILED`，`错误`为：

```
Featureform cannot connect to the provider during health check: (REDIS_ONLINE - client_initialization) dial tcp ......
```

- **原因**：Redis地址不可达
- **解决方案**：检查Redis状态或更新Redis访问地址

### 6. apply完成后，`状态`为`FAILED`，`错误`为：

```
Featureform cannot connect to the provider during health check: (POSTGRES_OFFLINE - ping) dial tcp:
```

- **原因**：PostgreSQL地址不可达
- **解决方案**：检查PostgreSQL状态或更新PostgreSQL访问地址

### 7. apply完成后，`状态`为`FAILED`，`错误`为：

```
Featureform cannot connect to the provider during health check: (POSTGRES_OFFLINE - ping) pq: pg_hba.conf rejects connection ....
```

- **原因**：PostgreSQL访问被拒绝
- **解决方案**：检查配置的PostgreSQL用户名、密码和SSL模式是否正确，并验证PostgreSQL数据库用户权限设置
