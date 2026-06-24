---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x and later
tags:
  - LB
id: KB260600108
sourceSHA: 9b25ff963eb6231f0293bc6a4b07d80e9629837015847e0c2d5357dfd9b11a24
---

# 如何在 ACP 上配置 Envoy Gateway 的 HTTP 外部授权

## 概述

本指南描述了如何在 Alauda Container Platform (ACP) 4.3.x 及更高版本上配置 Envoy Gateway 的 HTTP 外部授权。

ACP 4.3 使用 Envoy Gateway 1.7。上游的 Envoy Gateway CRD 在 YAML 级别得到支持，无需额外的包装或字段修剪。ACP UI 可能不会暴露每个上游 CRD 字段或每个有效字段组合。对于外部授权、请求体转发、动态请求头注入、`failOpen` 和外部授权后端健康检查等高级 Envoy Gateway 功能，请直接使用 YAML 配置资源。

示例使用一个模拟授权服务器来演示行为。在生产环境中，请将 `SecurityPolicy.spec.extAuth.http.backendRefs` 中的模拟授权服务替换为实际的外部授权服务。

常见的流量流程为：

```text
客户端
  |
  v
网关监听器
  |
  +-- SecurityPolicy extAuth --> 外部授权服务
  |
  v
应用后端服务
```

## 先决条件

1. ACP 4.3.x 或更高版本。
2. 已安装 Envoy Gateway Operator。
3. 已创建 `EnvoyGatewayCtl` 实例，并接受其生成的 `GatewayClass`。
4. `kubectl` 可以访问目标集群。
5. 已知命名空间、应用后端服务和外部授权服务。

本文档中的示例使用以下名称。请将其替换为您环境中的值。

| 项目                        | 示例值                     |
| --------------------------- | -------------------------- |
| 命名空间                   | `demo-space`               |
| GatewayClass                | `demo-space-external-auth` |
| Gateway                     | `external-auth-gateway`    |
| 监听器                    | `http`                     |
| 应用路由                   | `app-route`                |
| 应用后端服务              | `app-backend`              |
| 模拟授权服务              | `mock-auth`                |
| 网关监听器端口            | `7100`                     |

## 第 1 章. 准备一个模拟授权服务器

在需要验证 Envoy Gateway 行为之前，可以使用模拟服务器。

模拟服务器暴露三个端点：

- `/auth/allow`：返回 `200` 并允许请求。
- `/auth/deny`：返回 `403` 并拒绝请求。
- `/healthz`：返回 `200` 以进行外部授权后端健康检查。

`/auth/allow` 端点还返回可以转发到应用后端的响应头：

- `x-auth-user`
- `x-auth-body-bytes`
- `x-auth-extra`

创建模拟服务器：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mock-auth-config
  namespace: demo-space
