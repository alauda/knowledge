---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB1762309013-4C37
sourceSHA: de62ac771d9db6c326ce6a20a4713807868944f71427b629c6aa91caeef42adb
---

# Langflow

## 概述

Langflow 是一个开源低代码工具，用于可视化构建和部署 AI 代理和工作流。它提供了一个拖放编辑器，可以快速创建、测试和迭代 AI 应用程序。Langflow 基于 Python 构建，包含一个 FastAPI 后端和一个基于 React 的可视化编辑器。它默认支持 SQLite，并建议在生产环境中使用 PostgreSQL。

它包含以下主要组件：

- **前端界面**：基于 React 的可视化编辑器，支持拖放流程构建和实时测试
- **后端服务**：基于 FastAPI 的网络服务，提供 REST API 和 MCP（模型上下文协议）支持
- **数据库**：支持 SQLite（默认）和 PostgreSQL（推荐用于生产）

## 核心概念

Langflow 是围绕几个核心概念构建的：**流程**（组织 AI 逻辑的可视化工作流）、**组件**（可重用的功能单元）、**代理**（具有工具调用和推理能力的智能代理）和 **API/MCP** 集成（支持 REST API 和模型上下文协议）。

Langflow 提供了一个拖放可视化界面，用于构建具有实时测试功能的 AI 应用程序，并拥有丰富的模板库。它支持多个 LLM 提供商、嵌入模型和向量数据库，能够实现灵活的多模型配置。该平台提供开发的 IDE 模式和生产部署的运行时模式，适合实验和企业使用。

