---
kind:
  - Solution
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x and later
tags:
  - LB
id: KB260800008
sourceSHA: 54b7461c203030bb9e6e8b45261581feb002f4d82c474c1227cf0d12ee9ae55d
---

# 如何在 ACP 上使用 Envoy Gateway 保留非默认后端端口的上游主机头

## 问题

以下 `HTTPRoute` 将流量转发到一个监听非默认端口的 HTTPS 后端：

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: external-model
  namespace: model-serving
spec:
  type: Endpoints
  endpoints:
    - fqdn:
        hostname: model.example.com
        port: 7448
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: HTTPRouteFilter
metadata:
  name: rewrite-host-to-backend
  namespace: model-serving
spec:
  urlRewrite:
    hostname:
      type: Backend
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: model-route
  namespace: model-serving
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: model-gateway
      sectionName: http
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /v1
        - path:
            type: PathPrefix
            value: /openai
      filters:
        - type: ExtensionRef
          extensionRef:
            group: gateway.envoyproxy.io
            kind: HTTPRouteFilter
            name: rewrite-host-to-backend
      backendRefs:
        - group: gateway.envoyproxy.io
          kind: Backend
          name: external-model
```

本文档后面的补丁针对 `model-serving/model-route` HTTPRoute 的规则索引 `0`，并修改该规则生成的每个匹配项。它不会修改其他规则或其他 HTTPRoute。相同的方法适用于由 Envoy AI Gateway 生成的 HTTPRoute；在选择器中使用生成的 HTTPRoute 命名空间和名称。

Envoy 连接到后端端口 `7448`，但上游 HTTP `Host` 头或 HTTP/2 `:authority` 仅包含主机名：

```text
model.example.com
```

如果上游虚拟主机需要非默认端口，它期望：

```text
model.example.com:7448
```

上游可能会因以下错误拒绝请求：

```text
403 Host forbidden model.example.com:443
```

此错误并不能证明 Envoy 连接到了 TCP 端口 `443`。后端套接字端口和 HTTP 权限是独立的值。

## 适用的 Envoy Gateway 版本

本文档中的确切 `EnvoyPatchPolicy` 配置已在以下版本中验证：

```text
Envoy Gateway: v1.8.0
Envoy Proxy:   v1.38.0
```

`EnvoyPatchPolicy.operation.jsonPath` 从 Envoy Gateway v1.2.0 开始支持。本文档使用 `jsonPath` 通过名称选择生成的 Envoy 路由，而不是依赖于 `virtual_hosts` 或 `routes` 数组索引。

`EnvoyPatchPolicy` 修改生成的 xDS 配置，并且是一个不稳定的高级 API。对于 Envoy Gateway v1.7.x、v1.9.x 或其他版本，请检查该版本生成的 RouteConfiguration，并在应用策略之前调整资源名称和路由名称选择器。

## 根本原因

后端端点端口和上游 HTTP 权限是独立配置的：

| 值                         | 示例                      | 结果                                   |
| --------------------------- | ------------------------ | -------------------------------------- |
| 后端套接字地址              | `model.example.com:7448` | Envoy 连接到端口 `7448`                |
| HTTP `Host` 或 `:authority` | `model.example.com`      | 上游虚拟主机使用的                     |
| TLS SNI                     | `model.example.com`      | 仅包含主机名，从不包含端口             |

带有 `hostname.type: Backend` 的 `HTTPRouteFilter` 被转换为：

```yaml
auto_host_rewrite: true
```

Envoy 使用端点主机名进行自动主机重写，但不附加端点端口。因此，严格的上游虚拟主机不会在权限中接收到 `:7448`。

## 解决方案

### 选项 1：使上游主机匹配与端口无关

如果可以更改上游网关，请将其配置为在虚拟主机匹配时忽略端口或接受两个权限：

```text
model.example.com
model.example.com:7448
```

这是首选的长期解决方案，因为它不依赖于生成的 xDS 结构。

### 选项 2：使用 EnvoyPatchPolicy

当上游必须确切接收以下内容时，请使用此变通方法：

```text
Host: model.example.com:7448
```

#### 前提条件：启用 EnvoyPatchPolicy

将以下字段合并到现有的 `EnvoyGatewayCtl` 中。不要替换其其他配置。

示例中的注释使用以下标签：

- `CHANGE`：替换目标环境的值。
- `KEEP`：保持字段和值不变。
- `MAY CHANGE`：保持字段名称，但从生成的路由配置中确定值。

```yaml
apiVersion: envoy-gateway.alauda.io/v1 # KEEP
kind: EnvoyGatewayCtl # KEEP
metadata:
  name: model-gateway-instance # CHANGE: EnvoyGatewayCtl 名称
  namespace: envoy-gateway-system # CHANGE: EnvoyGatewayCtl 命名空间
