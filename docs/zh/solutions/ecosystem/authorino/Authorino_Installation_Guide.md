---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3'
id: KB260700062
sourceSHA: fd125eff503c59c1cbe324f7b67461768e518d0c47bc6d24d20700b728a2d0d8
---

# Authorino 安装指南

## 概述

Authorino 是一个 Kubernetes 原生的外部授权服务，最初由 Kuadrant 项目构建。它接入了 [Envoy 外部授权](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/ext_authz_filter) gRPC 协议，并允许您通过 `AuthConfig` 自定义资源声明身份验证和授权规则。本指南描述了如何从 ACP Marketplace 安装 Authorino Operator，创建 `Authorino` 实例，并通过 Envoy 验证端到端授权，提供 API 密钥示例。

### 支持的版本

| 组件                                   | 支持的版本     |
| -------------------------------------- | -------------- |
| Authorino Operator                     | 0.25.1        |
| Authorino (操作数)                    | 0.26.1        |
| Envoy (快速入门的数据平面)            | 1.31          |

## 先决条件

- 启用了 **OperatorHub** 功能的 ACP 集群。
- 您将部署 `Authorino` 实例和受保护工作负载的目标命名空间。
- 业务集群节点可以访问平台镜像注册表。
- （可选）从 **App Store > App Onboarding** 下载的 `violet` CLI，并与目标平台版本匹配。仅在 Authorino Operator 插件包尚未上传到目标平台时需要。

## 安装 Authorino Operator

