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
sourceSHA: 43ee25c865e5e61315e7819ee56db24e08f1ac21048ff8744f3fe6d03d871c35
---

# 如何在 ACP 的 Envoy Gateway 中保留非默认后端端口的上游主机头

## 问题

一个 Envoy Gateway 路由将流量转发到一个监听非默认端口的 HTTPS 后端：

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
```

该路由还使用后端主机名重写，直接或通过 Envoy AI Gateway 生成的资源：

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: HTTPRouteFilter
metadata:
  name: rewrite-host-to-backend
  namespace: model-serving
spec:
  urlRewrite:
    hostname:
      type: Backend
```

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

此错误并不证明 Envoy 连接到了 TCP 端口 `443`。后端套接字端口和 HTTP 权限是独立的值。

## 适用的 Envoy Gateway 版本

本文档中的确切 `EnvoyPatchPolicy` 配置已在以下版本中验证：

```text
Envoy Gateway: v1.8.0
Envoy Proxy:   v1.38.0
```

`EnvoyPatchPolicy` 修改生成的 xDS 配置，并且是一个不稳定的高级 API。对于 Envoy Gateway v1.7.x、v1.9.x 或其他版本，请检查该版本生成的 RouteConfiguration，并在应用策略之前调整资源名称和路由索引。

## 根本原因

后端端点端口和上游 HTTP 权限是独立配置的：

| 值                           | 示例                      | 结果                                   |
| ----------------------------- | ------------------------ | -------------------------------------- |
| 后端套接字地址                | `model.example.com:7448` | Envoy 连接到端口 `7448`                |
| HTTP `Host` 或 `:authority`   | `model.example.com`      | 上游虚拟主机使用的                     |
| TLS SNI                       | `model.example.com`      | 仅包含主机名，从不包含端口             |

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

当上游必须精确接收以下内容时，请使用此变通方法：

```text
Host: model.example.com:7448
```

#### 1. 启用 EnvoyPatchPolicy

将以下字段合并到现有的 `EnvoyGatewayCtl` 中。不要替换其其他配置。

示例中的注释使用这些标签：

- `CHANGE`：替换目标环境的值。
- `KEEP`：字段和值保持不变。
- `MAY CHANGE`：保持字段名称，但根据生成的路由配置确定值。

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

#### 2. 确定要替换的值

PatchPolicy 目标是网关并修改生成的 Envoy RouteConfiguration。替换以下示例值：

| 示例值                          | 含义                                                                         | 操作         |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------ |
| `model-serving`                 | 网关命名空间                                                                 | `CHANGE`     |
| `model-gateway`                 | 网关名称                                                                      | `CHANGE`     |
| `http`                          | 网关监听器名称                                                                | `CHANGE`     |
| `model-serving/model-gateway/http` | RouteConfiguration 名称：`<gateway-namespace>/<gateway-name>/<listener-name>` | `CHANGE`     |
| 路径中的第一个 `0`              | 虚拟主机数组索引                                                              | `MAY CHANGE` |
| 路径中的第二个 `0`             | 包含受影响的 HTTPRoute 的路由数组索引                                        | `MAY CHANGE` |
| `model.example.com:7448`        | 后端所需的主机或权限                                                          | `CHANGE`     |

`targetRef` 必须保持为 `Gateway`。HTTPRoute 名称不会直接放置在 `targetRef` 中；它决定必须修补的生成路由索引。

如果网关包含一个虚拟主机和一个路由，索引通常为 `0` 和 `0`。对于具有多个路由的网关，使用 Envoy 配置转储定位包含 `auto_host_rewrite: true` 的路由，并使用其索引。

#### 3. 应用 PatchPolicy

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1 # KEEP
kind: EnvoyPatchPolicy # KEEP
metadata:
  name: upstream-authority-with-port # CHANGE: 任何有效的资源名称
  namespace: model-serving # CHANGE: 必须是网关命名空间
spec:
  targetRef:
    group: gateway.networking.k8s.io # KEEP
    kind: Gateway # KEEP
    name: model-gateway # CHANGE: 网关名称
  type: JSONPatch # KEEP
  jsonPatches:
    - type: type.googleapis.com/envoy.config.route.v3.RouteConfiguration # KEEP
      name: model-serving/model-gateway/http # CHANGE: namespace/Gateway/listener
      operation:
        op: remove # KEEP
        path: /virtual_hosts/0/routes/0/route/auto_host_rewrite # MAY CHANGE: 仅两个索引
    - type: type.googleapis.com/envoy.config.route.v3.RouteConfiguration # KEEP
      name: model-serving/model-gateway/http # CHANGE: 与上面相同的值
      operation:
        op: add # KEEP
        path: /virtual_hosts/0/routes/0/route/host_rewrite_literal # MAY CHANGE: 与上面相同的两个索引
        value: model.example.com:7448 # CHANGE: 所需的后端权限
```

两个补丁操作都是必需的：

- 第一个操作移除 `auto_host_rewrite`。
- 第二个操作添加 `host_rewrite_literal`，并包含所需的端口。

应用该策略：

```bash
kubectl apply -f upstream-authority-with-port.yaml
```

确认策略报告：

```text
Accepted=True
Programmed=True
```

## 验证

通过 Envoy Gateway 发送请求，并检查后端的原始 Host 头。后端必须接收：

```text
Host: model.example.com:7448
```

对于 NGINX 后端，记录 `$http_host` 而不是 `$host`，因为 `$http_host` 保留了包含端口的原始 Host 头。

验证环境返回：

```text
http_host="model.example.com:7448"
```

这确认了 PatchPolicy 将上游 Host 或权限更改为预期的主机名和端口。

## 回滚

仅删除 PatchPolicy：

```bash
kubectl delete envoypatchpolicy upstream-authority-with-port -n model-serving
```

Envoy Gateway 将以其原始 `auto_host_rewrite` 行为重新生成路由。网关、HTTPRoute、Backend 和 Envoy Gateway 实例无需删除。

## 限制

- 本文档中的确切补丁已针对 Envoy Gateway v1.8.0 进行了验证。
- 在添加、删除或重新排序 HTTPRoutes 或升级 Envoy Gateway 后，路由索引可能会更改。
- 在更改网关或路由资源后，请重新检查 `Accepted` 和 `Programmed`。
- 当该配置在您的控制之下时，优先选择与端口无关的上游虚拟主机匹配。

## 参考

- [ACP Envoy Gateway 操作员：通过 EnvoyGatewayCtl 进行高级配置](https://docs-dev.alauda.cn/container_platform/main/networking/operators/envoy_gateway_operator#envoygatewayctl)
- [Envoy Gateway v1.8：Envoy Patch Policy](https://gateway.envoyproxy.io/v1.8/tasks/extensibility/envoy-patch-policy/)
- [Envoy 问题 #26022：auto_host_rewrite 端口号丢失](https://github.com/envoyproxy/envoy/issues/26022)
- [Envoy Gateway 问题 #8823：支持 auto_host_rewrite 中的端口](https://github.com/envoyproxy/gateway/issues/8823)
- [Envoy AI Gateway 问题 #2500：生成的后端主机重写丢失非默认端口](https://github.com/envoyproxy/ai-gateway/issues/2500)
