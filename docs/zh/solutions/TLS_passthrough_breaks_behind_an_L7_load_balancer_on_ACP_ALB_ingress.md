---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500308
sourceSHA: 10b11eca9f8a23cf81fc2cbec72436a823af0ca879d7503e6f39e54baab6b198
---

# 在 ACP ALB 入口后，TLS passthrough 失效

## 问题

在 Alauda 容器平台上，集群入口由 ALB (`alb2`) 提供服务；运行的数据平面是 `cpaas-system` 命名空间中的 `global-alb2` 实例，通过 `cpaas.io/alb2` 控制器的 `global-alb2` IngressClass 注册，当前的 Ingress 由该类前置。TLS-passthrough 配置将加密的 TLS 连接不加修改地转发到后端服务，而不是在入口处终止；在 ALB 上，这使用的是每个端口协议为 `tcp`（L4）而非 `https`（L7）的前端，因此连接在未解密的情况下通过。当一个外部的 HTTP/HTTPS 终止的第七层负载均衡器位于此入口前时，passthrough 停止工作，客户端请求无法到达预期的后端。

## 根本原因

ALB 上的 passthrough 前端不终止 TLS；ALB 前端协议决定了 L4 与 L7 的处理方式，在 `alb-nginx` 数据平面（镜像 `registry.alauda.cn:60080/acp/alb-nginx:v4.3.1`，一个 nginx/openresty 引擎）中，TCP 前端将 TLS 字节原封不动地传递。由于连接在入口处从未解密，后端是根据 ClientHello 中携带的 TLS 服务器名称指示（SNI）值进行选择，而不是根据检查的 HTTP 头部。ALB 将后端选择绑定到请求的主机：路由规则（`rules.crd.alauda.io`）根据 `spec.domain`（主机名）进行匹配，匹配的证书与该主机名相关联，因此主机/SNI 值决定了后端及其 TLS 材料。

一个在 HTTP/HTTPS 模式下运行的外部第七层负载均衡器在负载均衡器本身终止传入的 TLS 连接；ALB 在其 L7 形式中表现出相同的行为，其中一个前端使用 `protocol=https` 和绑定的 `certificate_name` 在前端终止 TLS。当前置的 L7 负载均衡器终止 TLS 然后重新加密或将请求作为新连接转发时，原始客户端 SNI 在流量到达入口之前丢失或被更改。由于入口依赖 SNI 来选择 passthrough 后端，丢失或更改的 SNI 使请求无法匹配，客户端请求失败。

## 解决方案

通过确保在入口前没有任何东西解密连接来保持 TLS passthrough 的端到端。将 ALB 入口前端配置为 TCP/L4 模式，以便它不加修改地转发加密连接并通过 SNI 选择后端；前端每个端口的协议是决定 L4 与 L7 处理的关键，只有 L4/`tcp` 形式才能保留 passthrough。放置在集群入口前的任何外部负载均衡器也必须在第 4 层 / TCP 上运行，以便 TLS 连接和客户端 SNI 完整地到达 ALB；一个在第 7 层终止并重新加密的前置负载均衡器会剥离入口所需的 SNI，从而破坏 passthrough。

控制这一点的 ALB 前端协议在每个端口上都是可观察的——例如，正在运行的 `global-alb2` 将 `global-alb2-00080` 显示为 `http`，将 `global-alb2-00443` 显示为 `https`；而 passthrough 端口则定义为 `protocol=tcp`，因此 TLS 被转发而不是终止。

当第七层前置和 TLS 终止是明确要求时，另一种选择是在 ALB 前端本身终止 TLS，而不是通过它：每个端口的前端协议在这里也是选择器——一个定义为 `protocol=https` 并绑定 `certificate_name` 的前端在入口处终止 TLS，而 `protocol=tcp` 前端则将其传递。ALB 还暴露了一个可配置的 SSL 策略字段（`alb2.spec.config.defaultSSLStrategy`），但决定终止与 passthrough 的仍然是每个端口的前端协议。在 L7 终止模式下，后端选择不再依赖完整的端到端 SNI，因为入口是 TLS 端点。

## 诊断步骤

确认入口前端处于哪种模式。ALB 前端的每个端口协议决定 TLS 是终止（`https`，L7）还是通过（`tcp`，L4）；检查 `cpaas-system` 中的 `global-alb2` 前端定义，以查看绑定到监听端口的协议。

```bash
kubectl get frontend -n cpaas-system -l alb2.cpaas.io/name=global-alb2 \
  -o custom-columns=NAME:.metadata.name,PORT:.spec.port,PROTOCOL:.spec.protocol
```

确认路由规则键控后端选择的主机名。ALB 通过将请求的主机与规则的 `spec.domain` 进行匹配来选择后端，规则的证书与该主机名绑定，因此没有原始 SNI 的请求无法匹配主机键控规则。

```bash
kubectl get rule.crd.alauda.io -n cpaas-system \
  -o custom-columns=NAME:.metadata.name,DOMAIN:.spec.domain,CERT:.spec.certificate_name
```

当症状仅在路径中有外部负载均衡器时，由 L7 终止前端引入的丢失或更改的 SNI 是区分因素：passthrough 需要 SNI 在端到端中存活，而一个终止并重新加密连接的 L7 负载均衡器不会保留它（kube v1.34.5，ALB 数据平面 `registry.alauda.cn:60080/acp/alb2:v4.3.1`）。
