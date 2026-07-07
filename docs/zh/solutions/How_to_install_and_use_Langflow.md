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

下载 Langflow 安装文件：`langflow-operator.alpha.ALL.v1.10.1.tgz`

使用 violet 命令发布到平台仓库：

```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password langflow-operator.alpha.ALL.v1.10.1.tgz
```

自 v1.10.1 起，Langflow 以 OLM `OperatorBundle` 形式打包（chart-wrap 封装上游 `langflow-ai/langflow-helm-charts/langflow-ide` chart），不再是原始 Helm chart。安装走 OperatorHub + `Langflow` 自定义资源，而不是 Applications / Catalog 表单。

## 前置条件

安装 Langflow 前，目标业务集群必须满足：

- **存在默认 StorageClass** —— Langflow backend 默认走 SQLite，使用 RWO PVC 拉取集群的默认 StorageClass。若无默认 SC，`data-langflow-service-0` PVC 会永远 `Pending`、backend pod 无法调度。设置默认 SC：

  ```bash
  kubectl get sc
  kubectl patch sc <name> -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
  ```

  若希望显式指定 SC 而非依赖集群默认，可在 `Langflow` 自定义资源上设 `spec.langflow.backend.sqlite.volume.existingStorageClassName`（见 [配置存储](#1-配置存储)）。

- **（可选，用于 Gateway API 外部访问）** 集群已安装 Envoy Gateway，且存在一个 `controllerName` 中包含 `envoy` 的 `GatewayClass`。若无，用户只能通过 `kubectl port-forward` 或手动创建 NodePort/LoadBalancer Service 访问。

## 部署

### 准备存储

Langflow 默认使用 SQLite + RWO PVC (1Gi)。生产建议 PostgreSQL（见 [配置数据库](#2-配置数据库)）。集群必须有默认 StorageClass，或用户显式设置 `existingStorageClassName`。

### 准备数据库（可选）

#### 使用 SQLite（默认）

SQLite 是 Langflow 的默认数据库：

- 数据存储在 RWO PVC（`data-langflow-service-0`，默认 1Gi）
- 无需额外基础设施
- 仅支持单实例 backend（StatefulSet 副本数 = 1）

#### 使用 PostgreSQL（生产推荐）

生产环境强烈建议 PostgreSQL：

- 可通过 `Data Services` 的 PostgreSQL Operator 部署，或使用集群可达的任意外部 PostgreSQL。
- 需要预先创建独立的数据库和具备 `CREATE`/`CONNECT` 权限的用户。Langflow backend 首次启动时会通过 Alembic 建表。

**注意**：

- 推荐 PostgreSQL 12 及以上
- 确保 Langflow 命名空间到 PostgreSQL 实例的网络连通
- 密码存 Kubernetes `Secret`，通过 `secretKeyRef` 引用（见 [配置数据库](#2-配置数据库)）

### 安装 Operator 并创建 Langflow

1. 在 `Alauda Container Platform` 中打开 `OperatorHub`，搜索 `Langflow`。从 `platform` 目录源安装 `Langflow`（默认：channel `alpha`，安装模式 `AllNamespaces`）。

2. 等待 CSV `langflow-operator.v1.10.1` 达到 `Succeeded`。

3. 为 Langflow 实例创建一个命名空间（建议默认：`langflow-system`）。

4. 在该命名空间下 apply 一个 `Langflow` 自定义资源。最简形式：

   ```yaml
   apiVersion: langflow-operator.alauda.io/v1
   kind: Langflow
   metadata:
     name: langflow
     namespace: langflow-system
   spec: {}
   ```

   空 `spec: {}` 走 chart 默认（SQLite on 集群默认 SC、IDE 模式、ClusterIP Services、Ingress 关）。如需自定义，按下文各段落把字段加到 `spec.langflow.*` —— wrap CR spec 与上游 chart `values.yaml` 结构镜像对应。完整字段清单见上游 [`values.yaml`](https://github.com/langflow-ai/langflow-helm-charts/blob/langflow-ide-0.1.2/charts/langflow-ide/values.yaml)。

## 配置

用户通过编辑 `Langflow` 自定义资源的 `spec.langflow.*` 字段调整配置。Wrap CR spec 与上游 `langflow-ide` chart 的 `values.yaml` 结构镜像对应。主要关注的配置如下。

### 1. 配置存储

#### 1.1 配置 SQLite 存储（默认）

通过如下配置指定 StorageClass 和卷大小：

```yaml
spec:
  langflow:
    backend:
      sqlite:
        volume:
          existingStorageClassName: <sc-name>    # 集群 SC 名称；保留 "default" 表示使用集群默认 SC
          size: 1Gi                              # PVC 大小
```

**注意**：

- `existingStorageClassName: "default"` 是 chart 里的**特殊字符串**，表示"使用集群默认 SC"（即标了 `storageclass.kubernetes.io/is-default-class: "true"` 的那个 SC）。填写显式 SC 名称即可覆盖。
- 使用 SQLite 时仅支持单实例 backend（StatefulSet 副本数 = 1）。

### 2. 配置数据库

#### 2.1 启用 PostgreSQL

通过设置以下字段配置 PostgreSQL 访问信息：

```yaml
spec:
  langflow:
    backend:
      externalDatabase:
        enabled: true                            # 启用外部数据库
        driver: {value: "postgresql"}
        host: {value: <postgres-host>}           # PostgreSQL 主机（Service DNS 或外部地址）
        port: {value: "5432"}
        database: {value: langflow}              # 目标数据库（backend 启动前必须存在）
        user: {value: langflow}
        password:
          valueFrom:
            secretKeyRef:
              name: postgres-secret              # 存密码的 Secret
              key: password
```

Chart 在 backend 容器启动时执行一个 shim，读取上述 `LF_CHART_EXTERNALDB_*` 环境变量并拼成 `LANGFLOW_DATABASE_URL=postgresql://<user>:<pass>@<host>:<port>/<db>`，覆盖默认的 sqlite URL。实测已验证：backend 启动后连接 PostgreSQL，通过 Alembic 建立完整 schema（`alembic_version`、`flow`、`apikey`、`folder`、`message` 等），并把内置 starter projects 写入。

**注意**：SQLite 场景仅支持单实例 backend。要多实例必须 PostgreSQL，但当前 chart 仍默认 backend StatefulSet 副本数 = 1 —— 如需 HA 请显式扩容。

### 3. 配置外部访问

上游 chart 默认只创建两个 `ClusterIP` Service：

- `langflow-service` 端口 8080 —— frontend（React IDE，由 nginx serve）
- `langflow-service-backend` 端口 7860 —— backend（FastAPI + `/api/v1/*`）

Frontend nginx 内部把 `/api`、`/health` 与 `/health_check` 反代到 backend，因此**只把外部流量路由到 `langflow-service:8080` 就同时覆盖 SPA 和后端 API**，无需按路径拆多条规则。

**推荐路径：Gateway API（Envoy Gateway）**

chart-wrap 在 oss-operator-factory 仓库的 `components/langflow/examples/gateway-httproute.example.yaml` 提供示例。集群运维在每个集群上一次性挂 `EnvoyProxy` + `Gateway`；用户在 Langflow 命名空间里挂一条 `HTTPRoute` 指向 `langflow-service:8080`。单条 rule + 单个 backend 即可，无需按 path 拆规则。

最简 HTTPRoute 示例（假设 Gateway `langflow-gw` 已存在）：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: langflow
  namespace: <langflow-ns>
spec:
  parentRefs:
    - {group: gateway.networking.k8s.io, kind: Gateway, name: langflow-gw, namespace: <gw-ns>}
  hostnames: [<host>]
  rules:
    - matches: [{path: {type: PathPrefix, value: "/"}}]
      backendRefs:
        - {name: langflow-service, port: 8080}
```

**备选：上游 chart 自带 Ingress**

Chart 也提供 Ingress 字段（默认关）。通过 wrap CR 打开：

```yaml
spec:
  langflow:
    ingress:
      enabled: true
      hosts:
        - host: langflow.example.com
          paths: [{path: /, pathType: Prefix}]
      tls:
        - {secretName: langflow-tls, hosts: [langflow.example.com]}
```

注意：

- chart 默认 `ingress.enabled: false`，wrap 保持不动 —— 预开在无对应 ingress class / 域名的集群上会失败。
- **OAuth2 Proxy 不在上游 chart 里**。如需 SSO，需要另外部署一个 OAuth2 Proxy（或平台已有的 SSO 网关）作为 Langflow Service 前置，wrap 不管这个生命周期。跟平台上其他 chart-wrap 组件同套路。

### 4. 配置身份验证和用户管理（可选）

上游社区 chart **不提供** `auth` 结构化字段。Langflow 的鉴权通过 backend 容器的环境变量控制。在 `spec.langflow.backend.env` 下设置：

```yaml
spec:
  langflow:
    backend:
      env:
        - name: LANGFLOW_AUTO_LOGIN
          value: "false"                       # 关闭自动登录（默认：true）
        - name: LANGFLOW_SUPERUSER
          valueFrom:
            secretKeyRef: {name: langflow-superuser, key: username}
        - name: LANGFLOW_SUPERUSER_PASSWORD
          valueFrom:
            secretKeyRef: {name: langflow-superuser, key: password}
        - name: LANGFLOW_NEW_USER_IS_ACTIVE
          value: "false"                       # 新用户需超级用户激活（默认：false）
        - name: LANGFLOW_ENABLE_SUPERUSER_CLI
          value: "false"                       # 关闭 CLI 超级用户引导
```

`LANGFLOW_AUTO_LOGIN=false` 已实测行为：

- `GET /api/v1/auto_login` 返回 **403**（自动登录已关）。
- `POST /api/v1/login` 用正确超级用户凭据返回 **200**，带 `access_token`。
- `POST /api/v1/login` 用错误密码返回 **401**。
- 受保护接口（如 `GET /api/v1/all`）用有效 Bearer token 返回 **200**，无 token 返回 **403**。

注意：

- `LANGFLOW_AUTO_LOGIN=false` 下不支持自注册。新用户必须由超级用户在 `/admin` 添加；如 `LANGFLOW_NEW_USER_IS_ACTIVE=false`，超级用户还需手动激活账户方可登录。
- 超级用户凭据**只在首次启动**时消费。一旦写入数据库（SQLite 或 PostgreSQL），只改环境变量**不会**轮换凭据 —— 后续修改必须走 Langflow 管理界面或数据库迁移。
- 访问/刷新 token 过期时间由 `LANGFLOW_ACCESS_TOKEN_EXPIRE_SECONDS` / `LANGFLOW_REFRESH_TOKEN_EXPIRE_SECONDS` 控制（默认较保守，非必要不要动）。

### 5. 单点登录（SSO）

上游 `langflow-ide` chart **不包含 OAuth2 Proxy 边车或独立 Deployment**。如需 SSO，需要在 Langflow frontend Service 前面另外部署 OAuth2 Proxy（或平台已有的 SSO 网关）作为独立工作负载 —— wrap CR 不管这一段的生命周期，跟平台上其他 chart-wrap 组件同套路。将 OAuth2 Proxy 上游指向 `langflow-service:8080`，同时把 backend 的 `LANGFLOW_AUTO_LOGIN=false`，让 proxy 成为唯一的鉴权入口。

### 6. 配置运行时模式（仅后端）

运行时模式去掉 React IDE 前端，只跑 backend REST API，适合生产 API 服务场景。

#### 6.1 启用运行时模式

需要同时设置两个字段才是完整的 runtime mode：

- `spec.langflow.backend.backendOnly: true` —— backend 启动带 `--backend-only`（当前 chart 里默认已 true，保留显式声明）。
- `spec.langflow.frontend.enabled: false` —— chart 会**跳过 frontend Deployment**（实测：`kubectl get deploy -n <ns>` 返回 0 条，只剩 backend StatefulSet）。

可选：自动从 PVC 或 ConfigMap 导入 flow：

```yaml
spec:
  langflow:
    backend:
      backendOnly: true
      env:
        - name: LANGFLOW_LOAD_FLOWS_PATH
          value: "/app/flows"
      volumes:
        - name: flows
          persistentVolumeClaim: {claimName: langflow-flows-pvc}
      volumeMounts:
        - name: flows
          mountPath: /app/flows
    frontend:
      enabled: false
```

启用 `LANGFLOW_LOAD_FLOWS_PATH` 时，需要保留 `LANGFLOW_AUTO_LOGIN=true`（自动登录模式）—— 这是 Langflow 的约束：用户所有的自动导入 flow 需要 auto-login 默认用户存在。

## 访问地址

### 1. 通过 Gateway API 访问（推荐）

按 [配置外部访问](#3-配置外部访问) 挂上 Gateway API 后，Gateway 数据面 Service 的 NodePort 或 LoadBalancer 地址就是入口。例如：

```bash
# 查 envoy 数据面 Service 分配到的 NodePort（或 LoadBalancer 地址）
kubectl get svc -A -l gateway.envoyproxy.io/owning-gateway-name=langflow-gw

# 用任意集群节点 IP + 该 NodePort 访问 Langflow
curl http://<any-node-ip>:<nodePort>/health_check
# 或浏览器打开 http://<any-node-ip>:<nodePort>/ 就是 Langflow IDE
```

### 2. 通过集群内 port-forward 访问（仅开发）

```bash
kubectl port-forward -n <langflow-ns> svc/langflow-service 8080:8080
# 浏览器打开 http://localhost:8080/
```

### 3. 通过 Ingress 访问

若通过 `spec.langflow.ingress.enabled=true` 打开了 Ingress，请通过配置的域名访问（DNS 解析 + TLS 证书需集群运维准备）。

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

### 1.2 将 ConfigMap 挂载到 backend 容器

把 ConfigMap 作为 volume 加进来，并通过 `LANGFLOW_LOAD_FLOWS_PATH` 暴露挂载路径。上游 chart 会把用户提供的 volumes/volumeMounts 追加到自带的 default 之后：

```yaml
spec:
  langflow:
    backend:
      volumes:
        - name: flows
          configMap: {name: langflow-flows}
      volumeMounts:
        - name: flows
          mountPath: /app/flows
      env:
        - name: LANGFLOW_LOAD_FLOWS_PATH
          value: /app/flows
```

### 1.3 自动导入

backend 重启后，Langflow 扫描 `LANGFLOW_LOAD_FLOWS_PATH` 并自动把里面每个 `*.json` 导入为 Flow。由于 flow 归属绑定用户，自动导入模式需要 `LANGFLOW_AUTO_LOGIN=true`（默认）—— 导入的 flow 会归到内置的默认用户。开鉴权后（`LANGFLOW_AUTO_LOGIN=false`），上游 chart 不支持用户归属的自动导入，请改用 REST API（`POST /api/v1/flows/` + Bearer token）。

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

将模型文件存到持久卷，通过附加 volume/volumeMount 挂给 Langflow backend 容器：

```yaml
spec:
  langflow:
    backend:
      volumes:
        - name: models
          persistentVolumeClaim: {claimName: langflow-models-pvc}
      volumeMounts:
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

用 PVC 挂载一个目录存放额外的 Python 包：

```yaml
spec:
  langflow:
    backend:
      volumes:
        - name: python-packages
          persistentVolumeClaim: {claimName: langflow-packages-pvc}
      volumeMounts:
        - name: python-packages
          mountPath: /opt/python-packages
      env:
        - name: PYTHONPATH
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

在 `spec.langflow.backend.env` 下添加环境变量：

```yaml
spec:
  langflow:
    backend:
      env:
        - name: LANGFLOW_VARIABLES_TO_GET_FROM_ENVIRONMENT
          value: VAR1,VAR2,VAR3                # 逗号分隔，列出会被 Langflow 变成全局变量的 env 名字
        - name: VAR1
          value: xxx                           # 明文值
        - name: VAR2
          valueFrom:
            configMapKeyRef:
              name: langflow-configs
              key: var2                        # 从 ConfigMap
        - name: VAR3
          valueFrom:
            secretKeyRef:
              name: langflow-secrets
              key: var3                        # 从 Secret（敏感值推荐用这个）
```

实测已验证：wrap CR 上 `LANGFLOW_VARIABLES_TO_GET_FROM_ENVIRONMENT=MY_PLAIN_VAR,MY_SECRET_KEY` + 对应的 env 定义，backend 启动后 `GET /api/v1/variables/` 返回两条 `type: Credential` 的条目，可直接被 flow 组件引用。

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
spec:
  langflow:
    backend:
      env:
        - name: DO_NOT_TRACK
          value: "true"
```

### 5.2 禁用事务日志

Langflow 每次处理请求都会把每个组件的输入、输出、执行日志写到数据库（IDE Logs 面板可看）。关掉能减少数据库写压力：

```yaml
spec:
  langflow:
    backend:
      env:
        - name: LANGFLOW_TRANSACTIONS_STORAGE_ENABLED
          value: "false"
```

### 5.3 设置工作进程数量

```yaml
spec:
  langflow:
    backend:
      numWorkers: 1                            # gunicorn worker 数（默认：1）
```

### 5.4 配置资源限制

建议分别为 backend 和 frontend 容器配置资源限制。以下示例仅供参考，按实际负载调整：

```yaml
spec:
  langflow:
    backend:
      resources:
        requests: {cpu: "2", memory: "4Gi"}
        limits:   {cpu: "4", memory: "8Gi"}
    frontend:
      resources:
        requests: {cpu: "0.3", memory: "512Mi"}
```

### 5.5 使用 API 密钥

Langflow 支持 REST 请求走 `x-api-key` 鉴权。两种方式建 key：

1. **在 IDE 内**（Settings → Langflow API Keys）：点击 "Add New" 给 key 起个名字，Langflow 只显示一次密钥值，请立即记录。
2. **走 REST**：`POST /api/v1/api_key/` 带 Bearer token：
   ```bash
   curl -X POST http://<langflow>/api/v1/api_key/ \
     -H "Authorization: Bearer <access-token>" \
     -H "Content-Type: application/json" \
     -d '{"name":"my-key"}'
   ```
   响应体里的 `api_key` 就是要记录的 key。

后续请求带 `x-api-key: <API Key>` header：

- 有效 key → `200`
- 缺 / 错 → `403`

e2e smoke H 探针在 4.3-x86 上已实测：建 key + 用有效 key 打 `/api/v1/all` 返回 200（含完整组件目录）；用错误 key 打同接口返回 403。

### 5.6 禁用 UI

参考 [配置运行时模式](#6-配置运行时模式仅后端) —— 同时设置 `backend.backendOnly=true` 和 `frontend.enabled=false` 才能真正跳过 frontend Deployment。

### 5.7 参考官方文档

有关发布流程和生产最佳实践的更详细信息，请参阅官方 Langflow 文档：

- **发布概念**：<https://docs.langflow.org/concepts-publish>
- **生产最佳实践**：<https://docs.langflow.org/deployment-prod-best-practices>