有关核心概念、功能和使用的详细信息，请参阅 [官方文档](https://docs.langflow.org/)。

## 文档和参考

- **官方文档**：<https://docs.langflow.org/>
- **GitHub 仓库**：<https://github.com/langflow-ai/langflow>

# Langflow 部署指南

本节提供有关如何将 Langflow 部署到 Kubernetes 集群的详细说明和常见配置参数。

## 发布

下载 Langflow 安装文件：`langflow.ALL.v1.6.4-1.tgz`

使用 violet 命令发布到平台仓库：

```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password langflow.ALL.v1.6.4-1.tgz
```

## 部署

### 准备存储

Langflow 支持两种数据库模式：

- **SQLite（默认）**：用于开发和测试，数据存储在持久卷中
- **PostgreSQL（推荐）**：用于生产环境，提供更好的性能和可扩展性

集群需要预先安装 CSI 或预先准备 `PersistentVolume`。

### 准备数据库

#### 使用 SQLite（默认）

SQLite 是 Langflow 的默认数据库，适合开发和测试环境：

- 数据存储在持久卷中
- 配置简单，无需额外设置
- 支持单实例部署

#### 使用 PostgreSQL（推荐）

强烈建议在生产环境中使用 PostgreSQL，以获得更好的性能和可扩展性：

可以使用 `Data Services` 提供的 `PostgreSQL operator` 创建 `PostgreSQL 集群`。

检查 `Data Services` 中 `PostgreSQL` 实例详细信息中的访问地址和密码。

**注意**：

- 推荐使用 PostgreSQL 版本 12 或更高
- 需要创建单独的数据库和用户
- 确保网络连接

### 创建应用程序

1. 转到 `Alauda Container Platform` 视图，选择将要部署 Langflow 的命名空间。

2. 在左侧导航中选择 `Applications` / `Applications`，然后点击右侧页面的 `Create` 按钮。

3. 在弹出对话框中选择 `Create from Catalog`，然后页面将跳转到 `Catalog` 视图。

4. 找到 `3rdparty/chart-langflow` 并点击 `Create` 创建此应用程序。

5. 在 `Catalog` / `Create langflow` 表单中，填写 `Name`（推荐为 `langflow`）和 `Values` 中的 `Custom` 配置，然后点击 `Create` 按钮完成创建。`Custom` 内容将在下面描述。创建后也可以通过 `Update` 应用程序方法进行修改。

## 配置

用户可以修改 `Application` 的 `Custom Values` 以调整配置。主要关注的配置如下：

### 1. 配置存储

#### 1.1 配置 SQLite 存储（默认）

可以通过添加以下配置来指定存储类和大小：

```yaml
langflow:
  sqlite:
    volume:
      storageClassName: storage-class-name     # 替换为实际的存储类名称
      size: 1Gi                                # 替换为实际所需空间大小
```

**注意**：使用 SQLite 时，仅支持单实例部署（replicaCount = 1）。

### 2. 配置数据库

#### 2.1 启用 PostgreSQL

可以通过设置以下字段配置 PostgreSQL 访问信息：

```yaml
langflow:
  externalDatabase:
    enabled: true                              # 启用外部数据库
    driver:
      value: "postgresql"
    host:
      value: postgres-host                     # PostgreSQL 访问地址
    port:
      value: "5432"                            # PostgreSQL 访问端口，默认：5432
    database:
      value: langflow                          # 数据库名称，注意：数据库将自动创建
    user:
      value: langflow                          # 数据库用户名
    password:
      valueFrom:
        secretKeyRef:
          name: postgres-secret                # 存储数据库访问密码的秘密名称
          key: password                        # 存储数据库访问密码的秘密键
```

**注意**：由于临时存储限制，当前版本暂时不支持多实例部署。即使配置了 PostgreSQL 数据库，仅支持单实例部署（replicaCount = 1）。

### 3. 配置访问方式

默认情况下，使用 `LoadBalancer` 提供访问地址。

#### 3.1 修改服务类型

可以通过设置以下字段修改 `Service` 类型：

```yaml
langflow:
  service:
    type: LoadBalancer                         # 可以更改为 NodePort 或 ClusterIP
    port: 7860                                 # 服务端口
```

#### 3.2 启用 Ingress

可以通过设置以下字段配置 Ingress。启用 Ingress 后，服务类型通常更改为 ClusterIP：

```yaml
ingress:
  enabled: true                                # 启用 Ingress 功能
  hosts:
    - host: langflow.example.com               # 访问域名（必须是 DNS 名称，而不是 IP 地址）
      paths:
        - path: /
  tls:
    - secretName: langflow-tls                 # 存储 TLS 证书的秘密名称
      hosts:
        - langflow.example.com
```

### 4. 配置身份验证和用户管理（可选）

#### 4.1 启用用户身份验证

可以通过设置以下字段启用用户身份验证：

```yaml
langflow:
  auth:
    enabled: true                              # 启用身份验证
    superuser:
      username: langflow                       # 超级用户名称
      password: ""                             # 超级用户密码，未设置时自动生成
    secretKey: ""                              # 秘密密钥，未设置时自动生成
    newUserActive: false                       # 新用户是否需要激活
    enableSuperuserCLI: false                  # 是否启用 CLI 超级用户
    accessTokenExpireSeconds: 3600             # 访问令牌过期时间（秒）
    refreshTokenExpireSeconds: 604800          # 刷新令牌过期时间（秒）
```

启用身份验证后，默认情况下：

- 需要登录才能访问
- 可以配置超级用户
- 新用户只能通过超级用户在 `/admin` 页面添加（不支持自我注册）
- 新用户账户激活：如果 `newUserActive=true`，新用户账户将自动激活；如果 `newUserActive=false`（默认），超级用户需要手动激活

### 5. 配置 OAuth2 代理（可选）

可以通过设置以下字段配置 OAuth2 代理，以提供单点登录功能：

```yaml
oauth2_proxy:
  enabled: true                                # 启用 OAuth2 代理
  oidcIssuer: "https://x.x.x.com/dex"          # OIDC 发行者地址
  oidcClientID: "your-client-id"               # OIDC 客户端 ID
  oidcClientSecret: "your-client-secret"       # OIDC 客户端密钥（建议使用 Secret）
```

要将 `Alauda Container Platform` 配置为 OIDC 提供者，请按如下方式配置：

- `oauth2_proxy.oidcIssuer` 是平台访问地址加上 `/dex`
- `oauth2_proxy.oidcClientID` 固定为 `langflow`
- `oauth2_proxy.oidcClientSecret` 固定为 `ZXhhbXBsZS1hcHAtc2VjcmV0`

还需要在 global 集群中创建 OAuth2Client 资源以配置 Langflow 的客户端信息：

```yaml
apiVersion: dex.coreos.com/v1
kind: OAuth2Client
metadata:
  name: nrqw4z3gnrxxps7sttsiiirdeu
  namespace: cpaas-system
id: langflow                                   # 与 values 中的 oauth2_proxy.oidcClientID 一致
name: Langflow
secret: ZXhhbXBsZS1hcHAtc2VjcmV0               # 与 values 中的 oauth2_proxy.oidcClientSecret 一致
redirectURIs:
- http://xxx.xxx.xxxx.xxx:xxxxx/*              # OAuth2-Proxy 访问地址，获取方法如下
                                               # 如果部署多个 Langflow 实例，请在此处添加多个访问地址
```

**注意**：OAuth2 代理访问地址可以从 `<Application Name>-oauth2-proxy` 服务中获取，根据服务类型使用适当的访问方法。

启用 OAuth2 代理后，建议：

- 将 `langflow.service.type` 设置为 `ClusterIP`，仅允许在集群内访问。用户需要通过 OAuth2 代理地址访问 Langflow。
- 将 `langflow.auth.enabled` 设置为 `false`。使用 OAuth2 代理处理登录身份验证。

用户可以通过访问 `/oauth2/sign_out` 登出。

### 6. 配置运行时模式（仅后端）

运行时模式是推荐的生产环境部署方法，仅部署 Langflow 后端 API 服务，而不提供可视化界面。

#### 6.1 启用运行时模式

可以通过设置以下字段启用运行时模式（仅后端）：

```yaml
langflow:
  backendOnly: true                            # 启用仅后端模式
  env:
    - name: LANGFLOW_LOAD_FLOWS_PATH           # 设置加载 Flows 的路径
      value: "/app/flows"
  volumes:
    - name: flows                              # 通过卷加载 Flows 内容
      persistentVolumeClaim:                   # 从 PVC 或其他卷
        claimName: langflow-flows-pvc
  volumeMounts:                                # 将卷挂载到指定路径
    - name: flows
      mountPath: /app/flows
```

启用 `LANGFLOW_LOAD_FLOWS_PATH` 时，必须禁用身份验证，即 `langflow.auth.enabled` 必须设置为 `false`。

## 访问地址

### 1. 通过服务访问

`Langflow` 通过 `Service` 提供外部访问。检查其 `Service` 以获取访问地址。

- 如果未启用 OAuth2 代理，服务名称为：`<Application Name>`
- 如果启用 OAuth2 代理，服务名称为：`<Application Name>-oauth2-proxy`

如果 `Service` 类型为 `LoadBalancer`，并且环境中的负载均衡控制器已分配访问地址，请通过该地址访问。

如果 `Service` 类型为 `LoadBalancer` 或 `NodePort`，可以通过 `node IP` 及其 `NodePort` 进行访问。

### 2. 通过 Ingress 访问

如果启用了 Ingress，请通过配置的域名访问。

# Langflow 快速入门

有关快速入门指南，请参阅官方文档：<https://docs.langflow.org/get-started-quickstart>

# 生产环境建议

本节提供在生产环境中使用 Langflow 的实用建议和优化配置。

## 1. 通过 ConfigMap 导入现有流程

在生产环境中，可以通过 Kubernetes ConfigMap 将现有流程文件导入 Langflow。

### 1.1 创建包含流程 JSON 的 ConfigMap

首先，创建一个包含流程 JSON 文件的 ConfigMap：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: langflow-flows
  namespace: <Langflow namespace>
data:
  project1.json: |
    <JSON content>
```

### 1.2 将 ConfigMap 挂载到容器

在 Langflow 配置中，将 ConfigMap 挂载到容器中的指定目录：

```yaml
langflow:
  volumes:
    - name: flows
      configMap:
        name: langflow-flows                   # ConfigMap 名称
  volumeMounts:
    - name: flows
      mountPath: /app/flows                    # 挂载路径
  env:
    - name: LANGFLOW_LOAD_FLOWS_PATH           # 设置加载流程文件的路径
      value: /app/flows
```

### 1.3 自动导入

配置完成后，Langflow 将在启动时自动扫描并导入 `LANGFLOW_LOAD_FLOWS_PATH` 目录中的 JSON 文件。

## 2. 使用模型

在生产环境中，可以通过两种方式加载和使用模型：通过 API 调用远程模型或通过卷挂载加载本地模型。根据具体需求选择适当的方法。

### 2.1 调用远程模型

这种方法适用于以下场景：

- 模型有显著的资源需求
- 模型需要在多个服务之间共享
- 需要独立的扩展和资源管理
- 模型版本管理和更新需要单独处理

远程模型可以是自部署的模型服务或供应商提供的第三方模型服务。要在 Langflow 中使用远程模型，在流程编辑器中，使用基于 API 的模型组件（例如 OpenAI、Custom API 等）通过配置 API 基础 URL 和身份验证凭据连接到模型服务端点。

### 2.2 加载本地模型

这种方法适用于以下场景：

- 模型的资源开销较低（例如，嵌入模型）
- 模型大小和资源消耗在 Langflow 容器内可控
- 需要直接文件访问模型

#### 2.2.1 通过卷挂载模型文件

将模型文件存储在持久卷中，并通过卷挂载将其提供给 Langflow 容器：

```yaml
langflow:
  volumes:
    - name: models                             # 模型存储卷
      persistentVolumeClaim:
        claimName: langflow-models-pvc
  volumeMounts:                                # 将模型卷挂载到指定路径
    - name: models
      mountPath: /opt/models
```

#### 2.2.2 上传模型

用户可以使用 `kubectl cp` 命令将模型上传到 Langflow 容器，如下所示：

```bash
kubectl cp <local model path> -n <Langflow namespace> <Langflow Pod name>:/opt/models
```

#### 2.2.3 在组件中配置本地模型

在 Langflow 的流程编辑器中，使用相应的模型组件时，可以将本地模型访问路径配置为 `/opt/models`。

## 3. 添加额外的 Python 依赖

在生产环境中，当使用自定义组件时，可能需要安装额外的 Python 包。可以按如下方式进行：

### 3.1 通过 PVC 挂载依赖

使用 PVC 挂载一个目录以存储额外的 Python 包。

```yaml
langflow:
  volumes:
    - name: python-packages
      persistentVolumeClaim:
        claimName: langflow-packages-pvc       # 存储额外 Python 包的 PVC 名称
  volumeMounts:
    - name: python-packages
      mountPath: /opt/python-packages          # 挂载路径
  env:
    - name: PYTHONPATH                         # 设置 Python 模块搜索路径
      value: "/opt/python-packages"
```

### 3.2 安装依赖

安装依赖包时，使用 `pip --target` 参数将包安装到 PVC 挂载的目录：

```bash
# 在容器中执行，将包安装到 PVC 挂载的目录
pip install --target /opt/python-packages package-name

# 或从 requirements.txt 安装
pip install --target /opt/python-packages -r requirements.txt
```

## 4. 通过环境变量传递全局变量

流程组件配置通常需要在不同环境中使用不同的值。Langflow 的全局变量功能允许将这些特定于环境的值与流程定义分开。全局变量的值可以从环境变量加载。

### 4.1 配置环境变量

在 `Custom Values` 中添加环境变量，如下所示：

```yaml
langflow:
  env:
    - name: LANGFLOW_VARIABLES_TO_GET_FROM_ENVIRONMENT
      value: VAR1,VAR2,VAR3                    # 列出 Langflow 可以自动加载的环境变量名称，以逗号分隔
    - name: VAR1                               # 设置环境变量值，环境变量名称与 Langflow 全局变量名称匹配
      value: xxx
    - name: VAR2                               # 也可以从 ConfigMap 加载值
      valueFrom:
        configMapKeyRef:
          name: langflow-configs
          key: var2
    - name: VAR3                               # 敏感信息应使用 Secret 存储
      valueFrom:
        secretKeyRef:
          name: langflow-secrets
          key: var3
```

### 4.2 在流程中使用全局变量

在 Langflow 的流程编辑器中：

1. 转到 **设置** 页面
2. 在 **全局变量** 部分，添加全局变量并设置其值
3. 在组件配置中引用这些全局变量
4. 导出流程时，**必须**选择“与我的 API 密钥一起保存”，否则全局变量配置可能不会包含在导出的 JSON 文件中

## 5. 优化建议

为提高生产环境中的性能、安全性和稳定性，建议进行以下优化配置：

### 5.1 禁用使用跟踪

Langflow 默认收集使用数据。在生产环境中，可以禁用此功能以保护隐私并减少网络请求：

```yaml
langflow:
  env:
    - name: DO_NOT_TRACK                       # 禁用使用跟踪
      value: "true"
```

### 5.2 禁用事务日志

在每次请求处理期间，Langflow 会将每个组件的输入、输出和执行日志记录到数据库中，这些信息显示在 Langflow IDE 的日志面板中。
在生产环境中，可以禁用此日志记录以提高性能并减少数据库压力。

```yaml
langflow:
  env:
    - name: LANGFLOW_TRANSACTIONS_STORAGE_ENABLED
      value: "false"                           # 禁用事务日志
```

### 5.3 设置工作进程数量

```yaml
langflow:
  numWorkers: 1                                # 设置工作进程数量
```

### 5.4 配置资源限制

建议为 Langflow 容器配置适当的资源限制。以下 YAML 仅为示例；根据实际需求调整值：

```yaml
langflow:
  resources:
    requests:
      cpu: "2"
      memory: "4Gi"
    limits:
      cpu: "4"
      memory: "8Gi"
```

### 5.5 设置 API 密钥

1. 转到 **设置** 页面
2. 在 **Langflow API 密钥** 部分，添加 API 密钥
3. 在进行 API 请求时，添加 `x-api-key: <API Key>` 头；否则将返回 401 错误（未经授权的请求）

### 5.6 禁用 UI

运行时模式允许 Langflow 在没有浏览器界面的情况下运行，适合生产环境中的 API 服务场景。

```yaml
langflow:
  backendOnly: true                            # 启用仅后端模式
```

### 5.7 参考官方文档

有关发布流程和生产最佳实践的更详细信息，请参阅官方 Langflow 文档：

- **发布概念**：<https://docs.langflow.org/concepts-publish>
- **生产最佳实践**：<https://docs.langflow.org/deployment-prod-best-practices>