data:
  nginx-config: |
    worker_processes  1;
    daemon off;
    pid nginx.pid;

    events {
        worker_connections  1024;
    }

    http {
        access_log  /dev/stdout;
        error_log   /dev/stdout  info;

        server {
            listen 80;
            listen [::]:80;

            location /auth/allow {
              content_by_lua_block {
                ngx.req.read_body()
                local body = ngx.req.get_body_data() or ""
                ngx.header["x-auth-user"] = "mock-user"
                ngx.header["x-auth-body-bytes"] = tostring(string.len(body))
                ngx.header["x-auth-extra"] = ngx.var.http_x_ext_auth_extra or ""
                ngx.status = 200
                ngx.say("allow")
              }
            }

            location /auth/deny {
              content_by_lua_block {
                ngx.status = 403
                ngx.say("deny")
              }
            }

            location /healthz {
              content_by_lua_block {
                ngx.status = 200
                ngx.say("ok")
              }
            }
        }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mock-auth
  namespace: demo-space
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mock-auth
  template:
    metadata:
      labels:
        app: mock-auth
    spec:
      containers:
        - name: nginx
          image: registry.alauda.cn:60070/acp/alb2:v4.3.5
          command:
            - /usr/local/openresty/nginx/sbin/nginx
            - -c
            - /etc/nginx/nginx.conf
          ports:
            - name: http
              containerPort: 80
          volumeMounts:
            - name: nginx-config
              mountPath: /etc/nginx
      volumes:
        - name: nginx-config
          configMap:
            name: mock-auth-config
            items:
              - key: nginx-config
                path: nginx.conf
---
apiVersion: v1
kind: Service
metadata:
  name: mock-auth
  namespace: demo-space
spec:
  selector:
    app: mock-auth
  ports:
    - name: http
      port: 80
      targetPort: 80
```

以下示例后端打印 Envoy 转发到应用请求的授权头。仅用于验证。

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-backend-config
  namespace: demo-space
data:
  nginx-config: |
    worker_processes  1;
    daemon off;
    pid nginx.pid;

    events {
        worker_connections  1024;
    }

    http {
        access_log  /dev/stdout;
        error_log   /dev/stdout  info;

        server {
            listen 80;
            listen [::]:80;

            location / {
              content_by_lua_block {
                ngx.say("backend reached")
                ngx.say("x-auth-user=" .. (ngx.var.http_x_auth_user or ""))
                ngx.say("x-auth-body-bytes=" .. (ngx.var.http_x_auth_body_bytes or ""))
                ngx.say("x-auth-extra=" .. (ngx.var.http_x_auth_extra or ""))
              }
            }
        }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-backend
  namespace: demo-space
spec:
  replicas: 1
  selector:
    matchLabels:
      app: app-backend
  template:
    metadata:
      labels:
        app: app-backend
    spec:
      containers:
        - name: nginx
          image: registry.alauda.cn:60070/acp/alb2:v4.3.5
          command:
            - /usr/local/openresty/nginx/sbin/nginx
            - -c
            - /etc/nginx/nginx.conf
          ports:
            - name: http
              containerPort: 80
          volumeMounts:
            - name: nginx-config
              mountPath: /etc/nginx
      volumes:
        - name: nginx-config
          configMap:
            name: app-backend-config
            items:
              - key: nginx-config
                path: nginx.conf
---
apiVersion: v1
kind: Service
metadata:
  name: app-backend
  namespace: demo-space
spec:
  selector:
    app: app-backend
  ports:
    - name: http
      port: 80
      targetPort: 80
```

## 第 2 章. 创建网关、伴随的 EnvoyProxy 和基础 HTTPRoute

创建一个使用 `EnvoyGatewayCtl` 生成的 `GatewayClass` 的 `Gateway`，创建一个伴随的 `EnvoyProxy`，并为应用后端创建一个 `HTTPRoute`。

推荐的 ACP 部署模式是一个 `Gateway` 和一个专用的伴随 `EnvoyProxy`。`Gateway` 通过 `.spec.infrastructure.parametersRef` 引用 `EnvoyProxy`。`EnvoyProxy` 控制底层 Envoy 数据平面配置，例如服务类型、副本、资源和调度。

当通过 ACP Web 控制台从 `EnvoyGatewayCtl` 创建的 `GatewayClass` 创建 Gateway 时，控制台会自动创建一个同名同空间的伴随 `EnvoyProxy`。直接应用 YAML 时，请保持 `.spec.infrastructure.parametersRef` 和引用的 `EnvoyProxy` 资源一致。

下面的示例使用 `ClusterIP` 作为 Envoy 数据平面服务。对于生产外部暴露，当集群具有 LoadBalancer 提供者（如 MetalLB）时，将 `EnvoyProxy.spec.provider.kubernetes.envoyService.type` 更改为 `LoadBalancer`。

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: external-auth-gateway
  namespace: demo-space
spec:
  infrastructure:
    parametersRef:
      group: gateway.envoyproxy.io
      kind: EnvoyProxy
      name: external-auth-gateway
  gatewayClassName: demo-space-external-auth
  listeners:
    - name: http
      protocol: HTTP
      port: 7100
      allowedRoutes:
        namespaces:
          from: Same
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: external-auth-gateway
  namespace: demo-space
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: ClusterIP
      envoyDeployment:
        replicas: 1
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app-route
  namespace: demo-space
spec:
  parentRefs:
    - name: external-auth-gateway
      sectionName: http
  rules:
    - backendRefs:
        - name: app-backend
          port: 80
```

获取网关地址：

```bash
export GW_IP="$(
  kubectl get gateway external-auth-gateway \
    -n demo-space \
    -o jsonpath='{.status.addresses[0].value}'
)"
```

如果网关状态不包含地址，请从为网关创建的 Envoy Gateway 数据平面服务中获取地址。

## 第 3 章. 配置基本的 HTTP 外部授权

### 目的

当每个请求必须在到达应用后端之前由外部授权服务检查时，使用此场景。当授权服务返回 2xx 状态码时，Envoy 将请求转发到后端。

### 配置要点

- 将 `SecurityPolicy` 附加到需要授权的 `HTTPRoute`。
- 使用 `extAuth.http.backendRefs` 指向授权服务。
- 使用 `extAuth.http.path` 设置授权端点路径。
- 使用 `extAuth.http.headersToBackend` 将选定的响应头从授权服务转发到应用后端。

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/allow
      headersToBackend:
        - x-auth-user
        - x-auth-body-bytes
        - x-auth-extra
```

