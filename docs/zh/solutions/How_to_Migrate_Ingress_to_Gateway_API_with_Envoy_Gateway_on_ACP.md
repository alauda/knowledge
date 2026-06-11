---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x and later
tags:
  - LB
id: KB260600056
sourceSHA: 2640af3da000629d99d6d6592f1da25e7575d7bb5e366fa2990b63f0e9bb7e9e
---

# 如何在 ACP 上使用 Envoy Gateway 将 Ingress 迁移到 Gateway API

## 概述

本指南描述了如何将 Kubernetes `Ingress` 流量规则迁移到基于 Envoy Gateway 的 Gateway API 资源，适用于 Alauda 容器平台。

将迁移视为一种保持行为不变的变更，而不是机械地重命名 YAML。Gateway API 模型将流量入口、路由和策略分离为不同的资源：

- `EnvoyGatewayCtl` 部署和管理 Envoy Gateway 控制平面。
- `GatewayClass` 选择管理 `Gateway` 的 Envoy Gateway 控制器。
- `Gateway` 定义监听器、TLS 终止和外部流量入口点。
- `EnvoyProxy` 控制 Envoy 数据平面部署和服务暴露。
- `HTTPRoute`、`TLSRoute`、`TCPRoute`、`UDPRoute` 和 `GRPCRoute` 定义路由行为。
- `Backend` 描述非普通 HTTP 上游，包括不应建模为普通 HTTP `Service` 后端的 HTTPS 上游。
- `SecurityPolicy`、`ClientTrafficPolicy`、`BackendTrafficPolicy`、`BackendTLSPolicy` 和 `EnvoyExtensionPolicy` 承载通常存储为 Ingress 注释的高级行为。

上游 Gateway API 迁移指南提供了标准资源映射，而 `ingress2gateway` 可以生成初始的 Gateway API 清单。然而，特定于提供者的注释、正则表达式重写、动态头逻辑和后端 TLS 行为仍需手动审核和测试。

## 迁移映射模型

在与旧入口点相同的所有权级别上建模迁移：

- 一个 Ingress 控制器条目映射到一个 `Gateway`。如果旧的流量入口是一个 ingress-nginx 实例或一个 ALB 实例，则创建一个 `Gateway` 来替换该条目。
- 默认情况下，一个 Kubernetes `Ingress` 映射到一个 `HTTPRoute`。该路由通过 `parentRefs` 附加到替换的 `Gateway`。
- Ingress 注释不会成为 `Gateway` 的注释。将它们转换为 `HTTPRoute` 过滤器或与旧 `Ingress` 具有相同范围的 Envoy Gateway 策略和扩展资源。
- 后端 `Service` 引用仅在上游协议为普通 HTTP 时保持为 `Service` backendRefs。如果旧 Ingress 使用 HTTPS 的后端协议，则将该上游迁移到 Envoy Gateway `Backend` 资源，并从 `HTTPRoute` 引用该 `Backend`。

这种映射使第一次迁移可审查：将一个旧控制器条目与一个新 `Gateway` 进行比较，将每个旧 `Ingress` 与一个新 `HTTPRoute` 进行比较。在验证行为后，路由仍然可以拆分或合并以实现长期所有权。

## 先决条件

1. ACP 4.3.x 或更高版本。
2. 已安装 Envoy Gateway Operator。
3. 已创建 `EnvoyGatewayCtl`，并接受其生成的 `GatewayClass`。
4. `kubectl` 可以访问目标集群。
5. 在迁移之前，现有的 `Ingress`、`Service`、TLS `Secret` 和后端应用程序处于健康状态。
6. 在切换期间，可以控制 DNS、外部负载均衡器或 MetalLB VIP 的更改。
7. 如果前端负载均衡器已经拥有外部 IP，则在迁移之前已知其监听器、后端池、后端端口、健康检查和流量切换方法。

## 推荐目标布局

对于正常部署，每个集群使用一个 `EnvoyGatewayCtl`。为每个需要独立暴露、调度、证书或所有权的流量边界创建一个 `Gateway`。对于许多用户工作负载，共享项目 Gateway 或每个项目一个 Gateway 比每个应用程序一个 Gateway 更易于操作。

对于 Gateway 数据平面：

