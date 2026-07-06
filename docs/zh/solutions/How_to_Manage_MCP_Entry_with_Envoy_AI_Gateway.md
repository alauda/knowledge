---
products:
  - Alauda Container Platform
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
tags:
  - AI
  - Gateway
  - MCP
id: KB260700009
sourceSHA: 06d548b8c16449e755c13fbf6d9d6de9b911eba6b5fe041aaab4cf55c5f049ce
---

# 如何使用 Envoy AI 网关管理统一的 MCP 入口

## 概述

本文档描述了如何基于 Envoy AI 网关 `MCPRoute` 配置统一的 MCP 入口。

目标场景是平台通过 MCP 生命周期操作员在多个工作负载命名空间中部署 `MCPServer` 实例，并提供一个共享的网关入口。用户的智能体只需配置一个 MCP 地址即可访问所有 MCP 服务器。网关聚合工具列表，通过工具名称路由请求，并提供集中式身份验证和授权。

## 设计原则

- 平台提供一个共享的网关入口，避免为每个工作负载命名空间单独设置入口网关。
- 身份验证和授权在共享网关入口层处理，以实现集中治理。
- MCP 服务生命周期管理由 MCP 生命周期操作员处理。
- `MCPRoute` 聚合多个 MCP 后端，并为客户端提供一个统一的访问地址。

## 整体拓扑

```text
opencode
  -> Envoy 网关共享网关
  -> 入口身份验证（API 密钥或 OIDC）
  -> MCPRoute 聚合来自多个命名空间的 MCP 后端
  -> MCPServer 由 MCP 生命周期操作员管理
```

## MCPServer 集成模型

MCP 生命周期操作员管理 `MCPServer` 资源。在用户声明 MCP 服务器镜像、端口、路径、环境变量、挂载、资源、探针和安全上下文后，操作员创建一个同名的 `Deployment` 和 `Service`。

集群内后端模型为：

```text
MCPServer（工作负载命名空间）
  -> MCP 生命周期操作员创建一个同名的 Service
  -> 平台控制平面在共享网关命名空间中创建一个后端
  -> 统一的 MCPRoute 通过 backendRefs[] 引用后端
```

在此模型中，工作负载命名空间无需创建网关或 `MCPRoute`。每个 `MCPServer` 映射到一个 Envoy 网关 `Backend`。平台控制平面将这些 `Backend` 资源添加到统一的 `MCPRoute.backendRefs`，保持外部入口、身份验证和治理模型的一致性。

设计说明：

- 平台使用一个共享的 MCP 入口，以避免为每个命名空间部署单独网关所带来的资源开销和入口治理复杂性。
- 外部 MCP 路径固定为 `/mcp`。对于多团队或多工作负载分离，使用不同的主机名或匹配由受信任的入口层注入的 `headers`。
- 每个 MCP 后端应使用稳定且简短的 `backendRefs[].name`，因为它出现在客户端看到的工具名称前缀中，例如 `k8s-mcp-server__get_cluster`。
- 集群内的 MCP 服务器由 MCP 生命周期操作员 `MCPServer` 资源管理。平台控制平面为每个 `MCPServer` 创建一个 Envoy 网关 `Backend` 并将其添加到统一的 `MCPRoute.backendRefs`。
- 外部 HTTPS MCP 服务器使用 Envoy 网关 `Backend` 以及 `BackendTLSPolicy`。
- 身份验证在共享网关入口层处理。API 密钥身份验证使用 Envoy 网关 `SecurityPolicy.apiKeyAuth`；OIDC 使用 `MCPRoute.securityPolicy.oauth`。

## 先决条件

1. Envoy 网关已在集群中部署，并且存在可用的 `GatewayClass`。
2. Envoy AI 网关已在集群中部署。
3. MCP 生命周期操作员已在集群中部署。
4. 连接到 `MCPRoute` 的 MCP 后端提供可流式传输的 HTTP 端点。

## 配置统一的 MCP 入口

以下示例在 `/mcp` 配置一个共享入口。`Gateway`、`EnvoyProxy`、`MCPRoute` 和 `Backend` 位于共享命名空间 `mcp-gateway-system`。工作负载命名空间仅声明 `MCPServer`；平台控制平面将每个 `MCPServer` 映射到共享命名空间中的 `Backend`，该 `Backend` 可以被 `MCPRoute` 引用。

