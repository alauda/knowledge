---
products:
  - Alauda Service Mesh
kind:
  - Solution
id: KB250500014
sourceSHA: e2b9c7e6b0ae79c543ee63c1fc8462dc39404b5a73f13a743cf2a9a21950c57e
---

# 将 Alauda Service Mesh 集成到标准 Kubernetes

## 概述

Alauda Service Mesh (ASM) 扩展了 Istio 的功能，提供了增强的管理特性，同时保持与 Istio 生态系统的兼容性。本文档提供了将标准 Kubernetes 应用迁移到 Alauda Service Mesh 的全面指南，重点介绍操作工作流、配置差异和技术实现。

### 理解服务网格概念

#### 服务网格架构

服务网格是一个专用的基础设施层，用于控制微服务架构中服务之间的通信。它提供流量管理、安全性和可观察性等功能，而无需对应用程序代码进行更改。

#### Sidecar 代理模式

Sidecar 模式在每个应用程序容器旁边部署一个代理容器。该代理拦截所有进出应用程序的网络流量，从而实现高级流量管理、安全策略和遥测收集。

### Istio 和 Alauda Service Mesh 之间的差异

关键差异总结如下：

| **方面**                             | **原生 Istio**                               | **Alauda Service Mesh (ASM)**                     |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------------- |
| 命名空间级别的 sidecar 注入         | `istio-injection` 或 `istio.io/rev` 标签    | `istio.io/rev` + `cpaas.io/serviceMesh` 标签    |
| Pod 级别的 sidecar 注入             | Pods/Deployments 上的标签                    | 自定义 `MicroService` 资源                        |
| 服务全局速率限制                     | `ConfigMap` 和 `EnvoyFilter`                 | 自定义 `GlobalRateLimiter` 资源                   |
| 服务 API 级别流量监控               | `WasmPlugin` 和 `Telemetry`                  | 自定义 `ApiAttribute` 资源                        |

#### Sidecar 注入

Alauda Service Mesh 的可观察性基于 MicroService 自定义资源。如果您希望具备此能力，请使用 Alauda Service Mesh 配置来注入 sidecar。

##### 原生 Istio 配置

Istio 的原生 sidecar 注入涉及两个级别的配置：

1. **命名空间级别配置**
   - **选项 1**：将标签 `istio-injection=enabled` 添加到命名空间（传统方法）
   - **选项 2**：使用 `istio.io/rev=<revision>` 选择特定的 Istio 控制平面修订版（现代方法）

2. **Pod 级别配置**
   - 在部署的 Pod 模板中添加注释 `sidecar.istio.io/inject=true`

##### Alauda Service Mesh 配置

ASM 保留了 Istio 的核心原则，但引入了额外的标签和自定义资源以增强控制：

1. **命名空间级别配置**
   - 与 Istio 一样使用 `istio.io/rev=<revision>`
   - 将标签 `cpaas.io/serviceMesh=enabled` 添加到命名空间

2. **Pod 级别配置**

- 定义一个 `MicroService` 自定义资源以自动化 sidecar 注入
- 示例配置：

```yaml
apiVersion: asm.alauda.io/v1beta3
kind: MicroService
metadata:
  labels:
    app.cpaas.io/microservice-type: service-mesh
  name: <microservice-name> # 必须与 K8S 服务同名
  namespace: <service-namespace>
spec:
  accessLogging:
    enabled: false
  deployments:
    - name: <deployment-name>
  otelJavaAgent:
    enabled: false
  services:
    - name: <service-name>
  sidecar:
    enabled: true
    envoyLogLevel: warning
    resources:
      limits:
        cpu: 500m
        memory: 512Mi
      requests:
        cpu: 100m
        memory: 128Mi
```

- 标签和注释将自动添加到 Deployment 和 Service