- 当集群具有 LoadBalancer 提供者（如 MetalLB）时，优先使用 `EnvoyProxy.spec.provider.kubernetes.envoyService.type: LoadBalancer`。
- 当 Gateway 需要稳定的 VIP 时，在 `EnvoyProxy` 服务配置中使用 MetalLB 注释。如果您想重用先前的 VIP，请先从旧的 LoadBalancer 服务中释放该 VIP。MetalLB 不能同时将相同的 VIP 分配给旧入口和新 Gateway 服务。
- 对于私有 Gateway，使用 `allowedRoutes.namespaces.from: Same`。
- 对于共享 Gateway，使用 `allowedRoutes.namespaces.from: Selector`，以便只有预期的项目命名空间可以附加路由。
- 仅在没有 LoadBalancer 提供者时使用 `NodePort`，并确保用户访问 NodePort 值，而不是监听器端口。
- 仅在特殊兼容性或性能情况下使用 `hostNetwork`，并将 Envoy pod 固定到选定节点以避免端口冲突。
- 如果前端负载均衡器已经暴露了稳定的外部 IP，请将该外部 IP 保留在前端负载均衡器上，并通过仅更改其后端目标进行迁移。Gateway 数据平面可以在前端负载均衡器后面使用 `hostNetwork` 或 `NodePort`。

示例共享 Gateway：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: project-gateway
  namespace: project-gateway
spec:
  gatewayClassName: envoy-gateway-operator-cpaas-default
  infrastructure:
    parametersRef:
      group: gateway.envoyproxy.io
      kind: EnvoyProxy
      name: project-gateway
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              cpaas.io/project: demo-project
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: project-gateway-tls
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              cpaas.io/project: demo-project
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: project-gateway
  namespace: project-gateway
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: LoadBalancer
        annotations:
          metallb.universe.tf/address-pool: production
          metallb.universe.tf/loadBalancerIPs: 192.0.2.20
      envoyDeployment:
        replicas: 2
```

## 第 1 章. 清点现有 Ingress

### 第 1 步：导出源资源

设置命名空间和 Ingress 名称：

```bash
export APP_NAMESPACE="demo"
export INGRESS_NAME="demo-web"

kubectl get ingress "${INGRESS_NAME}" -n "${APP_NAMESPACE}" -o yaml > ingress-source.yaml
kubectl get svc -n "${APP_NAMESPACE}" -o yaml > services-source.yaml
kubectl get secret -n "${APP_NAMESPACE}" -o yaml > secrets-source.yaml
```

对于命名空间范围的迁移，导出所有 Ingress 对象：

```bash
kubectl get ingress -n "${APP_NAMESPACE}" -o yaml > ingress-source.yaml
```

### 第 2 步：记录必须保留的行为

对于每个 Ingress，记录：

| 区域             | 检查内容                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 入口            | Ingress 类、外部 VIP、DNS 名称、HTTP 和 HTTPS 端口                                                                                                                                                                                           |
| TLS              | `spec.tls[].hosts`、`spec.tls[].secretName`、直通或终止行为                                                                                                                                                                                |
| 路由            | 主机名、路径值、`pathType`、后端服务和端口                                                                                                                                                                                                  |
| 注释            | 重写、重定向、超时、CORS、身份验证、头部修改、会话亲和性、速率限制、主体大小、白名单、WAF、自定义片段                                                                                                                                        |
| 后端协议        | 后端服务端口是否期望 HTTP、HTTPS、gRPC、TCP 或 TLS 直通。将 `nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"` 视为创建 Envoy Gateway `Backend` 的信号，而不是普通的 `Service` backendRef。                                   |
| 优先级          | 重叠路径，如 `/`、`/api`、`/api/v1` 和正则表达式样式路径                                                                                                                                                                                 |
| 测试            | 代表性的 curl 请求、预期状态码、头部、重定向和响应主体                                                                                                                                                                                    |

在转换任何内容之前保存一个简单的请求测试列表：

```bash
cat > migration-cases.txt <<'EOF'
https://app.example.com/
https://app.example.com/api/healthz
https://app.example.com/api/v1/orders
http://app.example.com/
EOF
```

## 第 2 章. 使用 ingress2gateway 生成草稿

从其上游发布或使用 Go 安装 `ingress2gateway`：

```bash
go install github.com/kubernetes-sigs/ingress2gateway@v1.0.0
```