此示例中的 Envoy 数据平面服务使用 `LoadBalancer` 并设置 `externalTrafficPolicy: Cluster`。Kubernetes `LoadBalancer` 服务默认分配 NodePorts，因此当没有云负载均衡器地址可用时，入口也可以通过节点 IP 和 NodePort 进行测试。网关监听器未设置 `hostname`，这意味着监听器不限制主机匹配。外部域仍由 DNS、Ingress/LB 或上层入口提供。

所有由统一 `MCPRoute` 引用的 `Backend` 资源都放置在共享命名空间中。对于集群内的 MCP 服务器，工作负载命名空间中的 `MCPServer` 首先生成一个 `Service`，然后平台控制平面在共享命名空间中创建相应的 `Backend`。外部 MCP 服务器没有工作负载命名空间；直接在共享命名空间中创建其 `Backend` 和 `BackendTLSPolicy`。

```yaml
# 提供统一 MCP 入口的网关。
# 未配置主机名，因此监听器不限制主机。
# 实际域由 DNS/LB/上层入口提供。
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: ai-mcp-gateway
  namespace: mcp-gateway-system
spec:
  # 将此替换为目标集群中可用的 GatewayClass。
  gatewayClassName: envoy-gateway
  listeners:
    - name: http
      protocol: HTTP
      port: 80
  infrastructure:
    parametersRef:
      group: gateway.envoyproxy.io
      kind: EnvoyProxy
      name: ai-mcp-gateway
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: ai-mcp-gateway
  namespace: mcp-gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        # LoadBalancer 默认分配 NodePorts；externalTrafficPolicy 为 Cluster。
        type: LoadBalancer
        externalTrafficPolicy: Cluster
---
# MCPRoute 将多个 MCP 后端聚合到同一个 /mcp 入口。
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: MCPRoute
metadata:
  name: unified-mcp
  namespace: mcp-gateway-system
spec:
  parentRefs:
    # MCPRoute 必须附加到同一命名空间中的网关。
    - name: ai-mcp-gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  # 通过 opencode 访问的统一 MCP 路径。
  path: /mcp
  backendRefs:
    # 对应于集群内 MCPServer 的后端。
    - name: k8s-mcp-server
      kind: Backend
      group: gateway.envoyproxy.io
      path: /mcp
```

工作负载命名空间中的 `k8s-mcp-server` 后端由 MCP 生命周期操作员管理。以下 `MCPServer` 生成一个同名的 `Deployment` 和 `Service`。此示例不需要网关将后端 HTTP 凭证注入到 `k8s-mcp-server`。

```yaml
apiVersion: mcp.x-k8s.io/v1alpha1
kind: MCPServer
metadata:
  name: k8s-mcp-server
  # 工作负载命名空间：仅在此放置 MCPServer，不放置 Gateway/MCPRoute。
  namespace: team-a
spec:
  source:
    type: ContainerImage
    containerImage:
      # Kubernetes MCP 服务器的上游示例镜像。
      ref: quay.io/containers/kubernetes_mcp_server:latest
  config:
    # MCPServer 提供可流式传输 HTTP 的端口和路径。
    port: 8080
    path: /mcp
    env:
      - name: LOG_LEVEL
        value: info
  runtime:
    replicas: 1
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
```

确认操作员生成的地址：

```bash
kubectl get mcpserver k8s-mcp-server -n team-a
kubectl get service k8s-mcp-server -n team-a
```

平台控制平面在共享命名空间中为此 `MCPServer` 创建相应的 `Backend`，以便统一的 `MCPRoute` 可以引用它：

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: k8s-mcp-server
  # 后端放置在共享网关命名空间中，以供 MCPRoute 引用。
  namespace: mcp-gateway-system
spec:
  endpoints:
    - fqdn:
        # 指向工作负载命名空间中由 MCPServer 生成的 Service。
        hostname: k8s-mcp-server.team-a.svc.cluster.local
        port: 8080
```

外部 HTTPS 后端使用 Envoy 网关 `Backend` 和 `BackendTLSPolicy`。以下示例指向一个公共可流式传输的 HTTP MCP 服务器。这并不意味着在共享命名空间中部署了相应的 MCP 服务器。对于生产环境，将主机名、路径和 TLS 主机名替换为您希望公开的外部 MCP 端点，然后将 `Backend` 名称添加到 `MCPRoute.spec.backendRefs`。

```yaml
# 公共外部 MCP 服务器的网关后端。
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: zipp
  namespace: mcp-gateway-system
spec:
  endpoints:
    - fqdn:
        # Zipp 的公共可流式传输 HTTP MCP 端点域。
        hostname: zippfeed.com
        port: 443
