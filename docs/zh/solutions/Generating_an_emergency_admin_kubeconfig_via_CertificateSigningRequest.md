---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500014
sourceSHA: c9a826e0142c89771afe8621fc3da69adee944c26499e069094f543d8a1be5e2
---

# 在 ACP 上使用 Kubernetes CSR API 颁发客户端证书

## 问题

在 Alauda Container Platform (Kubernetes `v1.34.5`) 上，管理员需要颁发一个新的客户端证书，以便使用标准 Kubernetes API 进行 kube-apiserver 的身份验证。`CertificateSigningRequest` 资源（`certificates.k8s.io/v1`，类型 `CertificateSigningRequest`，简称 `csr`）是集群范围的，提交的请求中包含 `signerName: kubernetes.io/kube-apiserver-client` 和 `client auth` 用途，要求该签名者颁发客户端证书；一旦获得批准，颁发的证书将根据签名者的文档目的，可以用于对 kube-apiserver 进行身份验证 \[ev:c1]。该证书的主题如何映射到 Kubernetes 用户/组身份由集群的身份验证和 RBAC 配置决定，超出本文的范围。

## 根本原因

针对 `kubernetes.io/kube-apiserver-client` 签名者的请求从未被 kube-controller-manager 自动批准，因此针对该签名者新提交的 CSR 将保持待处理状态，直到有授权的批准者对此采取行动 \[ev:c1]。这种类型的客户端证书请求通常携带 `digital signature`、`key encipherment` 和 `client auth` 用途 \[ev:c1]。

## 解决方案

提交一个带有 `kubernetes.io/kube-apiserver-client` 签名者名称和客户端身份验证用途的 `CertificateSigningRequest`，在 `spec.request` 中嵌入一个 base64 编码的 PEM 证书签名请求 \[ev:c1]。可选的 `spec.expirationSeconds` 字段携带颁发证书的请求有效期；内置签名者仅在 `--cluster-signing-duration` 配置的集群范围最大值内尊重该请求，可能颁发不同（通常是上限）的有效期，并拒绝任何低于 600 秒的值 \[ev:c2]。在下面的清单和命令中，`admin-client` 是一个占位符 CSR 名称 — 请替换为您实际创建的 CSR 的 metadata.name \[ev:c1]：

```yaml
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: admin-client
spec:
  signerName: kubernetes.io/kube-apiserver-client
  request: <base64-encoded PEM CSR>
  expirationSeconds: 86400
  usages:
    - digital signature
    - key encipherment
    - client auth
```

由于该签名者从未自动批准，因此授权的批准者必须在请求被签名之前批准待处理请求 \[ev:c1]。批准通过 `certificatesigningrequests/approval` 子资源记录，这与 `certificatesigningrequests/status` 子资源是不同的 \[ev:c3]：

```bash
kubectl certificate approve admin-client
```

在存在 `Approved` 条件后，签名者通过 `/status` 子资源将颁发的证书填充到 `.status.certificate` 中；该证书以 PEM 格式编码，并在序列化为 JSON 或 YAML 时额外进行 base64 编码 \[ev:c3]。在字段填充后读取并解码它 \[ev:c3]：

```bash
kubectl get csr admin-client \
  -o jsonpath='{.status.certificate}' | base64 -d > admin-client.crt
```

## 诊断步骤

确认请求已到达预期的签名者并检查其批准状态 — 请求保持待处理状态，直到有批准者采取行动，因为该签名者不自动批准 \[ev:c1]：

```bash
kubectl get csr admin-client \
  -o jsonpath='{.spec.signerName}{"\n"}{.status.conditions}{"\n"}'
```

如果 `.status.certificate` 为空，请验证是否存在 `Approved` 条件：签名者仅在通过单独的 `/approval` 子资源记录批准后，才通过 `/status` 子资源填充证书 \[ev:c3]。如果颁发的证书的有效期短于 `spec.expirationSeconds` 中放置的值，这是预期的 — 签名者仅在集群范围的 `--cluster-signing-duration` 内尊重请求，并且不会颁发低于 600 秒的证书 \[ev:c2]。