从实时的 ingress-nginx 资源生成初始的 Gateway API 清单：

```bash
ingress2gateway print \
  --providers=ingress-nginx \
  --ingress-nginx-ingress-class=nginx \
  --namespace="${APP_NAMESPACE}" \
  --output=yaml > gateway-draft.yaml
```

如果您将清单导出到文件并希望避免从实时集群读取，请使用：

```bash
ingress2gateway print \
  --providers=ingress-nginx \
  --input-file=ingress-source.yaml \
  --output=yaml > gateway-draft.yaml
```

仔细检查命令输出和 `gateway-draft.yaml`。`ingress2gateway` 对于初步草稿非常有用，但它不是完整的兼容性检查器：

- 它报告未翻译的字段或不支持的功能。
- 它不打算将 Ingress 注释直接复制到 Gateway API。
- 仅当可以通过 Gateway API 或受支持的发射器表示时，才支持特定于提供者的行为。
- 对于 ACP Envoy Gateway，您仍然需要将生成的资源与集群中使用的目标 `GatewayClass`、`Gateway`、`EnvoyProxy` 和策略布局对齐。

## 第 3 章. 转换核心 Ingress 字段

使用以下映射标准 Kubernetes Ingress 字段：

| Ingress                                                                    | Gateway API / Envoy Gateway                                                                                                                    |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.ingressClassName` 或 `kubernetes.io/ingress.class`                   | `Gateway.spec.gatewayClassName`                                                                                                                |
| `spec.rules[].host`                                                        | `Gateway.spec.listeners[].hostname` 和 `HTTPRoute.spec.hostnames`                                                                             |
| HTTP 监听器                                                              | `Gateway` 监听器，协议为 `HTTP`，通常为端口 `80`                                                                                               |
| 带 TLS 终止的 HTTPS 监听器                                                | `Gateway` 监听器，协议为 `HTTPS`，端口 `443`，并且 `tls.mode: Terminate`                                                                      |
| `spec.tls[].secretName`                                                    | `Gateway.spec.listeners[].tls.certificateRefs[]`                                                                                               |
| `spec.rules[].http.paths[].path`                                           | `HTTPRoute.spec.rules[].matches[].path.value`                                                                                                  |
| `pathType: Exact`                                                          | `HTTPRoute` 路径匹配 `type: Exact`                                                                                                           |
| `pathType: Prefix`                                                         | `HTTPRoute` 路径匹配 `type: PathPrefix`                                                                                                      |
| `pathType: ImplementationSpecific`                                         | 手动审核。仅在确认旧控制器行为后使用 `PathPrefix`、`Exact` 或 `RegularExpression`。                                                              |
| `backend.service.name` 和 `backend.service.port` 使用普通 HTTP 上游      | `HTTPRoute.spec.rules[].backendRefs[]` 指向 `Service`                                                                                       |
| `backend.service.name` 和 `backend.service.port` 使用 HTTPS 上游         | Envoy Gateway `Backend` 资源从 `HTTPRoute.spec.rules[].backendRefs[]` 引用；不要将其留作普通 HTTP `Service` 后端。                             |
| `defaultBackend`                                                           | 一个捕获所有的 `HTTPRoute`，通常为 `PathPrefix /`，附加到没有主机名的监听器上                                                                     |

示例 `HTTPRoute`：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: demo-web
  namespace: demo
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: project-gateway
      namespace: project-gateway
      sectionName: https
  hostnames:
    - app.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      backendRefs:
        - group: ""
          kind: Service
          name: demo-api
          port: 8080
          weight: 100
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - group: ""
          kind: Service
          name: demo-web
          port: 8080
          weight: 100
```

首先应用简单的路由：

```bash
kubectl apply -f project-gateway.yaml
kubectl apply -f demo-web-httproute.yaml
```

检查状态条件：

```bash
kubectl get gateway -n project-gateway project-gateway -o yaml
kubectl get httproute -n demo demo-web -o yaml
```

`Gateway` 监听器应被接受，`HTTPRoute` 应被父监听器接受。

## 第 4 章. 替换常见的 Ingress 注释

不要盲目移动注释。决定哪个 Gateway API 资源拥有该行为。