---
apiVersion: gateway.networking.k8s.io/v1
kind: BackendTLSPolicy
metadata:
  name: zipp-tls
  namespace: mcp-gateway-system
spec:
  targetRefs:
    # 绑定到 zipp 后端的 TLS 验证策略。
    - group: gateway.envoyproxy.io
      kind: Backend
      name: zipp
  validation:
    wellKnownCACertificates: System
    hostname: zippfeed.com
---
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: MCPRoute
metadata:
  name: unified-mcp
  namespace: mcp-gateway-system
spec:
  parentRefs:
    - name: ai-mcp-gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  path: /mcp
  backendRefs:
    - name: k8s-mcp-server
      kind: Backend
      group: gateway.envoyproxy.io
      path: /mcp
    - name: zipp
      kind: Backend
      group: gateway.envoyproxy.io
      path: /mcp/
```

### 每个后端的头转发

Envoy AI 网关 `MCPRoute` 支持每个 MCP 后端的头转发。客户端请求中的选定头可以仅转发到特定后端，并且在转发到后端时可以更改头名称。在使用这些字段之前，请检查实际安装的 `MCPRoute` CRD。

此配置适用于客户端已经持有后端所需凭证的情况，网关仅执行选择性转发或头重命名。例如，客户端发送 `x-zipp-api-key`；网关仅在访问外部后端时将其转发为 `X-Zipp-API-Key`。`k8s-mcp-server` 未配置 `forwardHeaders`，因此不会接收此头。

```yaml
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: MCPRoute
metadata:
  name: unified-mcp
  namespace: mcp-gateway-system
spec:
  parentRefs:
    - name: ai-mcp-gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  path: /mcp
  backendRefs:
    - name: zipp
      kind: Backend
      group: gateway.envoyproxy.io
      path: /mcp/
      # 每个后端的客户端头转发和重命名。
      forwardHeaders:
        - name: x-zipp-api-key
          backendHeader: X-Zipp-API-Key
    - name: k8s-mcp-server
      kind: Backend
      group: gateway.envoyproxy.io
      path: /mcp
      # 没有 forwardHeaders，客户端凭证头不会转发到此后端。
```

## 使用 API 密钥进行入口身份验证

共享的 Envoy 网关可以使用 `SecurityPolicy.apiKeyAuth` 进行入口 API 密钥身份验证。API 密钥仅保护统一的 MCP 入口，与后端 MCP 服务器访问凭证不同。后端凭证由每个 MCP 后端独立处理。

入口 API 密钥存储在网关命名空间中的一个 Secret 中。Secret 键是客户端 ID，值是该客户端的 API 密钥：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mcp-api-keys
  namespace: mcp-gateway-system
type: Opaque
stringData:
  # opencode-user-1 是客户端 ID；值是平台为该客户端发放的入口 API 密钥。
  opencode-user-1: replace-with-real-api-key
```

将 `SecurityPolicy` 附加到特定于 MCP 的 `Gateway`，并从 `x-api-key` 请求头中读取 API 密钥。身份验证成功后，Envoy 网关可以将客户端 ID 转发到后端。启用 `sanitize`，以便在转发到 MCP 服务器之前不转发入口 API 密钥：

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: ai-mcp-apikey
  namespace: mcp-gateway-system
spec:
  targetRefs:
    # 将入口 API 密钥身份验证附加到特定于 MCP 的网关。
    - name: ai-mcp-gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  apiKeyAuth:
    # 从客户端请求头中读取入口 API 密钥。
    extractFrom:
      - headers:
          - x-api-key
    credentialRefs:
      # 引用上述 mcp-api-keys Secret。
      - name: mcp-api-keys
    # 身份验证后，转发客户端 ID 以进行日志记录和审计。
    forwardClientIDHeader: x-mcp-client-id
    # 在转发到后端之前，从请求中删除 x-api-key。
    sanitize: true
```

注意事项：

- 将 `SecurityPolicy` 附加到特定于 MCP 的 `Gateway`，以避免保护同一网关上不相关的路由。
- 使用 `x-api-key` 来携带入口 API 密钥。
- `x-mcp-client-id` 来自网关身份验证结果，可用于日志记录、审计或后端意识到调用者。不要将客户端发送的同名头视为权威身份。
- 入口 API 密钥和后端 MCP 服务器凭证是两种不同类型的凭证。入口 API 密钥用于访问统一的 MCP 入口。后端凭证由网关用于访问特定的 MCP 后端。

## opencode 客户端配置示例

opencode 可以通过 `opencode mcp add` 添加远程 MCP 服务器；不需要手动编辑 JSON。客户端仍然连接到一个统一的 MCP 地址。工具聚合和后端调度由共享网关和统一的 `MCPRoute` 处理。在以下示例中，`<mcp-endpoint>` 代表实际的入口地址，可以是域名、负载均衡器地址或 NodePort 调试地址。

使用 API 密钥时，opencode 只需在请求头中发送固定凭证：

```bash
# <mcp-api-key> 是平台为当前用户或自动化账户发放的 MCP 入口凭证。
# 必须与上述 mcp-api-keys Secret 中的一个客户端 ID 的值匹配。
# API 密钥通过环境变量注入，不写入 opencode 配置文件。
export MCP_API_KEY="<mcp-api-key>"