```yaml
deployment label
asm.cpaas.io/msname: <microservice-name>
pod annotation
kubectl.kubernetes.io/restartedAt: 2025-05-21T02:54:29.851209145Z
pod label
app: <microservice-name>
asm.cpaas.io/msname: <microservice-name>
service label
asm.cpaas.io/msname: <microservice-name>
```

#### 服务全局速率限制

##### 原生 Istio 配置

原生 Istio 使用 `ConfigMap` 和 `EnvoyFilter` 配置服务全局速率限制，需要额外部署 <https://github.com/envoyproxy/ratelimit> 作为全局速率限制服务器。

##### Alauda Service Mesh 配置

ASM 使用 `GlobalRateLimiter` 自定义资源配置服务全局速率限制，配置简单且更易于用户友好的速率限制指标集成到 ASM 监控中。

#### 服务 API 级别流量监控

##### 原生 Istio 配置

原生 Istio 使用 `WasmPlugin` 和 `Telemetry` 配置服务 API 级别流量监控。

##### Alauda Service Mesh 配置

ASM 使用 `ApiAttribute` 自定义资源配置服务 API 级别流量监控（集成到 ASM 监控中），配置简单且性能优于原生 Istio。

## 先决条件

在迁移到 Alauda Service Mesh 之前，请确保您具备：