| Ingress 行为                                   | 推荐的 Gateway API / Envoy Gateway 替代                                                                                                                                       |                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 静态请求头添加/设置/删除               | `HTTPRoute.rules[].filters[].requestHeaderModifier`                                                                                                                                       |                                                                                                                                                                                                                                                                                                      |
| 静态响应头添加/设置/删除              | `HTTPRoute.rules[].filters[].responseHeaderModifier` 或 `ClientTrafficPolicy` 当行为是监听器范围时                                                                          |                                                                                                                                                                                                                                                                                                      |
| HTTP 到 HTTPS 重定向或路径重定向            | `HTTPRoute.rules[].filters[].requestRedirect`                                                                                                                                             |                                                                                                                                                                                                                                                                                                      |
| 简单前缀重写                              | `HTTPRoute.rules[].filters[].urlRewrite` 使用 `ReplacePrefixMatch`                                                                                                                        |                                                                                                                                                                                                                                                                                                      |
| 全路径重写                                  | `HTTPRoute.rules[].filters[].urlRewrite` 使用 `ReplaceFullPath`                                                                                                                           |                                                                                                                                                                                                                                                                                                      |
| 正则捕获重写，例如 \`/shop(/            | $)(.\*)`到`/$2\`                                                                                                                                                                          | 手动审核。标准 `HTTPRoute` `URLRewrite` 仅支持 `ReplaceFullPath` 和 `ReplacePrefixMatch`；它无法表达任意捕获替换。当需要该行为时，使用 Envoy Gateway 扩展或策略资源，例如 `HTTPRouteFilter`，与 `ReplaceRegexMatch`。 |
| Cookie 到头部或其他动态值提取 | `EnvoyExtensionPolicy`，通常附加到选定的 `HTTPRoute` 对象，而不是整个 `Gateway`                                                                                         |                                                                                                                                                                                                                                                                                                      |
| CORS                                               | `SecurityPolicy.spec.cors` 或 `HTTPRoute` CORS 过滤器（如支持）                                                                                                                     |                                                                                                                                                                                                                                                                                                      |
| API 密钥身份验证                             | `SecurityPolicy.spec.apiKeyAuth`                                                                                                                                                          |                                                                                                                                                                                                                                                                                                      |
| 客户端 TLS 版本和密码设置             | `ClientTrafficPolicy.spec.tls`                                                                                                                                                            |                                                                                                                                                                                                                                                                                                      |
| 后端超时、重试和负载均衡         | `HTTPRoute` 规则选项或 `BackendTrafficPolicy`，具体取决于所需范围                                                                                                           |                                                                                                                                                                                                                                                                                                      |
| 基于头部的一致哈希                       | `BackendTrafficPolicy.spec.loadBalancer` 通过头部的一致哈希，而不是 `HTTPRoute.rules[].sessionPersistence.type: Header`                                                          |                                                                                                                                                                                                                                                                                                      |
| 包含下划线的头部                     | `ClientTrafficPolicy.spec.withUnderscoresAction` 当旧条目接受此类头部且客户端仍然发送它们时                                                                     |                                                                                                                                                                                                                                                                                                      |
| 后端 HTTPS 重新加密                           | Envoy Gateway `Backend` 资源由 `HTTPRoute` 引用；在 `Backend` 上放置 TLS 设置或将 `BackendTLSPolicy` 附加到该 `Backend` 当需要单独的策略所有权时 |                                                                                                                                                                                                                                                                                                      |
| 跨命名空间证书引用              | 在拥有 `Secret` 的命名空间中使用 `ReferenceGrant`                                                                                                                                  |                                                                                                                                                                                                                                                                                                      |
| TLS 直通                                    | `Gateway` TLS 监听器，`tls.mode: Passthrough` 加上 `TLSRoute`，而不是 `HTTPRoute`                                                                                                      |                                                                                                                                                                                                                                                                                                      |

示例 HTTP 到 HTTPS 重定向：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: demo-web-http-redirect
  namespace: demo
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: project-gateway
      namespace: project-gateway
      sectionName: http
  hostnames:
    - app.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

示例简单前缀重写：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: demo-api
  namespace: demo
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: project-gateway
      namespace: project-gateway
      sectionName: https
  hostnames:
    - app.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
      backendRefs:
        - name: demo-api
          port: 8080
```

示例基于头部的一致哈希：

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: demo-api-header-hash
  namespace: demo
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: demo-api
  loadBalancer:
    type: ConsistentHash
    consistentHash:
      type: Header
      header:
        name: X-Session-Id