spec:
  config:
    envoyGateway:
      extensionApis:
        enableBackend: true # KEEP 当使用后端资源时
        enableEnvoyPatchPolicy: true # KEEP
```

不要直接编辑由 `EnvoyGatewayCtl` 生成的 ConfigMap 或 Deployment。

#### 步骤 1：查找 HTTPRoute 使用的监听器

从网关和 HTTPRoute 资源的命名空间和名称开始：

| 变量                       | 来源                              |
| -------------------------- | --------------------------------- |
| `VAR_$GATEWAY_NAMESPACE`   | 父网关的命名空间                  |
| `VAR_$GATEWAY_NAME`        | 父网关的名称                      |
| `VAR_$HTTPROUTE_NAMESPACE` | `HTTPRoute.metadata.namespace`     |
| `VAR_$HTTPROUTE_NAME`      | `HTTPRoute.metadata.name`          |

替换 HTTPRoute 占位符并检查完整资源，包括其状态：

```bash
kubectl get httproute VAR_$HTTPROUTE_NAME \
  -n VAR_$HTTPROUTE_NAMESPACE \
  -o yaml
```

在 `spec.parentRefs` 中，找到 `name` 和 `namespace` 与 `VAR_$GATEWAY_NAME` 和 `VAR_$GATEWAY_NAMESPACE` 匹配的条目。如果省略了 `namespace`，则默认为 HTTPRoute 命名空间。匹配条目的 `sectionName` 是 `VAR_$LISTENER_NAME`：

```yaml
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: model-gateway
      sectionName: http
```

接下来，在 `status.parents` 中找到相应的条目，并确认其 `Accepted` 条件为 `True`。状态中的 `parentRef.sectionName` 应该标识相同的监听器：

```yaml
status:
  parents:
    - parentRef:
        group: gateway.networking.k8s.io
        kind: Gateway
        name: model-gateway
        namespace: model-serving
        sectionName: http
      conditions:
        - type: Accepted
          status: "True"
