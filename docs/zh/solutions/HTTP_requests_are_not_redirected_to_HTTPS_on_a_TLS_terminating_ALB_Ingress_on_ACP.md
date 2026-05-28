---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500281
sourceSHA: 7ffe14a74d7efd5f6ce9636cc404a5dbae2331c333350c64f37fee0e1a59a411
---

# 在 ACP 上的 TLS 终止 ALB Ingress 中，HTTP 请求未重定向到 HTTPS

## 问题

在 Alauda Container Platform 上，通过普通 HTTP 访问的终止 TLS 的 Ingress，请求在不安全端口上被处理（或拒绝），而不是被发送到安全的 HTTPS URL。这让期望 TLS 终止前端自动将客户端转移到 HTTPS 的操作员感到惊讶。在 ALB 数据平面（ALB v4.3.1，镜像 `registry.alauda.cn:60080/acp/alb2:v4.3.1`，Kubernetes 服务器 v1.34.5）上，除非显式配置了 HTTP 到 HTTPS 的重定向，否则 TLS 终止的 Ingress 不会将普通 HTTP 请求重定向到 HTTPS；默认情况下没有重定向。

## 根本原因

重定向是选择性的，而不是默认开启的。在 `cpaas-system` 命名空间中由 `global-alb2` 实例前置的 Ingress 对象中，只有一个带有显式重定向注释的 Ingress 会发出重定向；其余的则在不安全的 HTTP 端口上提供服务，而没有自动重定向到 HTTPS。由于该行为是由注释驱动的，未被注释为重定向的 Ingress 仅在不安全端口上响应，这正是观察到的症状。

## 解决方案

在 TLS 终止的 Ingress 上配置重定向，目标是 HTTPS URL。ALB 支持 nginx 风格的 Ingress 注释，因此通过将相应的重定向注释（`nginx.ingress.kubernetes.io/temporal-redirect`）添加到终止 TLS 的 Ingress 来请求重定向。该注释本身并不强制使用 HTTPS 方案；它会对配置的重定向目标发出 302，因此对于 HTTP 到 HTTPS 的重定向，配置的目标必须是客户端应被发送到的安全 HTTPS URL（或端点）。

为了发出重定向，不安全的 HTTP 端口必须可被客户端访问：重定向响应是在 ALB 的不安全 HTTP 前端（端口 80）上实现的，因此客户端必须能够访问该端口才能返回重定向。如果不安全端口关闭或无法访问，则无法传递重定向。

一旦配置了重定向，对普通 HTTP URL 的请求将不再返回资源内容；相反，不安全前端将以 HTTP 302（30x 重定向）响应，指向安全的 HTTPS URL。

## 诊断步骤

通过使用 `curl` 的 `-L`（`--location`）选项请求普通 HTTP URL，以确认是否发生了重定向，该选项使 `curl` 跟随重定向响应直到目标。

```bash
curl -L -i http://<ingress-host>/
```

检查不安全 HTTP URL 的响应。配置正确的重定向会在普通 HTTP 请求上返回 HTTP 302（30x），并将 `Location` 头指向 HTTPS URL，而不是直接在不安全端口上提供资源主体。如果未配置重定向，相同的请求将在不安全端口上响应，没有 30x 状态，表明缺少重定向注释。

在检查过程中验证不安全的 HTTP 端口是否可达；302 是由 ALB 的不安全 HTTP 前端发出的，因此无法到达不安全端口的请求即使在配置了重定向的情况下也无法观察到重定向。