1. Alauda 容器平台环境和账户
2. 在 Alauda 容器平台中已创建项目和命名空间，并具备必要的权限
3. 标准 Kubernetes 应用清单（Deployments、Services、ServiceAccounts）
4. 已安装 [Kubectl CLI](https://kubectl.docs.kubernetes.io/installation/kubectl/)
5. 已安装 `kubectl acp plugin` 以进行集群身份验证

## 迁移过程概述

从标准 Kubernetes 部署迁移到 Alauda Service Mesh 涉及几个关键步骤：

1. **环境设置和验证**
2. **准备现有 Kubernetes 资源**
3. **与服务网格集成**（sidecar 注入）
4. **实现服务网格特性**（流量路由、弹性、可观察性）
5. **测试和验证**

## 第 1 章：标准 Kubernetes 应用示例

在迁移到 ASM 之前，让我们了解典型 Kubernetes 应用的结构。这将作为我们迁移过程的起点。

### 标准 Kubernetes 资源

典型的 Kubernetes 微服务由以下资源组成：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: <service-name>
  namespace: <service-namespace>
  labels:
    service: <service-name>
spec:
  ports:
  - port: 8080
    name: http-8080
    protocol: TCP
    appProtocol: http
  selector:
    service: <service-name>
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <deployment-name>
  namespace: <deployment-namespace>
  labels:
    service: <service-name>
spec:
  replicas: 2
  selector:
    matchLabels:
      service: <service-name>
  template:
    metadata:
      labels:
        service: <service-name>
    spec:
      containers:
      - name: <container-name>
        image: <registry-address>/<service-name>:<tag>
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: <container-port>
```

**关键组件：**

- **Service**：在 <container-port> 端口上公开应用程序，并选择带有标签 `service: <service-name>` 的 Pods
- **Deployment**：管理应用程序 Pods，指定容器镜像、端口和标签

## 第 2 章：服务网格集成过程

本章详细介绍将标准 Kubernetes 应用与 Alauda Service Mesh 集成的逐步过程。

### 第 1 步：在命名空间中启用网格

**注意**：如果您没有权限更新命名空间，请联系管理员。

要将您的应用与 ASM 集成，首先将必要的标签添加到您的命名空间：

```shell
kubectl label namespace <namespace> cpaas.io/serviceMesh=enabled istio.io/rev=1-22
```

验证命名空间标签：

```shell
kubectl get ns <namespace> -o yaml
```

输出应包含：

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: <namespace>
  labels:
    # 现有标签
    cpaas.io/serviceMesh: enabled
    istio.io/rev: 1-22
```

**标签说明：**

- `cpaas.io/serviceMesh: enabled`：指示该命名空间应由 Alauda Service Mesh 管理
- `istio.io/rev: 1-22`：指定要使用的 Istio 控制平面修订版（本示例中为 1.22）

### 第 2 步：创建 MicroService 资源

为了管理应用程序的网格集成，而不是手动将 sidecar 注入到 Pods 中，请创建 ASM MicroService 资源。

**注意：**

- `MicroService` 资源必须与 K8S 服务同名；否则，将影响微服务的可观察性特性。
- `MicroService` 支持 `Deployment` 和 `Service` 之间的一对一关系。如果一个 `Deployment` 对应多个 `Services`，则需要选择一个 `Service` 作为 `MicroService`。
- Istio 可以自动检测 HTTP 和 HTTP/2 流量。如果协议无法自动确定，流量将被视为普通 TCP 流量。[可以手动指定协议](https://istio.io/v1.22/docs/ops/configuration/traffic-management/protocol-selection/#explicit-protocol-selection) 在服务定义中。这可以通过两种方式配置：
  - 在 Kubernetes 1.18+ 中，通过 appProtocol 字段：`appProtocol: <protocol>`。
  - 通过端口名称：`name: <protocol>[-<suffix>]`。
- 如果 `Deployment` 中的 `spec.template.metadata.labels` 包含 `app` 或 `app.kubernetes.io/name` 标签，并且名称与 `MicroService` 名称不同，则需要将 `service.istio.io/canonical-name: <microservice-name>` 标签添加到 `spec.template.metadata.labels` 中，以便微服务的可观察性特性。

```yaml
apiVersion: asm.alauda.io/v1beta3
kind: MicroService
metadata:
  labels:
    app.cpaas.io/microservice-type: service-mesh
  name: <microservice-name-same-as-service-name>
  namespace: <service-namespace>
spec:
  deployments:
  - name: <deployment-name>
  services:
  - name: <service-name>
  sidecar:
    enabled: true
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
    envoyLogLevel: warning
  accessLogging:
    enabled: false
  otelJavaAgent:
    enabled: false
```

应用此配置：

```shell
kubectl apply -f microservice.yaml
```

**MicroService 字段说明：**

- `spec.deployments`：列出要由服务网格管理的部署
- `spec.services`：列出与部署相关的服务
- `spec.sidecar`：配置 Envoy sidecar 代理
  - `enabled`：启用 sidecar 注入
  - `resources`：设置 sidecar 的资源限制
  - `envoyLogLevel`：设置 Envoy 代理的日志级别
- `spec.accessLogging`：启用服务的访问日志
- `spec.otelJavaAgent`：配置 OpenTelemetry Java 代理集成（在本示例中禁用）。启用时，它将自动注入 OpenTelemetry Java 代理，用于可观察性，能够查看 Java 服务 JVM 监控和内部跨度。

此配置将：

- 将您的部署和服务注册到服务网格
- 配置 Envoy sidecar 代理注入
- 设置 sidecar 代理的资源限制

## 第 3 章：实现服务网格特性

将应用程序迁移到服务网格后，您可以实现各种服务网格特性，以增强应用程序的能力。

### 流量路由

`VirtualService` 定义了一组流量路由规则，以便在访问主机时应用。每个路由规则定义了特定协议流量的匹配标准。如果流量匹配，则将其发送到指定的目标服务。

对于 `HTTPRoute`，它支持基于 `uri`、`method`、`headers`、`queryParams`、`port` 等进行匹配。除了路由外，它还支持 `redirect`、`rewrite`、`timeout`、`retries`、`fault`、`mirror` 等操作。

#### 网关路由

在管理员部署了入口网关并创建了 `Istio Gateway` 资源后，开发人员可以创建 `VirtualService` 来配置网关路由。

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: httpbin-route # 虚拟服务名称
  namespace: <service-namespace>
spec:
  hosts:
  - "httpbin.example.com" # 您的域名，用于访问您的服务
  gateways:
  - <gateway-ns>/<gateway-name> # Istio Gateway 资源的命名空间和名称
  http:
  - match:
    - uri:
        exact: /headers
    - uri:
        prefix: /status/
    route:
    - destination:
        host: httpbin.<service-namespace>.svc.cluster.local # 服务全名
        port:
          number: 80 # 服务端口
```

应用此配置：

```shell
kubectl apply -f virtualservice.yaml
```

然后，您可以通过入口网关访问您的服务：

```shell
# 如果您的网关是 http
curl http://httpbin.example.com/headers
# 如果您的网关是 https
curl https://httpbin.example.com/headers
```

#### 服务路由

通过创建 VirtualService 控制服务之间的流量流动：

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: <virtualservice-name>
  namespace: <service-namespace>
spec:
  hosts:
  - <service-name> # 解释为 <service-name>.<service-namespace>.svc.cluster.local
  http:
  - route:
    - weight: 90
      destination:
        host: <service-name>
    - weight: 10
      destination:
        host: <another-service-name>
```

应用此配置：

```shell
kubectl apply -f virtualservice.yaml
```

**VirtualService 字段说明：**

- `spec.hosts`：指定流量路由的主机
- `spec.http`：定义 HTTP 路由规则
  - `route`：指定目标及其权重
    - `weight`：路由到每个目标的流量百分比
    - `destination.host`：流量的目标服务

此配置将 90% 的流量路由到 `<service-name>`，10% 的流量路由到 `<another-service-name>`。

#### 重试

Istio 的重试机制允许您自动重试对服务的失败 HTTP 请求。这可以通过在不涉及客户端的情况下尝试从瞬时故障中恢复来提高应用程序的可靠性。

您可以通过在 VirtualService 中指定重试尝试次数、每次尝试的超时以及触发重试的条件来配置重试。以下是一个示例：

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: <virtualservice-name>
  namespace: <service-namespace>
spec:
  hosts:
    - <service-name> # 解释为 <service-name>.<service-namespace>.svc.cluster.local
  http:
    - retries:
        attempts: 3
        perTryTimeout: 3s
        retryOn: connect-failure,refused-stream,unavailable,cancelled,5xx
      route:
        - destination:
            host: <service-name>
          weight: 100
```

有关支持的重试条件的完整列表，请参阅 [Envoy 文档](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/router_filter#config-http-filters-router-x-envoy-retry-on)。

**注意**：如果在服务网格部署期间配置了全局 HTTP 重试策略（默认重试条件为：`connect-failure, refused-stream, unavailable, cancelled, 503`），则为特定服务指定的任何重试策略将覆盖全局策略。这允许对每个服务的重试行为进行精细控制。

### 流量策略

`DestinationRule` 定义了在路由发生后适用于目标服务的流量策略。这些规则指定了负载均衡、来自 sidecar 的连接池大小和异常检测设置，以检测和驱逐不健康的主机。

**注意**：同一主机只能有一个顶级 trafficPolicy。

#### 负载均衡

适用于特定目标的负载均衡策略。支持的策略包括 `LEAST_REQUEST`（默认）、`ROUND_ROBIN`、`RANDOM`、`PASSTHROUGH`。

例如，以下规则对所有流向 `<service-name>` 服务的流量使用轮询负载均衡策略。

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: <destinationrule-name>
  namespace: <service-namespace>
spec:
  host: <service-name>.<service-namespace>.svc.cluster.local
  trafficPolicy:
    loadBalancer:
      simple: ROUND_ROBIN
```

#### 断路器

断路器实现跟踪上游服务中每个主机的状态。适用于 HTTP 和 TCP 服务。对于 HTTP 服务，持续返回 5xx 错误的主机会在预定义的时间段内被驱逐出池。对于 TCP 服务，连接超时或连接失败到给定主机的情况在计算连续错误指标时计为错误。

**注意**：如果配置了全局断路器，则单个服务的断路器配置将覆盖全局配置。

使用 Istio 的原生 DestinationRule 应用断路器模式：

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: <destinationrule-name>
  namespace: <service-namespace>
spec:
  host: <service-name>.<service-namespace>.svc.cluster.local
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 100
        maxRequestsPerConnection: 10
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 10s
      baseEjectionTime: 600s
      maxEjectionPercent: 100
```

应用此配置：

```shell
kubectl apply -f destinationrule.yaml
```

**DestinationRule 字段说明：**

- `spec.host`：此规则适用的服务
- `spec.trafficPolicy`：定义流量管理策略
  - `connectionPool`：配置连接池
    - `tcp.maxConnections`：最大 TCP 连接数
    - `http.http1MaxPendingRequests`：最大待处理 HTTP 请求数
    - `http.maxRequestsPerConnection`：每个连接的最大请求数
  - `outlierDetection`：配置断路器
    - `consecutive5xxErrors`：在驱逐主机之前的 5xx 错误数量
    - `interval`：驱逐分析之间的时间
    - `baseEjectionTime`：最小驱逐持续时间
    - `maxEjectionPercent`：可以驱逐的主机最大百分比

此配置实现了断路器，以保护您的服务免受级联故障的影响。

#### 使用 DestinationRule 进行预热

Istio 的预热功能允许新创建的 Pods 在接收全部流量之前逐渐增加流量，帮助它们稳定运行。此功能特别适合需要冷启动预热的服务（例如 JVM 应用）。它可以减少由于在扩展或部署新版本应用程序时流量激增而导致的服务中断、请求延迟或甚至超时的风险，有效提高应用程序在扩展和版本更新期间的稳定性和高可用性。

##### 功能概述

Istio 的预热功能是基于 Envoy 提供的慢启动模式实现的。

慢启动模式是 Envoy 中的一个配置设置，用于逐步增加新添加的上游端点的流量。未启用慢启动时，Envoy 将向新上游端点发送相应的流量。这对于需要预热时间以承载完整生产负载的服务可能是不可取的，可能导致请求超时、数据丢失和用户体验下降。

##### 使用限制

- Istio 版本 >= v1.14
  - 版本 v1.24 引入了更全面的预热配置参数（`minimumPercent` 和 `aggression`）
- 仅支持 `ROUND_ROBIN` 和 `LEAST_REQUEST` 负载均衡策略
- 不适用于新部署场景
- 对应用程序副本数量的要求：
  - 对于扩展场景：至少需要一个应用程序副本
  - 对于滚动更新场景：至少需要两个应用程序副本

##### 最佳实践

1. **适用场景**

   预热在 Kubernetes 中出现少量新端点（如扩展事件）时最有效。当所有端点相对较新（如新部署）时，这并不是很有效，因为所有端点最终会获得相同数量的请求。

   在 Deployment 滚动更新场景中，避免使用默认的滚动更新策略，因为所有 Pods 将在同一时刻推出，这使得负载权重非常不准确。建议将 `maxSurge` 设置为适当的百分比（例如 34%），并将 `maxUnavailable` 设置为 0，以实现渐进式更新。

2. **合理配置预热**

   Istio v1.24 中的预热配置参数：

   - `duration`：预热持续时间，应根据应用程序的特性进行设置。建议通过性能测试确定最佳值。
   - `minimumPercent`：新端点的最小初始流量百分比，默认值为 10%
   - `aggression`：预热期间流量增加的系数，默认值为 1.0（线性增长）

   v1.24 之前的版本仅支持配置 `warmupDurationSecs` 参数，其他参数使用默认值。

3. **监控和验证**

   配置预热策略后，持续监控关键指标，如 QPS、p99 延迟和错误率。如果结果未达到预期，逐步调整预热参数并重复验证过程。

##### 示例配置

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: <destinationrule-name>
  namespace: <service-namespace>
spec:
  host: <service-name>
  trafficPolicy:
    loadBalancer:
      simple: LEAST_REQUEST
      warmupDurationSecs: 300
```

应用此配置：

```shell
kubectl apply -f destinationrule.yaml
```

#### 速率限制

**注意**：请确认管理员是否已启用速率限制功能（连接到 Redis）。

实施集群级别的速率限制，以保护您的服务免受过载：

```yaml
apiVersion: asm.alauda.io/v1alpha1
kind: GlobalRateLimiter
metadata:
  name: <microservice-name>
  namespace: <microservice-namespace>
  labels:
    app.cpaas.io/msname: <microservice-name>
spec:
  serviceType: micro-service
  failureModeDeny: false
  domain: <microservice-name>.<microservice-namespace>.<cluster-name>
  rules:
  # 全局策略（不配置或只能配置一个）
  - shadowMode: false
    rateLimit:
      fixedWindow:
        unit: <unit> # 选项：second, minute, hour, day
        requestsPerUnit: <requestsPerUnit>
    name: global_rate_limit # 固定名称
    descriptors:
    - kind: global_service
      match:
        method: eq
        value: <microservice-name>.<microservice-namespace>.<cluster-name>
  # 条件策略（可以配置多个）
  - shadowMode: false
    rateLimit:
      fixedWindow:
        unit: <unit> # 选项：second, minute, hour, day
        requestsPerUnit: <requestsPerUnit>
    name: <condition-rate-limit-name>
    descriptors:
    - kind: <kind> # 选项：request_url_path, request_method, request_header
      match:
        key: <key> # 仅在 kind 为 request_header 时需要
        method: <method> # 选项：eq, ne, regex
        value: <value>
    # 示例
    - kind: "request_method" # 请求方法
      match:
        method: "eq"
        value: "GET" # 大写
    - kind: "request_url_path" # 请求路径：精确匹配
      match:
        method: "eq"
        value: "/get"
    - kind: "request_url_path" # 请求路径：正则匹配
      match:
        method: "eq"
        value: "/status/[^/]+"
    - kind: "request_header" # 请求头：精确匹配
      match:
        key: "x-custom-for"
        method: "eq"
        value: "bar"
```

应用此配置：

```shell
kubectl apply -f ratelimiter.yaml
```

**GlobalRateLimiter 字段说明：**

- `spec.serviceType`：被速率限制的服务类型
- `spec.failureModeDeny`：当速率限制器失败时是否拒绝请求
- `spec.domain`：速率限制器的域
- `spec.rules`：速率限制规则
  - `shadowMode`：是否仅记录速率限制违规而不强制执行
  - `rateLimit.fixedWindow`：固定窗口速率限制配置
    - `unit`：速率限制窗口的时间单位（second, minute, hour, day）
    - `requestsPerUnit`：每个单位允许的最大请求数
  - `descriptors`：速率限制的描述符

此配置将 `<microservice-name>` 的请求限制为每个 `<unit>` `<requestsPerUnit>` 次，并且还可以根据请求头、请求路径和请求方法限制请求。

### 安全性

Istio 提供了全面的安全模型，包括工作负载到工作负载的身份验证（通过双向 TLS）和细粒度的访问控制（通过授权策略）。在本节中，我们介绍如何配置 PeerAuthentication 以强制执行传入连接的双向 TLS，以及如何使用 AuthorizationPolicy 控制哪些客户端可以访问哪些工作负载。

#### Peer Authentication (mTLS)

`PeerAuthentication` 资源定义了传入流量对工作负载的双向 TLS (mTLS) 要求。当您启用 `PeerAuthentication` 时，Envoy sidecar 强制要求传入连接使用指定的 mTLS 模式。Istio 支持三种 mTLS 模式：

- **`STRICT`**：工作负载仅接受使用 mTLS 加密的连接。明文（非 mTLS）流量将被拒绝。
- **`PERMISSIVE`**：工作负载接受 mTLS 和明文流量。这在迁移期间很有用，当某些工作负载尚未升级以要求 mTLS 时。
- **`DISABLE`**：禁用 mTLS；工作负载仅接受明文流量。建议仅在您有外部安全解决方案时使用此模式。

Istio 按以下优先顺序应用 `PeerAuthentication` 策略：

1. **特定工作负载**（最狭义的范围；按标签选择 Pods）。
2. **命名空间范围**（适用于命名空间中的所有工作负载）。
3. **网格范围**（适用于整个集群）。

以下示例说明如何使用 `PeerAuthentication` 强制执行命名空间范围的 mTLS：

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: <namespace>
spec:
  mtls:
    mode: STRICT
```

应用此策略以确保任何未使用 mTLS 的客户端在尝试连接到命名空间 `<namespace>` 中的 sidecar 时将被拒绝。

#### 授权策略

`AuthorizationPolicy` 资源定义了工作负载的细粒度访问控制规则（允许、拒绝、审计）——控制哪些主体（服务账户）、命名空间、IP 块或请求属性（方法、路径、头、JWT 声明）可以访问特定工作负载或端口。

- **`action: ALLOW`**（默认）：仅允许匹配的请求；所有其他请求被拒绝。
- **`action: DENY`**：明确拒绝匹配的请求；其他请求被允许。
- **`action: AUDIT`**：将匹配的请求标记为审计（记录），但不拒绝。

策略由一组规则组成。每条规则可以包含：

- **`from.source`**：指定请求来源，例如 `principals`、`namespaces` 或 `ipBlocks`。
- **`to.operation`**：按 `methods`、`paths`、`ports` 或 `hosts` 过滤请求。
- **`when`**：对请求属性的条件，包括 JWT 声明或头。

以下示例仅允许服务账户 `cluster.local/ns/<another-service-namespace>/sa/<another-service-account>` **或** 命名空间 `<service-namespace>` 中的任何工作负载访问匹配 `<pod-label-key>: <pod-label-value>` 的服务 Pod：

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: <service-name-allow>
  namespace: <service-namespace>
spec:
  selector:
    matchLabels:
      <pod-label-key>: <pod-label-value>
  action: ALLOW
  rules:
  - from:
    - source:
        principals: ["cluster.local/ns/<another-service-namespace>/sa/<another-service-account>"]
    - source:
        namespaces: ["<service-namespace>"]
```

### API 定义

定义用于指标收集和监控的 API 端点：

```yaml
apiVersion: asm.alauda.io/v1alpha2
kind: ApiAttribute
metadata:
  labels:
    asm.cpaas.io/msname: <microservice-name>
    app.cpaas.io/microservice-type: service-mesh
  name: <microservice-name>
  namespace: <microservice-namespace>
spec:
  apis:
  - operationid: get-service-data
    path: "/api/v1/data/{id}" # 支持 Restful API
    method: GET
    port: <service-port>
  - operationid: create-service-data
    path: "/api/v1/data"
    method: POST
    port: <service-port>
```

应用此配置：

```shell
kubectl apply -f apiattribute.yaml
```

**ApiAttribute 字段说明：**

- `spec.apis`：API 端点列表
  - `operationid`：操作的唯一标识符
  - `path`：API 端点的 URL 路径
  - `method`：API 端点的 HTTP 方法
  - `port`：API 暴露的端口

此配置定义了用于指标收集和监控的 API 端点。

## 第 4 章：验证和测试

迁移到 ASM 后，验证您的设置以确保一切正常工作非常重要。

### 验证 sidecar 注入

检查 Envoy sidecar 代理是否已注入到您的 Pods 中：

```shell
kubectl get pods -n <namespace> -o jsonpath='{.items[*].spec.containers[*].name}' | grep istio-proxy
```

如果 sidecar 成功注入，您应该在输出中看到 `istio-proxy`。

### 检查代理配置

检查 Envoy 代理配置：

```shell
istioctl proxy-config all <pod-name> -n <namespace>
```

此命令显示 Envoy 代理的完整配置，包括监听器、路由、集群和端点。

### 测试服务连通性

验证您的服务是否可以相互通信：

```shell
kubectl exec -it <client-pod> -n <namespace> -- curl <service-name>:<port>/<api-path>
```

此命令测试从客户端 Pod 到您的服务的连通性。

### 验证流量管理

分析您的服务网格配置以查找潜在问题：

```shell
istioctl analyze -n <namespace>
```

此命令检查您的服务网格配置中的常见问题并提供建议。

### 监控流量流动

使用 Alauda Service Mesh 仪表板监控服务之间的流量流动。仪表板提供服务依赖关系、流量模式和性能指标的可视化。

Alauda Service Mesh 提供内置的端到端跟踪功能，帮助您可视化和诊断跨所有服务的请求流——即使流量跨越多个集群。

## 第 5 章：排除常见问题

### Sidecar 注入失败

如果 sidecar 注入不起作用：

1. 验证命名空间标签是否正确应用：
   ```shell
   kubectl get namespace <namespace> --show-labels
   ```

2. 检查 MicroService 资源状态：
   ```shell
   kubectl get microservice <microservice-name> -n <namespace> -o yaml
   ```

3. 在配置更改后重启 Pods 以触发注入：
   ```shell
   kubectl rollout restart deployment <deployment-name> -n <namespace>
   ```

### 服务连通性问题

如果服务无法通信：

1. 验证服务端口是否正确命名（例如，`http`、`grpc`）：
   ```shell
   kubectl get service <service-name> -n <namespace> -o yaml
   ```

2. 检查身份验证策略：
   ```shell
   kubectl get peerauthentication -n <namespace>
   kubectl get authorizationpolicy -n <namespace>
   ```

3. 确保 NetworkPolicies 允许流量：
   ```shell
   kubectl get networkpolicy -n <namespace>
   ```

### 流量路由问题

如果流量路由未按预期工作：

1. 验证 VirtualService 配置：
   ```shell
   kubectl get virtualservice <virtualservice-name> -n <namespace> -o yaml
   ```

2. 检查目标主机：
   ```shell
   kubectl get service -n <namespace>
   ```

3. 验证 DestinationRule 配置：
   ```shell
   kubectl get destinationrule <destinationrule-name> -n <namespace> -o yaml
   ```

## 最佳实践

1. **资源命名**：对所有资源使用一致的命名约定
2. **标签策略**：在所有资源中应用一致的标签，以便更好地管理
3. **资源限制**：为应用程序和 sidecar 容器配置适当的资源限制
4. **渐进迁移**：逐个迁移应用程序，在每一步进行彻底测试

## 结论

从 Istio 迁移到 Alauda Service Mesh 提供了几个优势：

1. **增强管理**：ASM 提供了更用户友好的管理界面和额外的自定义资源，以便于配置。
2. **简化的 Sidecar 注入**：MicroService 资源简化了 sidecar 注入和配置。
3. **高级流量管理**：ASM 扩展了 Istio 的流量管理能力，增加了额外的功能。
4. **改进的可观察性**：ASM 通过集成仪表板、指标和跟踪提供增强的可观察性。
5. **企业支持**：ASM 提供企业级支持，并与更广泛的 Alauda 容器平台集成。

通过遵循本指南，您可以成功将标准 Kubernetes 应用迁移到 Alauda Service Mesh，解锁流量管理、弹性和可观察性的高级功能，同时保持与更广泛的 Istio 生态系统的兼容性。

有关更详细的信息和高级配置，请参阅官方 Alauda Service Mesh 文档。