```

这是正确的替代方案，当旧 Ingress 或 ALB 根据请求头值进行哈希选择上游时，例如 ingress-nginx `upstream-hash-by: "$http_x_session_id"`。不要将该行为映射到 `HTTPRoute.rules[].sessionPersistence.type: Header`。`HTTPRoute` 头部会话持久性是 Envoy 有状态会话行为：Envoy 在响应头中写入会话令牌，客户端必须将该令牌发送回去，以便 Envoy 尝试返回到先前的上游主机。

示例用于包含下划线的头部的策略：

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: allow-underscore-headers
  namespace: project-gateway
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: project-gateway
  withUnderscoresAction: Allow
```

Envoy Gateway 遵循 Envoy 的默认行为，并拒绝包含下划线的请求头，除非更改此行为。仅在现有客户端需要这些头部时使用 `Allow`。当请求应继续但不应转发下划线头部时，使用 `DropHeader`。

示例带有正则捕获重写的 Envoy Gateway 扩展：

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: HTTPRouteFilter
metadata:
  name: shop-path-rewrite
  namespace: demo
spec:
  urlRewrite:
    path:
      type: ReplaceRegexMatch
      replaceRegexMatch:
        pattern: "^/shop(/|$)(.*)"
        substitution: "/\\2"
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop-web
  namespace: demo
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: project-gateway
      namespace: project-gateway
      sectionName: https
  hostnames:
    - app.example.com
  rules:
    - matches:
        - path:
            type: RegularExpression
            value: "^/shop(/|$)(.*)"
      filters:
        - type: ExtensionRef
          extensionRef:
            group: gateway.envoyproxy.io
            kind: HTTPRouteFilter
            name: shop-path-rewrite
      backendRefs:
        - name: shop-web
          port: 8080
```

示例 HTTPS 后端与 Envoy Gateway `Backend` 资源：

```yaml
apiVersion: envoy-gateway.alauda.io/v1
kind: EnvoyGatewayCtl
metadata:
  name: default
  namespace: envoy-gateway-system
spec:
  config:
    envoyGateway:
      extensionApis:
        enableBackend: true
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: secure-api
  namespace: demo
spec:
  type: Endpoints
  endpoints:
    - fqdn:
        hostname: secure-api.demo.svc.cluster.local
        port: 8443
  tls:
    sni: secure-api.demo.svc.cluster.local
    caCertificateRefs:
      - group: ""
        kind: Secret
        name: secure-api-ca
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: secure-api
  namespace: demo
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: project-gateway
      namespace: project-gateway
      sectionName: https
  hostnames:
    - app.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /secure-api
      backendRefs:
        - group: gateway.envoyproxy.io
          kind: Backend
          name: secure-api
```

`Backend.tls.caCertificateRefs` 引用的 CA 对象必须在键 `ca.crt` 中包含 CA 证书。仅在明确接受风险的环境中使用 `insecureSkipVerify: true`，其中后端证书验证故意禁用。

## 第 5 章. 处理正则表达式和路径优先级

Gateway API 路径匹配比许多 Ingress 控制器行为更明确和严格。

使用以下规则：

1. 对于单个固定 API 路径，优先使用 `Exact`。
2. 对于普通应用程序子树，如 `/api` 或 `/console`，优先使用 `PathPrefix`。
3. 仅在旧 Ingress 需要正则表达式行为时使用 `RegularExpression`。
4. 重新测试每个正则表达式规则，因为 Envoy Gateway 使用 RE2 风格的正则表达式。
5. 当特定 API 路径与广泛的前端路径重叠时，使特定路径为 `Exact`，以便不会被更广泛的前缀或正则表达式路由遮蔽。

示例：

```yaml
rules:
  - matches:
      - path:
          type: Exact
          value: /shop/admin/reports
    backendRefs:
      - name: shop-admin-api
        port: 80
  - matches:
      - path:
          type: RegularExpression
          value: /shop(/|$)(.*)
    backendRefs:
      - name: shop-web
        port: 8080