1. 从 [Alauda Cloud Console](https://cloud.alauda.io/) Marketplace 下载 **Authorino Operator** 插件。

2. 如果插件包尚未上传到目标平台，请按照 [Upload Packages](https://docs.alauda.io/container_platform/4.2/extend/upload_package.html) 指南将其上传到集群，或直接使用 `violet` 推送：

   ```bash
   violet push \
     --platform-address <platform-address> \
     --clusters <business-cluster-name> \
     --platform-username <platform-admin-username> \
     --platform-password <platform-admin-password> \
     <authorino-operator-plugin-package>.tgz
   ```

3. 以管理员身份登录平台。导航到 **Administrator > Marketplace > OperatorHub**。

4. 找到 **Authorino Operator** 并点击 **Install**。选择目标命名空间，接受默认设置，然后再次点击 **Install**。平台会创建一个 `Subscription` 并批准 `InstallPlan`。

5. 等待操作员 `ClusterServiceVersion` 达到 `Succeeded` 阶段。

### 验证操作员

```bash
# CSV 应处于 Succeeded 阶段
kubectl -n <operator-namespace> get csv | grep authorino

# 操作员 Deployment 应为可用
kubectl -n <operator-namespace> get deploy -l app=authorino-operator
```

预期结果：

- `authorino-operator.v0.25.1` CSV 处于 `Succeeded` 阶段。
- `authorino-operator` Deployment 为 `1/1` 就绪。

## 快速入门：使用 API 密钥身份验证保护 API

本节演示一个完整的自包含示例：Authorino 实例通过 Envoy 授权流量到一个示例上游服务。带有有效 API 密钥的请求被允许（HTTP 200），而没有密钥（或使用无效密钥）的请求被拒绝（HTTP 401）。

设置以下命令中使用的变量：

```bash
export NAMESPACE=authorino-demo
export CR=authorino-sample
export HOST=talker-api.authorino-demo
export API_KEY=admin123456
kubectl create namespace ${NAMESPACE}
```

### 1. 创建 Authorino 实例

```yaml
apiVersion: operator.authorino.kuadrant.io/v1beta1
kind: Authorino
metadata:
  name: authorino-sample
  namespace: authorino-demo
spec:
  clusterWide: false
  replicas: 1
  listener:
    tls:
      enabled: false
  oidcServer:
    tls:
      enabled: false
```

应用清单并等待实例变为就绪：

```bash
kubectl apply -f authorino.yaml
kubectl -n ${NAMESPACE} wait authorino/${CR} --for=condition=Ready --timeout=300s
kubectl -n ${NAMESPACE} rollout status deploy/${CR}
```

预期结果：

- `Authorino` 资源报告 `status.conditions[Ready] = True`。
- `${CR}` 操作数 Deployment 可用。
- 名为 `${CR}-authorino-authorization` 的服务存在，并暴露 `50051/TCP`（gRPC 外部授权）和 `5001/TCP`（OIDC / Festival-Wristband 服务器）。

> \[!NOTE]
> Authorino 的外部授权接口仅在端口 50051 上支持 **gRPC**。端口 5001 是 OIDC/Festival-Wristband HTTP 服务器，对于普通 HTTP 授权探测将返回 404。验证授权决策时，请始终通过 Envoy（或其他 `ext_authz` 客户端）进行。

### 2. 创建 API 密钥 Secret 和 AuthConfig

Secret 存储 API 密钥。Authorino 监视带有 `authorino.kuadrant.io/managed-by=authorino` 标签的 Secrets，`AuthConfig` 通过标签匹配器选择它们。

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: api-key-1
  namespace: authorino-demo
  labels:
    app: talker-api
    authorino.kuadrant.io/managed-by: authorino
stringData:
  api_key: admin123456
type: Opaque
---
apiVersion: authorino.kuadrant.io/v1beta3
kind: AuthConfig
metadata:
  name: talker-api-protection
  namespace: authorino-demo
spec:
  hosts:
    - talker-api.authorino-demo
  authentication:
    api-key-users:
      apiKey:
        selector:
          matchLabels:
            app: talker-api
      credentials:
        authorizationHeader:
          prefix: APIKEY
```

应用并确认 AuthConfig 为 `Ready`：

```bash
kubectl apply -f authconfig.yaml
kubectl -n ${NAMESPACE} get authconfig talker-api-protection \
  -o jsonpath='{.status.summary}{"\n"}'
```

预期结果：`numHostsReady` 为 `1/1`，`ready` 为 `true`。

### 3. 部署示例上游和 Envoy 数据平面

Envoy 是必需的，因为 Authorino 仅支持 gRPC。以下 Envoy 配置在端口 8000 上设置 HTTP 监听器，通过 `ext_authz` 过滤器调用 Authorino，并将允许的流量路由到一个小型回声上游。

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: upstream
  namespace: authorino-demo
spec:
  replicas: 1
  selector: {matchLabels: {app: upstream}}
  template:
    metadata: {labels: {app: upstream}}
    spec:
      containers:
        - name: echo
          image: python:3.12-alpine
          command:
            - python3
            - -c
            - |
              from http.server import BaseHTTPRequestHandler, HTTPServer
              class H(BaseHTTPRequestHandler):
                  def do_GET(s):
                      s.send_response(200); s.end_headers(); s.wfile.write(b'ok')
              HTTPServer(('', 8080), H).serve_forever()
          ports: [{containerPort: 8080}]
---
apiVersion: v1
kind: Service
metadata: {name: upstream, namespace: authorino-demo}
spec:
  selector: {app: upstream}
  ports: [{port: 8080, targetPort: 8080}]
---
apiVersion: v1
kind: ConfigMap
metadata: {name: envoy-config, namespace: authorino-demo}
data:
  envoy.yaml: |
    static_resources:
      listeners:
        - name: ingress
          address: {socket_address: {address: 0.0.0.0, port_value: 8000}}
          filter_chains:
            - filters:
                - name: envoy.filters.network.http_connection_manager
                  typed_config:
                    "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                    stat_prefix: ingress
                    route_config:
                      name: r
                      virtual_hosts:
                        - name: vh
                          domains: ["*"]
                          routes:
                            - match: {prefix: "/"}
                              route: {cluster: upstream}
                    http_filters:
                      - name: envoy.filters.http.ext_authz
                        typed_config:
                          "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz
                          transport_api_version: V3
                          failure_mode_allow: false
                          grpc_service:
                            timeout: 2s
                            envoy_grpc: {cluster_name: authorino}
                      - name: envoy.filters.http.router
                        typed_config:
                          "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
      clusters:
        - name: upstream
          connect_timeout: 2s
          type: STRICT_DNS
          load_assignment:
            cluster_name: upstream
            endpoints:
              - lb_endpoints:
                  - endpoint: {address: {socket_address: {address: upstream.authorino-demo.svc, port_value: 8080}}}
        - name: authorino
          connect_timeout: 2s
          type: STRICT_DNS
          typed_extension_protocol_options:
            envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
              "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
              explicit_http_config:
                http2_protocol_options: {}
          load_assignment:
            cluster_name: authorino
            endpoints:
              - lb_endpoints:
                  - endpoint: {address: {socket_address: {address: authorino-sample-authorino-authorization.authorino-demo.svc, port_value: 50051}}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: envoy, namespace: authorino-demo}
spec:
  replicas: 1
  selector: {matchLabels: {app: envoy}}
  template:
    metadata: {labels: {app: envoy}}
    spec:
      containers:
        - name: envoy
          image: envoyproxy/envoy:v1.31-latest
          args: ["-c", "/etc/envoy/envoy.yaml", "-l", "info"]
          ports: [{containerPort: 8000}]
          volumeMounts: [{name: cfg, mountPath: /etc/envoy}]
      volumes: [{name: cfg, configMap: {name: envoy-config}}]
---
apiVersion: v1
kind: Service
metadata: {name: envoy, namespace: authorino-demo}
spec:
  selector: {app: envoy}
  ports: [{port: 8000, targetPort: 8000}]
```

> \[!IMPORTANT]
> Envoy 配置中的 `authorino` 集群必须通过 `typed_extension_protocol_options` 启用 HTTP/2。Authorino 的 `ext_authz` 端点是 gRPC，要求使用 HTTP/2。

应用并等待：

```bash
kubectl apply -f dataplane.yaml
kubectl -n ${NAMESPACE} rollout status deploy/upstream
kubectl -n ${NAMESPACE} rollout status deploy/envoy
```

### 4. 验证授权决策

在集群中运行一个 curl pod，并测试四种情况：

```bash
kubectl -n ${NAMESPACE} run probe --rm -it --restart=Never \
  --image=curlimages/curl:latest -- sh
```

在 probe 容器内：

```sh
HOST=talker-api.authorino-demo
KEY=admin123456
SVC=envoy.authorino-demo.svc:8000

# 1) 无凭证 -> 401
curl -sS -o /dev/null -w 'no-key:     %{http_code}\n'  -H "Host: $HOST" http://$SVC/

# 2) 错误凭证 -> 401
curl -sS -o /dev/null -w 'wrong-key:  %{http_code}\n'  -H "Host: $HOST" -H "Authorization: APIKEY wrong" http://$SVC/

# 3) 有效凭证 -> 200
curl -sS -o /dev/null -w 'valid-key:  %{http_code}\n'  -H "Host: $HOST" -H "Authorization: APIKEY $KEY" http://$SVC/

# 4) 没有匹配 AuthConfig 的主机 -> 404
curl -sS -o /dev/null -w 'wrong-host: %{http_code}\n'  -H "Host: not-protected.example.com" http://$SVC/
```

预期输出：

```text
no-key:     401
wrong-key:  401
valid-key:  200
wrong-host: 404
```

### 5. 检查授权决策

```bash
# Envoy 侧（返回 401 的跳转）
kubectl -n ${NAMESPACE} logs deploy/envoy --tail=30

# Authorino 侧（匹配的 AuthConfig，允许或拒绝的评估器）
kubectl -n ${NAMESPACE} logs deploy/${CR} --tail=30
```

上述四种情况的典型 Authorino 日志行：

| 情况             | 日志签名                                      |
| ---------------- | --------------------------------------------- |
| 有效凭证        | `authorized=true reason=apiKey "api-key-users"` |
| 错误凭证        | `reason=the API key provided was not found`   |
| 无凭证          | `reason=credential not found in the request`  |
| 错误主机        | `status=404 message=service not found`        |

## 添加更多身份验证方法

Authorino 支持在同一 `AuthConfig` 中声明多种身份验证类型。通过扩展 `spec.authentication` 添加 JWT 身份：

```yaml
spec:
  authentication:
    api-key-users:
      apiKey:
        selector:
          matchLabels:
            app: talker-api
      credentials:
        authorizationHeader:
          prefix: APIKEY
    jwt-users:
      jwt:
        issuerUrl: https://my-issuer.example.com/realms/talker
```

支持的身份类型的完整列表记录在上游 [AuthConfig 参考](https://docs.kuadrant.io/latest/authorino/docs/features/#identity-verification--authentication-authentication) 中。

## 清理

对于测试部署，删除上述创建的资源：

```bash
kubectl delete namespace ${NAMESPACE}
```

要删除操作员，请从 **Administrator > Marketplace > OperatorHub > Installed** 删除其 `Subscription` 和 `ClusterServiceVersion`，或：

```bash
kubectl -n <operator-namespace> delete subscription authorino-operator
kubectl -n <operator-namespace> delete csv authorino-operator.v0.25.1
```

## 常见问题

### 为什么我需要在 Authorino 前面使用 Envoy？

Authorino 实现了 [Envoy `ext_authz` gRPC 协议](https://www.envoyproxy.io/docs/envoy/latest/api-v3/service/auth/v3/external_auth.proto)。它不暴露普通的 HTTP 授权端点，因此必须通过 HTTP/2 在端口 50051 上调用 Authorino。直接向 Authorino 服务发送普通 HTTP 请求将不会返回授权决策。

### 为什么 Authorino 服务的端口 5001 对我的请求返回 404？

`<instance>-authorino-authorization` 上的端口 5001 是 OIDC / Festival-Wristband HTTP 服务器。它不是授权端点，对于任意路径将返回 404。请通过快速入门中的端口 8000 通过 Envoy 发送授权探测，而不是直接发送到 Authorino。

### Authorino 没有看到我的 API 密钥 Secret。缺少什么？

Authorino 仅监视带有 `authorino.kuadrant.io/managed-by=authorino` 标签的 Secrets。然后，`AuthConfig` 通过 `apiKey.selector.matchLabels` 缩小选择范围（例如 `app: talker-api`）。即使匹配 `apiKey.selector`，没有 `managed-by` 标签的 Secret 也会被忽略。

### Host 头似乎没有生效

`AuthConfig.spec.hosts` 与请求的 `Host` 头（或 HTTP/2 的 `:authority` 伪头）进行匹配。一些客户端会用套接字地址覆盖 `Host`。使用 `curl -H "Host: <value>"`，或显式设置 `--resolve`，并通过 `kubectl logs deploy/envoy` 确认。

### 我可以在哪里了解更多？

- 上游文档：[docs.kuadrant.io/latest/authorino](https://docs.kuadrant.io/latest/authorino/)
- AuthConfig 字段参考：[docs.kuadrant.io/latest/authorino/docs/features](https://docs.kuadrant.io/latest/authorino/docs/features/)