### 验证

通过网关发送请求：

```bash
curl -s -w '\n%{http_code}\n' \
  -H 'content-type: application/json' \
  --data '{"action":"allow"}' \
  "http://${GW_IP}:7100/allow"
```

预期输出：

```text
backend reached
x-auth-user=mock-user
x-auth-body-bytes=18
x-auth-extra=
200
```

## 第 4 章. 将请求体发送到授权服务

### 目的

当授权服务必须检查请求体时，例如 JSON 字段、表单值或上传内容，使用此场景。

### 配置要点

将 `extAuth.bodyToExtAuth.maxRequestBytes` 设置为 Envoy 应该缓冲并发送到授权服务的最大体积。如果请求体大于此限制，Envoy 将返回 `413` 并且不调用授权服务。

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/allow
      headersToBackend:
        - x-auth-user
        - x-auth-body-bytes
    bodyToExtAuth:
      maxRequestBytes: 1024
```

### 验证

发送一个小的请求体：

```bash
curl -s -w '\n%{http_code}\n' \
  -H 'content-type: application/json' \
  --data '{"action":"allow"}' \
  "http://${GW_IP}:7100/body"
```

预期输出：

```text
backend reached
x-auth-user=mock-user
x-auth-body-bytes=18
200
```

发送一个大于 `maxRequestBytes` 的请求体：

```bash
python3 -c 'print("x" * 2048)' | curl -s -w '\n%{http_code}\n' \
  -H 'content-type: text/plain' \
  --data-binary @- \
  "http://${GW_IP}:7100/oversize"
```

预期输出：

```text
Payload Too Large
413
```

此 `413` 行为优先于 `failOpen`。

## 第 5 章. 在外部授权之前注入动态头

### 目的

当授权服务需要来自 Envoy 的信息，例如下游远程地址，而该信息在原始请求头中不可用时，使用此场景。

### 配置要点

使用 `ClientTrafficPolicy.spec.headers.earlyRequestHeaders.set` 在网关监听器处注入请求头。值可以使用 Envoy 命令操作符，例如 `%DOWNSTREAM_REMOTE_ADDRESS%`。要将注入的头传递给授权服务，请在 `SecurityPolicy.spec.extAuth.headersToExtAuth` 中列出该头。

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: ext-auth-extra-header
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: external-auth-gateway
    sectionName: http
  headers:
    earlyRequestHeaders:
      set:
        - name: x-ext-auth-extra
          value: "%DOWNSTREAM_REMOTE_ADDRESS%"
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    headersToExtAuth:
      - x-ext-auth-extra
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/allow
      headersToBackend:
        - x-auth-user
        - x-auth-body-bytes
        - x-auth-extra
```

### 验证

```bash
curl -s -w '\n%{http_code}\n' \
  -H 'content-type: application/json' \
  --data '{"action":"allow"}' \
  "http://${GW_IP}:7100/extra"
```

预期输出包含渲染的下游地址，而不是字面命令操作符：

```text
backend reached
x-auth-user=mock-user
x-auth-body-bytes=18
x-auth-extra=10.3.1.17:59296
200
```

## 第 6 章. 将显式请求头传递给授权服务

### 目的

当授权服务需要选定的请求头，例如用户身份、租户身份、请求 ID 或代理链信息时，使用此场景。

### 配置要点

HTTP 外部授权不提供通配符设置以转发所有请求头。将每个所需头列在 `SecurityPolicy.spec.extAuth.headersToExtAuth` 中。

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    headersToExtAuth:
      - x-ext-auth-extra
      - x-request-id
      - x-forwarded-for
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/allow
      headersToBackend:
        - x-auth-extra
```

本指南中的模拟服务器仅回显 `x-ext-auth-extra`。如果需要验证其他头，请在模拟服务器中添加更多回显逻辑。

## 第 7 章. 拒绝请求

### 目的

当授权服务拒绝请求时，使用此场景。Envoy 应该在网关处停止请求，并且不应将其转发到应用后端。

### 配置要点

授权服务通过返回非 2xx 状态码来拒绝请求。下面的示例使用 `/auth/deny`，返回 `403`。

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/deny
```

### 验证

```bash
curl -s -w '\n%{http_code}\n' \
  -H 'content-type: application/json' \
  --data '{"action":"deny"}' \
  "http://${GW_IP}:7100/deny"
```

预期输出：

```text
deny
403
```

## 第 8 章. 使用 `failOpen` 配置失败行为

### 目的

使用此场景定义当授权服务不可用、超时或返回意外错误时 Envoy 应该做什么。