```

## 第 6 章. 计划在前端负载均衡器后平稳切换

当前端负载均衡器已经拥有外部地址时，在迁移期间不要移动外部 LB IP。保持公共或私有 LB 监听器不变，仅将后端池从旧的 Ingress 控制器节点切换到新的 Envoy Gateway 节点。

使用此模型：

```text
client -> front load balancer external IP -> backend targets -> old ingress or Envoy Gateway
```

前端负载均衡器应保持相同的外部 IP、DNS 记录、监听器端口、TLS 模式和面向客户端的健康检查行为。迁移更改其后端目标和权重。

在更改流量之前，记录：

| 区域                 | 记录内容                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| 前端             | 外部 IP、DNS 名称、监听器端口、TLS 终止或直通模式                                |
| 旧后端池     | 节点 IP、后端端口、健康检查路径和端口、后端权重                                       |
| Gateway 后端池 | 新节点 IP、后端端口、健康检查路径和端口                                                   |
| 流量切换     | 前端负载均衡器是否支持禁用后端、权重、排水或立即池替换 |
| 源地址       | 应用程序是否依赖于客户端源 IP、`X-Forwarded-*` 头部或 PROXY 协议           |

### 选项 A：并行 hostNetwork 和端口偏移

这是最安全的 hostNetwork 模式，当旧的 Ingress 控制器仍然绑定节点端口 `80` 和 `443` 时。Envoy Gateway 可以运行 `hostNetwork: true` 和默认特权端口偏移。监听器端口 `80` 通过节点端口 `10080` 到达，监听器端口 `443` 通过节点端口 `10443` 到达。

外部 LB IP 保持不变，因为仅更改前端负载均衡器后端端口。

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: project-gateway
  namespace: project-gateway
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: ClusterIP
      envoyDeployment:
        replicas: 2
        patch:
          type: StrategicMerge
          value:
            spec:
              template:
                spec:
                  hostNetwork: true
                  dnsPolicy: ClusterFirstWithHostNet
        pod:
          nodeSelector:
            gateway-role: envoy
```

切换流程：

1. 为 Envoy Gateway 标记一组节点，例如 `gateway-role=envoy`。
2. 部署 `Gateway`、`EnvoyProxy`、`HTTPRoute`、`Backend` 和策略资源。
3. 通过将请求发送到 `10080` 或 `10443` 上的 Gateway 节点，使用原始主机头直接测试新的数据平面。
4. 将 Gateway 节点添加到前端负载均衡器后端池，后端端口为 `10080` 和 `10443`，如果负载均衡器支持，最初禁用或权重为 `0`。
5. 启用少量流量或一个低风险主机名。
6. 在验证状态码、延迟、重写行为和后端 TLS 后，增加流量到 Gateway 后端池。
7. 在 Gateway 为约定的观察窗口提供所有流量后，移除旧的 Ingress 后端池。

回滚仅是前端负载均衡器操作：禁用或将 Gateway 后端池的权重设置为 `0`，并将流量恢复到旧的 Ingress 后端池。

### 选项 B：标准端口上的 hostNetwork

仅在前端负载均衡器必须将流量发送到节点端口 `80` 和 `443`，或当兼容性要求 Envoy Gateway 绑定与旧 Ingress 控制器相同的主机端口时使用此选项。

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: project-gateway
  namespace: project-gateway
spec:
  provider:
    type: Kubernetes
    kubernetes:
      useListenerPortAsContainerPort: true
      envoyService:
        type: ClusterIP
      envoyDeployment:
        replicas: 2
        patch:
          type: StrategicMerge
          value:
            spec:
              strategy:
                type: RollingUpdate
                rollingUpdate:
                  maxSurge: 0
                  maxUnavailable: 1
              template:
                spec:
                  hostNetwork: true
                  dnsPolicy: ClusterFirstWithHostNet
                  containers:
                    - name: envoy
                      command:
                        - /usr/local/bin/envoy-with-cap
                      securityContext:
                        capabilities:
                          add:
                            - NET_BIND_SERVICE
        pod:
          nodeSelector:
            gateway-role: envoy
