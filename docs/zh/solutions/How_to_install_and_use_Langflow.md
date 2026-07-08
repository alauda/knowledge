---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB1762309013-4C37
sourceSHA: 96e076b157058469f60c17c2348601c523428a6d93135ce12e42cede0e9228e0
---

# Langflow

## 概述

Langflow 是一个开源低代码工具，用于可视化构建和部署 AI 代理和工作流。它提供了一个拖放编辑器，可以快速创建、测试和迭代 AI 应用程序。Langflow 基于 Python 构建，包含一个 FastAPI 后端和一个基于 React 的可视化编辑器。它默认支持 SQLite，并建议在生产环境中使用 PostgreSQL。

它包含以下主要组件：

- **前端界面**：基于 React 的可视化编辑器，具有拖放流程构建和实时测试功能
- **后端服务**：基于 FastAPI 的网络服务，提供 REST API 和 MCP（模型上下文协议）支持
- **数据库**：支持 SQLite（默认）和 PostgreSQL（推荐用于生产）

## 核心概念

Langflow 构建于几个核心概念之上：**Flows**（组织 AI 逻辑的可视化工作流）、**Components**（可重用的功能单元）、**Agents**（具有工具调用和推理能力的智能代理）以及 **API/MCP** 集成（支持 REST API 和模型上下文协议）。

Langflow 提供了一个拖放的可视化界面，用于构建具有实时测试功能的 AI 应用程序，并且拥有丰富的模板库。它支持多个 LLM 提供商、嵌入模型和向量数据库，能够实现灵活的多模型配置。该平台提供开发的 IDE 模式和生产部署的运行时模式，适合实验和企业使用。