对于安全优先的部署，保持默认的 fail-closed 行为。仅在应用可以安全地接受流量而授权服务不可用时使用 fail-open 行为。

### 配置要点

Istio 的 `failure_mode_allow` 行为映射到 Envoy Gateway 中的 `SecurityPolicy.spec.extAuth.failOpen`。

当 `failOpen` 为 `false` 或省略时，授权后端不可用将返回 5xx 响应：

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    failOpen: false
    http:
      backendRefs:
        - name: mock-auth-missing
          port: 80
      path: /auth/allow
```

预期结果：

```text
500
```

当 `failOpen` 为 `true` 时，Envoy 会绕过授权失败并将请求转发到后端：

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    failOpen: true
    http:
      backendRefs:
        - name: mock-auth-missing
          port: 80
      path: /auth/allow
      headersToBackend:
        - x-auth-user
```

预期结果：

```text
backend reached
x-auth-user=
200
```

## 第 9 章. 配置外部授权后端健康检查

### 目的

使用此场景让 Envoy 主动检查外部授权后端的健康状况。这有助于 Envoy 检测授权后端故障并应用配置的 `failOpen` 行为。

### 配置要点

在 `SecurityPolicy.spec.extAuth.http.backendSettings.healthCheck` 下配置健康检查。不要在应用后端的 `BackendTrafficPolicy` 上配置此健康检查。

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    failOpen: false
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/allow
      backendSettings:
        healthCheck:
          active:
            type: HTTP
            interval: 1s
            timeout: 1s
            healthyThreshold: 1
            unhealthyThreshold: 1
            http:
              path: /healthz
              expectedStatuses:
                - 200
      headersToBackend:
        - x-auth-user
        - x-auth-body-bytes
```

模拟服务器在 `/healthz` 上返回 `200`。如果健康检查返回非 200 状态或授权服务不可达，请求处理将遵循配置的 `failOpen` 值。

## 第 10 章. 跳过 gRPC 或 WebSocket 流量的授权

### 目的

当同一网关承载正常的 HTTP 流量和特定协议的流量（如 gRPC 或 WebSocket），但仅正常的 HTTP 流量应使用 HTTP 外部授权时，使用此场景。

### 配置要点

`SecurityPolicy` 不提供单独的开关来跳过 gRPC 或 WebSocket 协议的外部授权。将流量拆分为单独的路由。仅将 `SecurityPolicy` 附加到需要外部授权的路由。

带有外部授权的示例 HTTP 路由：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app-http-route
  namespace: demo-space
spec:
  parentRefs:
    - name: external-auth-gateway
      sectionName: http
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /http
      backendRefs:
        - name: app-backend
          port: 80
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-http-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-http-route
  extAuth:
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/allow
```

没有外部授权的 WebSocket 路由示例：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app-websocket-route
  namespace: demo-space
spec:
  parentRefs:
    - name: external-auth-gateway
      sectionName: http
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /ws
      backendRefs:
        - name: websocket-backend
          port: 80
```

没有外部授权的 gRPC 路由示例：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: app-grpc-route
  namespace: demo-space
spec:
  parentRefs:
    - name: external-auth-gateway
      sectionName: http
  rules:
    - backendRefs:
        - name: grpc-backend
          port: 50051
```

通过这种布局，匹配 `SecurityPolicy` 的路由的请求将由授权服务检查。匹配 WebSocket 或 gRPC 路由的请求将绕过模拟授权服务器，直接到达其各自的后端服务。

## 字段参考

| 要求                                                   | Envoy Gateway 配置                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| HTTP 外部授权服务                                   | `SecurityPolicy.spec.extAuth.http.backendRefs`                        |
| 授权请求路径                                        | `SecurityPolicy.spec.extAuth.http.path`                               |
| 将请求体发送到授权服务                              | `SecurityPolicy.spec.extAuth.bodyToExtAuth.maxRequestBytes`           |
| 将授权响应头转发到后端                              | `SecurityPolicy.spec.extAuth.http.headersToBackend`                   |
| 将选定的请求头发送到授权服务                        | `SecurityPolicy.spec.extAuth.headersToExtAuth`                        |
| 注入 `%DOWNSTREAM_REMOTE_ADDRESS%` 或其他动态值    | `ClientTrafficPolicy.spec.headers.earlyRequestHeaders.set`            |
| Istio `failure_mode_allow` 等效                      | `SecurityPolicy.spec.extAuth.failOpen`                                |
| 外部授权后端健康检查                                | `SecurityPolicy.spec.extAuth.http.backendSettings.healthCheck`        |
| 跳过 gRPC 或 WebSocket 的外部授权                    | 拆分路由，仅将 `SecurityPolicy` 附加到需要授权的路由              |