```

使用此选项，旧的 Ingress pod 和新的 Envoy pod 不能在同一节点上绑定相同的主机端口。因此，平稳迁移需要以下布局之一：

- 使用单独的 Gateway 节点集。将这些节点添加到前端负载均衡器后端池，端口为 `80` 和 `443`，切换流量，然后移除旧的 Ingress 节点。
- 如果没有单独的节点可用，首先从旧的 Ingress 后端池中排水或移除一个节点，停止该节点上的旧 Ingress pod，以便 `80` 和 `443` 端口可用，在该节点上调度 Envoy Gateway，验证它，然后将该节点重新添加为 Gateway 后端。
- 如果既没有单独的节点，也没有逐节点排水，切换无法在相同的主机端口上完全平稳。使用端口偏移模式或计划短暂的维护窗口。

### 选项 C：在前端负载均衡器后使用 NodePort

如果不需要 hostNetwork，将 Envoy Gateway 公开为 `NodePort`，并将前端负载均衡器指向分配的 NodePort 值。外部 LB IP 保持不变；仅更改后端目标端口。

此模式避免了主机端口冲突，但后端端口位于 Kubernetes NodePort 范围内。除非 NodePort 值已明确分配给这些数字并且对于集群的 NodePort 范围有效，否则不要将前端负载均衡器配置为使用监听器端口 `80` 和 `443`。

## 第 7 章. 在切换前进行验证

### 第 1 步：验证资源状态

```bash
kubectl get gateway -A
kubectl get httproute -A
kubectl get backend -A
kubectl get backendtlspolicy -A
kubectl get securitypolicy -A
kubectl get clienttrafficpolicy -A
kubectl get backendtrafficpolicy -A
```

检查被拒绝的资源：

```bash
kubectl get httproute -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{" "}{.status.parents[*].conditions[*].type}{" "}{.status.parents[*].conditions[*].status}{"\n"}{end}'
```

### 第 2 步：在 DNS 切换之前通过 Gateway 地址进行测试

获取 Gateway 服务地址或前端负载均衡器后端目标地址：

```bash
kubectl get svc -n project-gateway \
  -l gateway.envoyproxy.io/owning-gateway-name=project-gateway
```

在 Gateway VIP、NodePort、hostNetwork 节点端口或前端负载均衡器金丝雀后端上运行记录的请求案例，同时保留原始主机头：

```bash
export GATEWAY_ADDRESS="192.0.2.20"
export GATEWAY_PORT="443"

while read -r url; do
  host="$(printf '%s\n' "$url" | sed -E 's#^https?://([^/]+)/?.*#\1#')"
  path="$(printf '%s\n' "$url" | sed -E 's#^https?://[^/]+##')"
  [ -n "$path" ] || path="/"
  curl -k -i -H "Host: ${host}" "https://${GATEWAY_ADDRESS}:${GATEWAY_PORT}${path}"
done < migration-cases.txt
```

验证：

- 状态码与旧 Ingress 行为匹配。
- 重定向 `Location` 头正确。
- 所需的响应头存在。
- 重写后的后端请求路径正确。
- 身份验证和 CORS 行为符合原始要求。
- HTTPS 后端不返回 TLS 或上游协议错误。

### 第 3 步：在切换期间运行两个条目

在新 Gateway 路径通过功能检查之前，保持旧 Ingress 活跃。通过根据您的环境更改 DNS、外部负载均衡器后端或 VIP 绑定来切换。

在切换期间：

1. 从低风险主机名或低流量应用程序开始。
2. 监控 HTTP 错误率、延迟和 Envoy Gateway 资源状态。
3. 保持旧 Ingress 清单不变以便回滚。
4. 当前端负载均衡器拥有外部 IP 时，保持前端 IP 和监听器不变；仅切换后端池或后端权重。
5. 当重用 MetalLB VIP 时，在创建或公开新的 Gateway 服务之前释放旧的 LoadBalancer 服务，使用 `metallb.universe.tf/loadBalancerIPs`。
6. 如果出现错误，将流量指向旧的 Ingress 条目，并检查被拒绝的 Gateway API 资源或 Envoy Gateway 日志。

## 第 8 章. 回滚

回滚应是流量引导操作，而不是资源重建练习。

在切换之前，请确保：

- 旧的 `Ingress` 及其 TLS `Secret` 仍然存在。
- 旧的 Ingress 控制器或 ALB 实例仍在提供流量。
- DNS TTL 或外部负载均衡器后端更改可以恢复。
- 如果使用前端负载均衡器，旧的后端池和健康检查仍然存在或可以立即恢复。
- Gateway API 资源是单独应用的，因此可以在不触及应用程序 `Service` 或 `Deployment` 资源的情况下删除。

回滚示例：

```bash
# 仅删除新的 Gateway API 路由。
kubectl delete httproute demo-web -n demo