有关核心概念、功能和使用的详细信息，请参阅 [官方文档](https://docs.langflow.org/)。

## 文档和参考

- **官方文档**：<https://docs.langflow.org/>
- **GitHub 仓库**：<https://github.com/langflow-ai/langflow>

# Langflow 部署指南

本节提供有关如何将 Langflow 部署到 Kubernetes 集群的详细说明以及常见配置参数。

## 发布

下载 Langflow 安装文件：`langflow-operator.alpha.ALL.v1.10.2.tgz`

使用 violet 命令将其发布到平台仓库：

```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password langflow-operator.alpha.ALL.v1.10.2.tgz
```

从 v1.10.1 开始，Langflow 通过 `OperatorHub` 和 `Langflow` 自定义资源进行安装，而不是通过应用程序 / 目录表单。

## 部署

### 准备存储

Langflow 默认使用 SQLite，配备 RWO PVC（1Gi）。对于生产环境，建议使用 PostgreSQL（请参见 [配置数据库](#2-configure-database)）。SQLite PVC 的 StorageClass 在 `spec.langflow.backend.sqlite.volume` 下配置 — 有关详细信息，请参见 [配置存储](#1-configure-storage)。

### 准备数据库（可选）

#### 使用 SQLite（默认）

SQLite 是 Langflow 的默认数据库：

- 数据存储在 RWO PVC（`data-langflow-service-0`，默认 1Gi）
- 简单，无需额外基础设施
- 仅支持单实例后端（StatefulSet 副本 = 1）

#### 使用 PostgreSQL（推荐用于生产）

生产环境强烈建议使用 PostgreSQL：

- 通过 `数据服务` PostgreSQL Operator 提供 PostgreSQL 实例，或使用任何可从集群访问的外部 PostgreSQL。
- 创建一个具有 `CREATE`/`CONNECT` 权限的专用数据库和用户。Langflow 后端将在首次启动时对其运行 Alembic 迁移。

**注意**：

- 建议使用 PostgreSQL 版本 12 或更高版本
- 确保 Langflow 命名空间与 PostgreSQL 实例之间的网络连接
- 将密码存储在 Kubernetes `Secret` 中，并通过 `secretKeyRef` 引用它（请参见 [配置数据库](#2-configure-database)）

### 安装 Operator + 创建 Langflow

1. 在 `Alauda Container Platform` 中，打开 `OperatorHub` 并搜索 `Langflow`。从 `platform` 目录源安装 `Langflow`（默认：通道 `alpha`，安装模式 `AllNamespaces`）。

2. 等待 CSV `langflow-operator.v1.10.2` 达到 `Succeeded` 状态。

3. 为 Langflow 实例创建一个命名空间（默认建议：`langflow-system`）。

4. 在该命名空间中应用一个 `Langflow` 自定义资源。最小形式：

   ```yaml
   apiVersion: langflow-operator.alauda.io/v1
   kind: Langflow
   metadata:
     name: langflow
     namespace: langflow-system
   spec: {}
   ```

   空的 `spec: {}` 使用默认值（集群默认 StorageClass 上的 SQLite，IDE 模式，仅 ClusterIP 服务）。要自定义，请根据以下部分在 `spec.langflow.*` 下添加字段。

## 配置

`Langflow` 自定义资源的 `spec.langflow.*` 字段自定义部署。主要关注的配置如下。

> **⚠ 数组字段替换图表默认值，而不是附加。**
> 当您设置 `spec.langflow.backend.volumes`（或 `.volumeMounts`）时，图表将丢弃其默认的 `tmp` / `data` / `db` / `flows` `emptyDir` 卷，仅使用您提供的内容。如果您添加了自定义卷而不重新声明默认值，则后端容器将在启动时崩溃，出现 `FileNotFoundError: No usable temporary directory found in ['/tmp', '/var/tmp', '/usr/tmp', '/app']`（Langflow 入口点导入 `dill`，它调用 `tempfile.gettempdir()` — `readOnlyRootFilesystem: true` 意味着 `/tmp` 必须是可写卷）。
>
> 如果您自定义 `volumes` 或 `volumeMounts`，请将四个图表默认条目与您的添加内容一起保留。建议的最小样板：
>
> ```yaml
> spec:
>   langflow:
>     backend:
>       volumes:
>         - {name: langflow-tmp, emptyDir: {}}   # /tmp        — 必需（只读根文件系统）
>         - {name: app-data,     emptyDir: {}}   # /app/data   — 图表默认
>         - {name: app-db,       emptyDir: {}}   # /app/db     — 图表默认
>         - {name: app-flows,    emptyDir: {}}   # /app/flows  — 图表默认
>         # ... 您的添加内容在下面
>       volumeMounts:
>         - {name: langflow-tmp, mountPath: /tmp}
>         - {name: app-data,     mountPath: /app/data}
>         - {name: app-db,       mountPath: /app/db}
>         - {name: app-flows,    mountPath: /app/flows}
>         # ... 您的添加内容在下面
> ```
>
> 下面的部分添加自定义 `volumes`（ConfigMap 流导入、本地模型、Python 依赖项）时省略此样板以简化 — 请记得包含它。这个陷阱在 ACP 4.3 的文档验证中被发现。

### 1. 配置存储

#### 1.1 配置 SQLite 存储（默认）

可以通过添加以下配置来指定 StorageClass 和卷大小：

```yaml
spec:
  langflow:
    backend:
      sqlite:
        volume:
          existingStorageClassName: <sc-name>    # 集群 StorageClass 名称；留空 "default" 以使用集群默认值
          size: 1Gi                              # PVC 大小
```

**注意**：

- `existingStorageClassName: "default"` 是图表中的一个魔法字符串，表示“使用集群的默认 StorageClass”（即带有 `storageclass.kubernetes.io/is-default-class: "true"` 注释的 SC）。设置显式 SC 名称以覆盖。
- 使用 SQLite 时，仅支持单实例后端（StatefulSet 副本 = 1）。

### 2. 配置数据库

#### 2.1 启用 PostgreSQL

可以通过设置以下字段来配置 PostgreSQL 访问信息：

```yaml
spec:
  langflow:
    backend:
      externalDatabase:
        enabled: true                            # 启用外部数据库
        driver: {value: "postgresql"}
        host: {value: <postgres-host>}           # PostgreSQL 主机（服务 DNS 或外部地址）
        port: {value: "5432"}
        database: {value: langflow}              # 目标数据库（必须在后端启动之前存在）
        user: {value: langflow}
        password:
          valueFrom:
            secretKeyRef:
              name: postgres-secret              # 存放密码的 Secret
              key: password
```

图表在后端容器内运行一个小的启动 shim，读取这些 `LF_CHART_EXTERNALDB_*` 环境变量，并将它们组合成 `LANGFLOW_DATABASE_URL=postgresql://<user>:<pass>@<host>:<port>/<db>`，覆盖 SQLite 默认值。通过在后端启动后连接到目标 PostgreSQL 进行验证：Langflow 通过 Alembic 创建其完整的模式（`alembic_version`、`flow`、`apikey`、`folder`、`message` 等），并用内置的启动项目填充它。

**注意**：使用 SQLite 时，仅支持单实例后端。多实例后端需要 PostgreSQL，但当前图表仍然为后端 StatefulSet 提供 `replicas: 1` — 如果您需要高可用性，请显式扩展。

### 3. 配置外部访问

Langflow 默认仅创建两个 `ClusterIP` 服务：

- `langflow-service` 在端口 8080 上 — 前端（由 nginx 提供的 React IDE）
- `langflow-service-backend` 在端口 7860 上 — 后端（FastAPI + `/api/v1/*`）

前端 nginx 还将 `/api`、`/health` 和 `/health_check` 反向代理到后端，因此 **将所有外部流量路由到 `langflow-service:8080` 将为用户提供 IDE 和后端 API 的同一入口点**。

外部访问通过 Gateway API（Envoy Gateway）提供。在与您的 `Langflow` 自定义资源相同的命名空间中应用以下三个资源。根据您的环境调整 `gatewayClassName`（`envoy-gateway-system-aieg` 是 Alauda Container Platform 4.3+ 的默认值）和 `hostname`。

```yaml
# ── 1) EnvoyProxy: 通过 NodePort（或 LoadBalancer，如果可用）公开数据平面。 ────
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: langflow-proxy
  namespace: <langflow-ns>
spec:
  logging: {level: {default: warn}}
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: NodePort              # 如果集群有一个，则更改为 LoadBalancer
        externalTrafficPolicy: Cluster
---
# ── 2) Gateway: HTTP 监听器；添加带有证书 Secret 的 HTTPS 监听器以支持 TLS。 ─────────
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: langflow-gw
  namespace: <langflow-ns>
spec:
  gatewayClassName: envoy-gateway-system-aieg
  infrastructure:
    parametersRef:
      group: gateway.envoyproxy.io
      kind: EnvoyProxy
      name: langflow-proxy
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes: {namespaces: {from: Same}}
---
# ── 3) HTTPRoute: 所有路径 → langflow-service:8080；nginx 将 /api* 分发到后端。 ────
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: langflow
  namespace: <langflow-ns>
spec:
  parentRefs:
    - {group: gateway.networking.k8s.io, kind: Gateway, name: langflow-gw}
  # hostnames: [langflow.example.com]           # 可选；省略以接受任何主机
  rules:
    - matches: [{path: {type: PathPrefix, value: "/"}}]
      backendRefs:
        - {name: langflow-service, port: 8080}
```

应用后，等待 `Gateway` 达到 `PROGRAMMED=True`，然后找到 Envoy Gateway 分配的 NodePort：

```bash
kubectl get gateway langflow-gw -n <langflow-ns>
kubectl get svc -A -l gateway.envoyproxy.io/owning-gateway-name=langflow-gw
```

输出中的 NodePort 服务是入口点 — 通过 `http://<any-node-ip>:<nodePort>/` 访问 Langflow。

如果您在不同的命名空间中添加了带有证书的 HTTPS 监听器，您还需要从 Gateway 的命名空间到证书的命名空间的 `ReferenceGrant`。

### 4. 配置身份验证和用户管理（可选）

Langflow 身份验证由后端容器上的环境变量控制。在 `spec.langflow.backend.env` 下设置它们：

```yaml
spec:
  langflow:
    backend:
      env:
        - name: LANGFLOW_AUTO_LOGIN
          value: "false"                       # 禁用自动登录（默认：true）
        - name: LANGFLOW_SUPERUSER
          valueFrom:
            secretKeyRef: {name: langflow-superuser, key: username}
        - name: LANGFLOW_SUPERUSER_PASSWORD
          valueFrom:
            secretKeyRef: {name: langflow-superuser, key: password}
        - name: LANGFLOW_NEW_USER_IS_ACTIVE
          value: "false"                       # 新用户需要超级用户激活（默认：false）
        - name: LANGFLOW_ENABLE_SUPERUSER_CLI
          value: "false"                       # 禁用 CLI 超级用户引导
```

**在浏览器中验证登录流程**：

1. **在新的浏览器标签中打开 Langflow URL** — 使用隐身/私密窗口，或先清除网站的 cookies（开发者工具 → 应用程序 → Cookies → 删除 `access_token_lf`、`refresh_token_lf`、`apikey_tkn_lflw`）。如果不执行此步骤，之前发出的自动登录 cookies 将继续有效，浏览器会直接进入 IDE，就好像身份验证仍然关闭一样。
2. **页面应显示登录表单**，而不是直接加载 IDE。
3. **使用您在 `LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD` 中设置的超级用户凭据登录**。您应该进入 IDE，右上角菜单显示您的用户名；输入错误的密码应使您停留在登录页面并显示错误消息。

注意：

- 当 `LANGFLOW_AUTO_LOGIN=false` 时，不支持自我注册。新用户必须由超级用户从管理页面添加；如果 `LANGFLOW_NEW_USER_IS_ACTIVE=false`，超级用户还必须在用户可以登录之前激活每个新帐户。
- 超级用户凭据仅在 **首次启动时** 被使用。一旦写入数据库，仅更改环境变量不会轮换密码 — 请通过 Langflow 的管理 UI 更新它。轮换需要编辑现有用户或清空数据库并重新启动。
- 访问/刷新令牌的过期时间由 `LANGFLOW_ACCESS_TOKEN_EXPIRE_SECONDS`（默认 30 天）和 `LANGFLOW_REFRESH_TOKEN_EXPIRE_SECONDS`（默认 60 天）控制。对于生产，建议使用更短的值：
  ```yaml
  env:
    - {name: LANGFLOW_ACCESS_TOKEN_EXPIRE_SECONDS,  value: "3600"}     # 1 小时
    - {name: LANGFLOW_REFRESH_TOKEN_EXPIRE_SECONDS, value: "604800"}   # 7 天
  ```

### 5. 配置运行时模式（仅后端）

运行时模式会去掉 React IDE 前端，仅运行后端 REST API。这是生产 API 服务场景的推荐部署形态。

#### 5.1 启用运行时模式

两个字段一起启用完整的运行时模式：

- `spec.langflow.backend.backendOnly: true` — 启动后端时使用 `--backend-only`（后端在当前图表中已经是默认值，但保持这一点是明确的）。
- `spec.langflow.frontend.enabled: false` — 图表完全跳过前端部署（验证：`kubectl get deploy -n <ns>` 返回 0 资源；仅剩下后端 StatefulSet）。

可选地从 PVC 或 ConfigMap 自动导入流程。**记住 [图表默认样板](#configuration)** — 在不同路径（`/app/loaded-flows`）下挂载流程源，以免与图表自己的 `/app/flows` `emptyDir` 冲突：

```yaml
spec:
  langflow:
    backend:
      backendOnly: true
      env:
        - name: LANGFLOW_LOAD_FLOWS_PATH
          value: "/app/loaded-flows"
      volumes:
        - {name: langflow-tmp, emptyDir: {}}
        - {name: app-data,     emptyDir: {}}
        - {name: app-db,       emptyDir: {}}
        - {name: app-flows,    emptyDir: {}}
        - name: loaded-flows
          persistentVolumeClaim: {claimName: langflow-flows-pvc}
      volumeMounts:
        - {name: langflow-tmp, mountPath: /tmp}
        - {name: app-data,     mountPath: /app/data}
        - {name: app-db,       mountPath: /app/db}
        - {name: app-flows,    mountPath: /app/flows}
        - name: loaded-flows
          mountPath: /app/loaded-flows
    frontend:
      enabled: false
```

启用 `LANGFLOW_LOAD_FLOWS_PATH` 时，请保持 `LANGFLOW_AUTO_LOGIN=true`（自动登录模式） — 这是 Langflow 的约束：用户拥有的自动导入流程需要存在自动登录的默认用户。

## 访问地址

### 1. 通过 Gateway API 访问（推荐）

当应用 [配置外部访问](#3-configure-external-access) 中的 Gateway API 路径时，Gateway 数据平面服务的分配 NodePort 或 LoadBalancer 地址是入口点。示例：

```bash
# 发现 envoy 数据平面服务的 NodePort（或 LoadBalancer 地址）
kubectl get svc -A -l gateway.envoyproxy.io/owning-gateway-name=langflow-gw

# 通过任何集群节点的 IP + 该 NodePort 访问 Langflow
curl http://<any-node-ip>:<nodePort>/health_check
# 或在浏览器中打开 http://<any-node-ip>:<nodePort>/ 以查看 Langflow IDE
```

### 2. 通过集群内端口转发访问（仅限开发）

```bash
kubectl port-forward -n <langflow-ns> svc/langflow-service 8080:8080
# 打开 http://localhost:8080/
```

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

### 1.2 将 ConfigMap 挂载到后端容器

将 ConfigMap 作为卷添加，并通过 `LANGFLOW_LOAD_FLOWS_PATH` 暴露挂载路径。**记住“数组替换默认值”规则** — 自定义 ConfigMap 条目下的四个图表默认条目（`langflow-tmp` / `app-data` / `app-db` / `app-flows`）必须保留：

```yaml
spec:
  langflow:
    backend:
      volumes:
        # 图表默认 — 必需，请勿省略
        - {name: langflow-tmp, emptyDir: {}}
        - {name: app-data,     emptyDir: {}}
        - {name: app-db,       emptyDir: {}}
        - {name: app-flows,    emptyDir: {}}
        # 额外的流程源
        - name: loaded-flows
          configMap: {name: langflow-flows}
      volumeMounts:
        - {name: langflow-tmp, mountPath: /tmp}
        - {name: app-data,     mountPath: /app/data}
        - {name: app-db,       mountPath: /app/db}
        - {name: app-flows,    mountPath: /app/flows}
        - name: loaded-flows
          mountPath: /app/loaded-flows
      env:
        - name: LANGFLOW_LOAD_FLOWS_PATH
          value: /app/loaded-flows
```

在 ACP 4.3 上验证：使用上述 CR 重新启动后端导致 Langflow 自动导入 ConfigMap 中的 `hello-world.json` 文件；`GET /api/v1/flows/` 返回 34 个流程（33 个内置启动项目 + 1 个导入的）。

### 1.3 自动导入

后端重新启动后，Langflow 会扫描 `LANGFLOW_LOAD_FLOWS_PATH` 并自动导入其中的每个 `*.json` 文件作为流程。由于流程所有权与用户相关，自动导入模式需要 `LANGFLOW_AUTO_LOGIN=true`（默认） — 导入的流程附加到内置的默认用户。启用身份验证时（`LANGFLOW_AUTO_LOGIN=false`），不支持用户拥有的导入；请改用 REST API（`POST /api/v1/flows/`，带 Bearer 令牌）。

## 2. 使用模型

在生产环境中，可以通过两种方式加载和使用模型：通过 API 调用远程模型或通过卷挂载加载本地模型。根据您的具体需求选择合适的方法。

### 2.1 调用远程模型

这种方法适用于以下场景：

- 模型具有显著的资源需求
- 模型需要在多个服务之间共享
- 需要独立的扩展和资源管理
- 模型版本管理和更新需要单独处理

远程模型可以是自部署的模型服务或供应商提供的第三方模型服务。要在 Langflow 中使用远程模型，请在流程编辑器中使用基于 API 的模型组件（例如 OpenAI、自定义 API 等）通过配置 API 基础 URL 和身份验证凭据连接到模型服务端点。

### 2.2 加载本地模型

这种方法适用于以下场景：

- 模型的资源开销较低（例如，嵌入模型）
- 模型大小和资源消耗在 Langflow 容器内可控
- 需要直接访问模型文件

#### 2.2.1 通过卷挂载模型文件

将模型文件存储在持久卷中，并通过额外的卷/卷挂载提供给 Langflow 后端容器。**记住 [图表默认样板](#configuration)** — 必须包括四个 `emptyDir` 条目：

```yaml
spec:
  langflow:
    backend:
      volumes:
        - {name: langflow-tmp, emptyDir: {}}
        - {name: app-data,     emptyDir: {}}
        - {name: app-db,       emptyDir: {}}
        - {name: app-flows,    emptyDir: {}}
        - name: models
          persistentVolumeClaim: {claimName: langflow-models-pvc}
      volumeMounts:
        - {name: langflow-tmp, mountPath: /tmp}
        - {name: app-data,     mountPath: /app/data}
        - {name: app-db,       mountPath: /app/db}
        - {name: app-flows,    mountPath: /app/flows}
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

## 3. 添加额外的 Python 依赖项

在生产环境中，当使用自定义组件时，可能需要安装额外的 Python 包。可以按如下方式进行：

### 3.1 通过 PVC 挂载依赖项

使用 PVC 挂载一个目录以存储额外的 Python 包。**记住 [图表默认样板](#configuration)**：

```yaml
spec:
  langflow:
    backend:
      volumes:
        - {name: langflow-tmp, emptyDir: {}}
        - {name: app-data,     emptyDir: {}}
        - {name: app-db,       emptyDir: {}}
        - {name: app-flows,    emptyDir: {}}
        - name: python-packages
          persistentVolumeClaim: {claimName: langflow-packages-pvc}
      volumeMounts:
        - {name: langflow-tmp, mountPath: /tmp}
        - {name: app-data,     mountPath: /app/data}
        - {name: app-db,       mountPath: /app/db}
        - {name: app-flows,    mountPath: /app/flows}
        - name: python-packages
          mountPath: /opt/python-packages
      env:
        - name: PYTHONPATH
          value: "/opt/python-packages"
```

在 ACP 4.3 上验证：pod 状态为 Ready，`env` 显示 `PYTHONPATH=/opt/python-packages`，挂载在该路径可见。

### 3.2 安装依赖项

在安装依赖包时，使用 `pip --target` 参数将包安装到 PVC 挂载的目录中：

```bash
# 在容器内执行，将包安装到 PVC 挂载的目录
pip install --target /opt/python-packages package-name

# 或从 requirements.txt 安装
pip install --target /opt/python-packages -r requirements.txt
```

## 4. 通过环境变量传递全局变量

流程组件配置通常需要在不同环境中使用不同的值。Langflow 的全局变量功能允许将这些特定于环境的值与流程定义分开。全局变量的值可以从环境变量加载。

### 4.1 配置环境变量

在 `spec.langflow.backend.env` 下添加环境变量，如下所示：

```yaml
spec:
  langflow:
    backend:
      env:
        - name: LANGFLOW_VARIABLES_TO_GET_FROM_ENVIRONMENT
          value: VAR1,VAR2,VAR3                # Langflow 将作为全局变量呈现的环境变量名称的逗号分隔列表
        - name: VAR1
          value: xxx                           # 普通字面量
        - name: VAR2
          valueFrom:
            configMapKeyRef:
              name: langflow-configs
              key: var2                        # 来自 ConfigMap
        - name: VAR3
          valueFrom:
            secretKeyRef:
              name: langflow-secrets
              key: var3                        # 来自 Secret（推荐用于敏感值）
```

验证：在 `Langflow` 自定义资源上设置 `LANGFLOW_VARIABLES_TO_GET_FROM_ENVIRONMENT=MY_PLAIN_VAR,MY_SECRET_KEY` 后，`GET /api/v1/variables/` 返回两个条目，类型为 `Credential`，准备从流程组件中引用。

### 4.2 在流程中使用全局变量

在 Langflow 的流程编辑器中：

1. 转到 **设置** 页面
2. 在 **全局变量** 部分，添加全局变量并设置其值
3. 在组件配置中引用这些全局变量
4. 导出流程时，**必须**选择“与我的 API 密钥一起保存”，否则全局变量配置可能不会包含在导出的 JSON 文件中

## 5. 优化建议

为了提高生产环境中的性能、安全性和稳定性，建议进行以下优化配置：

### 5.1 禁用使用跟踪

Langflow 默认会收集使用数据。在生产环境中，可以禁用此功能以保护隐私并减少网络请求：

```yaml
spec:
  langflow:
    backend:
      env:
        - name: DO_NOT_TRACK
          value: "true"
```

### 5.2 禁用事务日志

Langflow 将每个组件的输入、输出和执行日志记录到数据库中（在 IDE 的日志面板中可见）。禁用此功能可以减少数据库写入压力：

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
      numWorkers: 1                            # gunicorn 工作进程数量（默认：1）
```

### 5.4 配置资源限制

建议为后端和前端容器分别配置适当的资源限制。示例值（根据您的工作负载进行调整）：

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

Langflow 支持基于 `x-api-key` 的身份验证进行 REST 请求。创建密钥的两种方法：

1. **通过 IDE（设置 → Langflow API 密钥）**：点击“添加新密钥”，并给密钥命名；Langflow 仅返回一次密钥值（请立即存储）。
2. **通过 REST**：`POST /api/v1/api_key/`，在 `Authorization` 中使用 Bearer 令牌：
   ```bash
   curl -X POST http://<langflow>/api/v1/api_key/ \
     -H "Authorization: Bearer <access-token>" \
     -H "Content-Type: application/json" \
     -d '{"name":"my-key"}'
   ```
   响应体包含 `api_key` — 请记录下来。

在后续请求中使用密钥，发送 `x-api-key: <API Key>`：

- 有效密钥 → `200`
- 缺失/错误密钥 → `403`

在 4.3-x86 的 e2e smoke H probe 中验证：创建密钥 + 使用有效密钥访问 `/api/v1/all` 返回 200 和完整的组件目录；使用错误密钥访问同一端点返回 403。

### 5.6 禁用 UI

请参见 [配置运行时模式](#6-configure-runtime-mode-backend-only) — 设置 `backend.backendOnly=true` 和 `frontend.enabled=false` 以实际去掉前端部署。

### 5.7 参考官方文档

有关发布流程和生产最佳实践的更多详细信息，请参阅官方 Langflow 文档：

- **发布概念**： <https://docs.langflow.org/concepts-publish>
- **生产最佳实践**： <https://docs.langflow.org/deployment-prod-best-practices>
