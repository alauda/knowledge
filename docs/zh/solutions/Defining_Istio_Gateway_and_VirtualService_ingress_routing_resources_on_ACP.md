---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500350
sourceSHA: 89b6f1a7a9e84329bdab84b8760f828c80dc7b6709f786fc53951a5af06ff196
---

# 在 ACP 上定义 Istio Gateway 和 VirtualService 入口路由资源

## 问题

在 Alauda 容器平台 (Kubernetes 服务器 v1.34.5) 上，存在 `networking.istio.io` 自定义资源定义，平台操作员在准备入口路由配置时需要 Istio `Gateway`、Istio `VirtualService` 的标准资源形状，以及与代理注入相关的声明性命名空间标记标签。该标签是一个普通的命名空间标记：侧车注入仅在网格控制平面及其注入器运行以对其进行操作的地方发生，因此单独应用该标签既不会创建也不会注入任何内容。本文描述了被编写和应用的资源清单——每个 `networking.istio.io` 对象的字段结构以及通用的 Kubernetes 命名空间标签——以便在将清单提交到集群之前能够正确准备。

## 解决方案

工作负载命名空间携带声明性标记标签 `istio-injection=enabled`。该标签是命名空间的 `metadata.labels` 映射下的自由格式键，这是通用的 Kubernetes `map[string]string` 字段，接受任意键/值对；因此，应用该标签是一个标准的命名空间标记操作。该标签仅是一个声明性标记——它仅在存在网格控制平面及其运行的注入器以消费它时生效，从而产生侧车注入；在没有实例化网格注入器的集群上应用该标签本身并不会注入或创建任何内容：

```bash
kubectl label namespace <workload-namespace> istio-injection=enabled
```

Istio `Gateway` 资源描述了入口网关配置接受流量的主机和端口。该 CRD 在组/版本 `networking.istio.io/v1` 下提供（同时也提供 `v1alpha3` 和 `v1beta1`）。其 `spec` 包含一个 `selector` 字段——一个标识入口网关工作负载的 Pod 标签选择器——以及一个 `servers` 列表，其中每个条目将端口定义与在该端口上提供的主机集合配对：

```yaml
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: app-gateway
  namespace: <workload-namespace>
spec:
  selector:
    istio: ingressgateway
  servers:
    - port:
        number: 80
        name: http
        protocol: HTTP
      hosts:
        - "app.example.com"
```

Istio `VirtualService` 资源描述了通过命名网关到达的入站流量如何路由到后端应用服务。该 CRD 同样在 `networking.istio.io/v1` 下提供（同时也提供 `v1alpha3` 和 `v1beta1`）。其 `spec` 包含一个 `gateways` 列表，命名了路由适用的 `Gateway` 资源，一个目标主机的 `hosts` 列表，以及一个有序的 HTTP 路由规则的 `http` 列表，这些规则将匹配的请求引导到后端服务：

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: app-routes
  namespace: <workload-namespace>
spec:
  hosts:
    - "app.example.com"
  gateways:
    - app-gateway
  http:
    - route:
        - destination:
            host: app-service
            port:
              number: 8080
```

`Gateway.spec.selector` 值和 `VirtualService.spec.gateways` 引用是将路由配置结合在一起的两个链接：网关的选择器指向入口网关 Pods，而虚拟服务命名了其 HTTP 规则所管理的入站流量的网关。

## 诊断步骤

入口网关 Pod 通过标签选择器 `istio=ingressgateway` 进行识别，这是网关工作负载的通用上游标签选择器形式。使用该选择器列出 Pods 可以确认在给定命名空间中是否存在网关工作负载：

```bash
kubectl get pods -n <workload-namespace> -l istio=ingressgateway
```

当在查询的命名空间中没有部署网关工作负载时，该命令返回 `No resources found`；该结果是选择器在入口网关 Pods 缺失时的预期输出，并确认选择器本身在集群中是良好构造的。