# 或将 DNS / 外部 LB 流量移回旧的 Ingress 地址。
kubectl get ingress demo-web -n demo
```

## 故障排除

| 症状                                                | 检查                                                                                                                                                                                                                     |                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `HTTPRoute` 被忽略                                 | 检查 `parentRefs`、监听器 `sectionName`、监听器协议和 `allowedRoutes` 命名空间规则                                                                                                                              |                             |
| 从 Envoy Gateway 返回 404                                 | 检查主机名交集、路径类型、路径值和路由优先级                                                                                                                                                        |                             |
| TLS 证书未使用                            | 检查监听器 `certificateRefs`、Secret 命名空间、Secret 类型和跨命名空间引用的 `ReferenceGrant`                                                                                                            |                             |
| 后端返回 503 或 TLS 错误                      | 检查后端协议，HTTPS 上游是否使用 `Backend` 而不是普通的 `Service` backendRef，使用时的 `BackendTLSPolicy`，CA 秘钥 `ca.crt` 和 SNI 主机名                                                   |                             |
| 重定向循环                                          | HTTP 和 HTTPS 路由都重定向，或重定向目标指向 HTTP 监听器                                                                                                                               |                             |
| 正则路由匹配过多                           | 尽可能用 `Exact` 或 `PathPrefix` 替换；在需要正则表达式时添加路径边界，例如 \`(/                                                                                                                                       | $)\` |
| 基于头部的亲和性发生变化                          | 使用 `BackendTrafficPolicy` 通过请求头进行一致哈希，以实现 ALB 或 ingress-nginx `upstream-hash-by` 风格的行为                                                                                                   |                             |
| 集群内客户端无法访问 LoadBalancer VIP   | 使用 Gateway 服务 ClusterIP 进行集群内流量，或仅在该行为故意需要时更改 `EnvoyProxy` `externalTrafficPolicy`                                                                |                             |
| Gateway pod 无法使用 hostNetwork              | 检查是否有其他 pod 已经在该节点上绑定相同的主机端口；使用单独的节点集、默认端口偏移模式或在滚动更新期间使用 `maxSurge: 0`                                                |                             |
| 前端负载均衡器健康检查在迁移后失败 | 检查后端目标端口。使用 hostNetwork 端口偏移时，监听器 `80` 映射到节点端口 `10080`，监听器 `443` 映射到节点端口 `10443`。使用标准主机端口时，Envoy 必须成功绑定 `80` 和 `443`。 |                             |

## 参考文献

- Gateway API: [从 Ingress 迁移](https://gateway-api.sigs.k8s.io/guides/getting-started/migrating-from-ingress/)
- Kubernetes SIG 网络: [ingress2gateway](https://github.com/kubernetes-sigs/ingress2gateway)
- Kubernetes 博客: [在您迁移之前：您需要了解的五个令人惊讶的 Ingress-NGINX 行为](https://kubernetes.io/blog/2026/02/27/ingress-nginx-before-you-migrate/)
- Kubernetes 博客: [宣布 Ingress2Gateway 1.0：通往 Gateway API 的路径](https://kubernetes.io/blog/2026/03/20/ingress2gateway-1-0-release/)
- ACP 文档: [Envoy Gateway Operator](https://docs-dev.alauda.cn/container_platform/main/networking/operators/envoy_gateway_operator)
- ACP 文档: [配置 GatewayAPI Gateway](https://docs-dev.alauda.cn/container_platform/main/configure/networking/functions/configure_gatewayapi_gateway)
- ACP 文档: [配置 GatewayAPI 路由](https://docs-dev.alauda.cn/container_platform/main/configure/networking/functions/configure_gatewayapi_route)
- ACP 文档: [配置 GatewayAPI 策略](https://docs-dev.alauda.cn/container_platform/main/configure/networking/functions/configure_gatewayapi_policy)
- ACP 文档: [Envoy Gateway 的任务](https://docs-dev.alauda.cn/container_platform/main/configure/networking/how_to/tasks_for_envoy_gateway)
- ACP 文档: [使用 Envoy Gateway 进行 Ingress 负载均衡](https://docs-dev.alauda.cn/container_platform/main/networking/ingress_loadbalancing/ingress_loadbalance_with_envoy_gateway)