# 添加统一的 MCP 入口。opencode 将配置写入其自己的配置文件。
# --header 使用 name=value 格式；实际的 HTTP 请求头为 x-api-key: <MCP_API_KEY>。
opencode mcp add alauda-mcp \
  --url "<mcp-endpoint>/mcp" \
  --header "x-api-key={env:MCP_API_KEY}"
```

检查 MCP 服务器状态：

```bash
opencode mcp list
```

## OIDC 集成

API 密钥身份验证用于首先启动主流程。当需要 OIDC 时，将入口身份验证切换为 `MCPRoute.securityPolicy.oauth`。

当 opencode 通过 OAuth 登录到远程 MCP 服务器时，MCP 入口需要返回身份验证挑战和由 MCP 授权规范定义的受保护资源元数据。此功能由 `MCPRoute.securityPolicy.oauth` 提供：

```yaml
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: MCPRoute
metadata:
  name: unified-mcp
  namespace: mcp-gateway-system
spec:
  parentRefs:
    - name: ai-mcp-gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  path: /mcp
  securityPolicy:
    oauth:
      # 授权服务器发行者。MCPRoute 使用它来发现授权服务器元数据和 JWKS。
      issuer: https://idp.example.com/realms/ai
      # 验证访问令牌是否为 MCP 入口发行。
      audiences:
        - ai-mcp
      protectedResourceMetadata:
        # 受保护资源标识符。必须与 opencode 用于访问 MCP 入口的 URL 匹配。
        resource: "<mcp-endpoint>/mcp"
        resourceName: alauda-mcp
  backendRefs:
    # 省略：保持与“配置统一的 MCP 入口”中的 backendRefs 一致。
    - name: k8s-mcp-server
      kind: Backend
      group: gateway.envoyproxy.io
      path: /mcp
```

在 OIDC 模式下，不要将 API 密钥身份验证附加到此 MCP 入口，以便客户端不必维护两个入口凭证。如果需要额外的平台级授权，请连接一个单独的授权服务。

在 OIDC 模式下，opencode 使用远程 MCP OAuth 流程进行登录。MCP 入口必须提供身份验证挑战和由 MCP OAuth 规范定义的受保护资源元数据，以便 opencode 可以发现授权服务器并完成登录。

在 opencode 端，首先添加远程 MCP 入口，然后启动 OAuth 登录：

```bash
# 添加统一的 MCP 入口。在 OIDC/OAuth 模式下，不要配置静态授权头。
opencode mcp add alauda-mcp \
  --url "<mcp-endpoint>/mcp"

# 启动 OAuth 登录流程。opencode 打开授权 URL 或在终端中打印它。
opencode mcp auth alauda-mcp

# 登录后检查 MCP 服务器状态。
opencode mcp list
```

登录后，opencode 存储并刷新 OAuth 令牌，并在访问 MCP 入口时发送 `Authorization: Bearer <access-token>`。`MCPRoute.securityPolicy.oauth` 验证令牌的发行者、受众、签名和所需声明。MCPRoute 和 MCPServer 集成模型保持不变。

## 参考文献

- Envoy AI 网关 MCP 文档：<https://github.com/envoyproxy/ai-gateway/blob/main/site/docs/capabilities/mcp/index.md>
- Envoy AI 网关 MCPRoute API：<https://github.com/envoyproxy/ai-gateway/blob/main/api/v1beta1/mcp_route.go>
- Envoy AI 网关 MCP 示例：<https://github.com/envoyproxy/ai-gateway/tree/main/examples/mcp>
- opencode MCP 服务器配置文档：<https://opencode.ai/docs/mcp-servers/>
- MCP 生命周期操作员：<https://github.com/kubernetes-sigs/mcp-lifecycle-operator>
- MCP 生命周期操作员文档：<https://mcp-lifecycle-operator.sigs.k8s.io/>
