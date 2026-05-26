---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500037
sourceSHA: 060307cff4db4ca51f87e27262397523c5d23915d310857f760a47358f8e699e
---

# x509 客户端证书认证与 ACP 上的 kube-apiserver 客户端-CA 捆绑包

## 问题

在 Alauda Container Platform (Kubernetes v1.34.5) 上，集成外部身份或工作负载并呈现客户端证书的管理员需要了解 kube-apiserver 如何决定是否信任该证书。当所呈现的证书链到配置的客户端-CA 捆绑包中的证书颁发机构时，API 服务器会对携带 x509 客户端证书的请求进行身份验证，并且该证书映射到有效的用户身份 \。用于此流程的证书遵循标准的 TLS 客户端证书形式，请求 `digital signature`、`key encipherment` 和 `client auth` 密钥用法 \\。

## 解决方案

本文从概念上描述了信任模型。将额外的客户端-CA 捆绑包传递给 kube-apiserver 的集群表面在 ACP 上由环境管理，并未作为用户可编辑的资源暴露在支撑本文的 CSR API 形状中；请将下面的操作步骤视为有关如何建立信任的信息，而不是配置配方 \\。

客户端证书的信任是通过分发给 API 服务器的 CA 捆绑包建立的：x509 客户端证书会根据该分发的信任捆绑包进行验证，这是 Kubernetes 客户端证书认证的通用机制 \。一个链到 API 服务器配置的客户端-CA 信任捆绑包中的 CA 的客户端证书，并且携带 `client auth` 密钥用法以及 `digital signature` 和 `key encipherment`，在 API 服务器上被视为有效的客户端证书认证候选 \。

PEM 客户端-CA 捆绑包是一个纯文本文件，包含一个或多个连接在一起的 CA 证书，每个证书由标准 PEM 标记分隔：

```text
-----BEGIN CERTIFICATE-----
<base64-encoded CA certificate>
-----END CERTIFICATE-----
```

一旦信任捆绑包包含给定的 CA，呈现由该 CA 签名并携带 `client auth` 密钥用法的证书的客户端将会对 kube-apiserver 进行身份验证，并被解析为其映射的用户身份 \\。