```

在此示例中，`VAR_$LISTENER_NAME` 为 `http`。匹配的 `parentRef` 必须包含 `sectionName`，因为该字段标识 HTTPRoute 使用的确切网关监听器。如果缺失，请停止并在创建 PatchPolicy 之前明确进行监听器附加。不要猜测监听器。

对于此验证配置使用的 xDS 命名方案，构造 RouteConfiguration 资源名称为：

```text
VAR_$GATEWAY_NAMESPACE/VAR_$GATEWAY_NAME/VAR_$LISTENER_NAME
```

对于示例资源，结果为：

```text
model-serving/model-gateway/http
```

#### 步骤 2：创建 EnvoyPatchPolicy

将一个 HTTPRoute 中的一个规则视为确切的补丁目标。除了步骤 1 中的四个资源输入外，从 `HTTPRoute.spec.rules` 中选择零基 `VAR_$RULE_INDEX`，并将 `VAR_$UPSTREAM_AUTHORITY` 设置为所需的上游 `host:port`。

补丁策略示例包含以 `VAR_$` 开头的文档占位符。它们不是 shell 变量，Kubernetes 不会替换它们。在应用文件之前替换每个占位符：

| 占位符                     | 替换为                                                        |
| -------------------------- | ------------------------------------------------------------- |
| `VAR_$GATEWAY_NAMESPACE`   | 提供的网关命名空间                                            |
| `VAR_$GATEWAY_NAME`        | 提供的网关名称                                               |
| `VAR_$LISTENER_NAME`       | 步骤 1 返回的监听器名称                                      |
| `VAR_$HTTPROUTE_NAMESPACE` | 提供的 HTTPRoute 命名空间                                    |
| `VAR_$HTTPROUTE_NAME`      | 提供的 HTTPRoute 名称                                        |
| `VAR_$RULE_INDEX`          | 从 `HTTPRoute.spec.rules` 选择的规则索引                     |
| `VAR_$UPSTREAM_AUTHORITY`  | 所需的上游权限，例如 `model.example.com:7448`                |

在应用文件之前，此命令必须不打印任何输出：

```bash
grep -n 'VAR_\$' upstream-authority-with-port.yaml
```

`EnvoyPatchPolicy.targetRef` 将策略附加到网关。然后，`jsonPath` 表达式选择属于指定 HTTPRoute 规则的每个生成的 Envoy 路由。

示例中的规则索引 `0` 有两个匹配项，因此生成的路由名称类似于：

```yaml
name: httproute/model-serving/model-route/rule/0/match/0/*
route:
  auto_host_rewrite: true
---
name: httproute/model-serving/model-route/rule/0/match/1/*
route:
  auto_host_rewrite: true
```

生成的路由名称模式为：

```text
httproute/VAR_$HTTPROUTE_NAMESPACE/VAR_$HTTPROUTE_NAME/rule/VAR_$RULE_INDEX/match/VAR_$MATCH_INDEX/VAR_$HOSTNAME
```

每个组件的含义为：

| Envoy 路由名称组件         | 来源                                                |
| -------------------------- | --------------------------------------------------- |
| `httproute`                | 资源类型                                           |
| `VAR_$HTTPROUTE_NAMESPACE` | HTTPRoute 命名空间                                 |
| `VAR_$HTTPROUTE_NAME`      | HTTPRoute 名称                                    |
| `rule/VAR_$RULE_INDEX`     | 要补丁的确切 HTTPRoute 规则                       |
| `match/VAR_$MATCH_INDEX`   | 从该规则生成的一个匹配项                          |
| `VAR_$HOSTNAME`            | 由生成的 Envoy 路由表示的主机名                   |

使用此选择器来针对指定规则生成的所有匹配项：

```text
$.virtual_hosts[*].routes[?match(@.name, '^httproute/VAR_$HTTPROUTE_NAMESPACE/VAR_$HTTPROUTE_NAME/rule/VAR_$RULE_INDEX/match/[0-9]+/.*$')]
```

JSONPath 语法的评估如下：

| 语法                                   | 意义                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `$`                                    | 从 Envoy RouteConfiguration JSON 文档的根开始                                           |
| `.virtual_hosts`                       | 读取 `virtual_hosts` 数组                                                                  |
| `[*]`                                  | 搜索每个虚拟主机，因为目标路由可以出现在其中任何一个虚拟主机中                          |
| `.routes`                              | 读取每个虚拟主机中的 Envoy 路由                                                          |
| `[? ... ]`                             | 仅保留过滤表达式为真的数组条目                                                          |
| `@`                                    | 当前正在评估的 Envoy 路由                                                                |
| `@.name`                               | 当前 Envoy 路由的生成名称                                                                |
| `match(@.name, '...')`                 | 当其名称与正则表达式匹配时保留该路由                                                    |
| `^httproute/.../rule/VAR_$RULE_INDEX/` | 将匹配锚定到确切的 HTTPRoute 和规则                                                      |
| `match/[0-9]+/`                        | 匹配该规则中的每个数字匹配索引，例如 `match/0` 和 `match/1`                             |
| `.*$`                                  | 匹配任何生成的主机名后缀，并要求匹配到达路由名称的末尾                                   |

`^` 和 `$` 锚点很重要：它们共同防止部分名称匹配选择其他 HTTPRoute 或规则。添加或重新排序其他 HTTPRoutes 不会更改选择。重新排序目标 HTTPRoute 中的规则会更改 `VAR_$RULE_INDEX`，并需要更新策略。

由于策略附加到网关，`EnvoyPatchPolicy.metadata.namespace` 必须使用 `VAR_$GATEWAY_NAMESPACE`，即使 HTTPRoute 在另一个命名空间中。

在替换每个 `VAR_$...` 占位符后，从此模板创建 `upstream-authority-with-port.yaml`：

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1 # KEEP
kind: EnvoyPatchPolicy # KEEP
metadata:
  name: upstream-authority-with-port # CHANGE: 任何有效的资源名称
  namespace: VAR_$GATEWAY_NAMESPACE
spec:
  targetRef:
    group: gateway.networking.k8s.io # KEEP
    kind: Gateway # KEEP
    name: VAR_$GATEWAY_NAME
  type: JSONPatch # KEEP
  jsonPatches:
    - type: type.googleapis.com/envoy.config.route.v3.RouteConfiguration # KEEP
      name: VAR_$GATEWAY_NAMESPACE/VAR_$GATEWAY_NAME/VAR_$LISTENER_NAME
      operation:
        op: remove # KEEP
        jsonPath: >-
          $.virtual_hosts[*].routes[?match(@.name, '^httproute/VAR_$HTTPROUTE_NAMESPACE/VAR_$HTTPROUTE_NAME/rule/VAR_$RULE_INDEX/match/[0-9]+/.*$')].route.auto_host_rewrite
    - type: type.googleapis.com/envoy.config.route.v3.RouteConfiguration # KEEP
      name: VAR_$GATEWAY_NAMESPACE/VAR_$GATEWAY_NAME/VAR_$LISTENER_NAME
      operation:
        op: add # KEEP
        jsonPath: >-
          $.virtual_hosts[*].routes[?match(@.name, '^httproute/VAR_$HTTPROUTE_NAMESPACE/VAR_$HTTPROUTE_NAME/rule/VAR_$RULE_INDEX/match/[0-9]+/.*$')]
        path: route/host_rewrite_literal # KEEP
        value: VAR_$UPSTREAM_AUTHORITY
```

##### 替换占位符后的完整示例

例如，假设目标值为：

| 值                                 | 示例                           |
| ----------------------------------- | ------------------------------- |
| 网关                               | `model-serving/model-gateway`   |
| HTTPRoute                           | `model-serving/model-route`     |
| 步骤 1 返回的监听器                | `http`                          |
| HTTPRoute 规则索引                 | `0`                             |
| 所需的上游 Host 或权限             | `model.example.com:7448`        |

完成的 PatchPolicy 为：

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyPatchPolicy
metadata:
  name: upstream-authority-with-port
  namespace: model-serving
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: model-gateway
  type: JSONPatch
  jsonPatches:
    - type: type.googleapis.com/envoy.config.route.v3.RouteConfiguration
      name: model-serving/model-gateway/http
      operation:
        op: remove
        jsonPath: >-
          $.virtual_hosts[*].routes[?match(@.name, '^httproute/model-serving/model-route/rule/0/match/[0-9]+/.*$')].route.auto_host_rewrite
    - type: type.googleapis.com/envoy.config.route.v3.RouteConfiguration
      name: model-serving/model-gateway/http
      operation:
        op: add
        jsonPath: >-
          $.virtual_hosts[*].routes[?match(@.name, '^httproute/model-serving/model-route/rule/0/match/[0-9]+/.*$')]
        path: route/host_rewrite_literal
        value: model.example.com:7448
```

此策略附加到 `model-serving/model-gateway`，修改 `model-serving/model-route` 的规则 `0` 下的每个生成匹配路由，并保持其他 HTTPRoutes 和其他规则不变。

两个补丁操作都是必需的：

- 第一个操作选择目标规则生成的每个 Envoy 路由上的 `auto_host_rewrite` 并将其移除。
- 第二个操作选择那些相同的 Envoy 路由对象，并添加所需端口的 `host_rewrite_literal`。由于新字段尚不存在，`jsonPath` 选择路由对象，`path` 确定要添加的字段。

应用策略：

```bash
kubectl apply -f upstream-authority-with-port.yaml
```

确认策略报告：

```text
Accepted=True
Programmed=True
```

## 验证

通过 Envoy Gateway 发送请求并检查后端的原始 Host 头。后端必须接收：

```text
Host: model.example.com:7448
```

对于 NGINX 后端，记录 `$http_host` 而不是 `$host`，因为 `$http_host` 保留了包括端口在内的原始 Host 头。

验证环境返回：

```text
http_host="model.example.com:7448"
```

这确认了 PatchPolicy 将上游 Host 或权限更改为预期的主机名和端口。

## 回滚

仅删除 PatchPolicy：

```bash
kubectl delete envoypatchpolicy upstream-authority-with-port -n VAR_$GATEWAY_NAMESPACE
```

Envoy Gateway 将使用其原始的 `auto_host_rewrite` 行为重新生成路由。网关、HTTPRoute、后端和 Envoy Gateway 实例无需删除。

## 限制

- 本文档中的确切补丁已针对 Envoy Gateway v1.8.0 进行了验证。
- 从 Envoy Gateway v1.2.0 开始支持 `jsonPath`。
- 添加或重新排序其他 HTTPRoutes 不会影响路由名称选择器。重新排序目标 HTTPRoute 中的规则需要更新 `VAR_$RULE_INDEX`；重新排序匹配项不需要更新，因为选择器匹配所有数字匹配索引。
- Envoy Gateway 升级可能会更改 RouteConfiguration 或生成的路由命名。升级后请重新检查资源名称和路由名称选择器。
- 在更改网关或路由资源后，请重新检查 `Accepted` 和 `Programmed`。
- 当该配置在您的控制之下时，优先选择与端口无关的上游虚拟主机匹配。

## 参考

- [ACP Envoy Gateway Operator: 通过 EnvoyGatewayCtl 进行高级配置](https://docs-dev.alauda.cn/container_platform/main/networking/operators/envoy_gateway_operator#envoygatewayctl)
- [Envoy Gateway v1.8: Envoy 补丁策略](https://gateway.envoyproxy.io/v1.8/tasks/extensibility/envoy-patch-policy/)
- [Envoy Gateway PR #3757: 支持 EnvoyPatchPolicy 中的 JSONPath](https://github.com/envoyproxy/gateway/pull/3757)
- [Envoy issue #26022: auto_host_rewrite 端口号丢失](https://github.com/envoyproxy/envoy/issues/26022)
- [Envoy Gateway issue #8823: 支持 auto_host_rewrite 中的端口](https://github.com/envoyproxy/gateway/issues/8823)
- [Envoy AI Gateway issue #2500: 生成的后端主机重写丢失非默认端口](https://github.com/envoyproxy/ai-gateway/issues/2500)
