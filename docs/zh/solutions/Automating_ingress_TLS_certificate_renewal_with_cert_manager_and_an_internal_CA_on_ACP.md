---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500275
sourceSHA: 2b9e55d470709a2c96251a91ea31341eb9edf026da823f90bfc2ea0818d1762d
---

# 使用 cert-manager 和内部 CA 在 ACP 上自动化 ingress TLS 证书续订

## 问题

在 Alauda 容器平台上，终止 TLS 的 ingress 端点需要无人工干预地颁发和轮换证书。那些不想依赖外部公共 CA 的操作员可以在集群内部建立一个内部 CA，并让 cert-manager 生成和自动续订支持 ingress TLS 秘密的叶证书。cert-manager 在 ACP 上可用：`cert-manager.io` 组中的 `certificates`、`clusterissuers`、`issuers` 和 `certificaterequests` 自定义资源均已存在，存储版本为 `v1`，因此此工作流中的每个资源都使用 `apiVersion: cert-manager.io/v1`。cert-manager 控制器从镜像 `cert-manager-controller:v1.17.18-v4.3.1`（ACP cert-manager 插件图表 `cert-manager-v4.3.1`）在 `cert-manager` 命名空间中运行。

## 解决方案

使用自签名的 `ClusterIssuer` 启动信任链。一个 `ClusterIssuer` 其规格包含 `selfSigned: {}`，作为自签名根，签署一个引导证书，而无需任何外部 CA，这是为内部链播种的标准 cert-manager 形式。

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-bootstrap
spec:
  selfSigned: {}
```

从该自签名颁发者颁发 CA 证书。由自签名 `ClusterIssuer` 颁发的 `spec.isCA: true` 的 `Certificate` 生成一个 CA 密钥对，cert-manager 将其写入由 `spec.secretName` 指定的秘密中，作为持有 `tls.crt` 和 `tls.key` 的 `kubernetes.io/tls` 秘密。

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: internal-ca
  secretName: ca-root-secret
  privateKey:
    rotationPolicy: Always
  issuerRef:
    name: selfsigned-bootstrap
    kind: ClusterIssuer
    group: cert-manager.io
```

在 CA `Certificate` 上设置 `privateKey.rotationPolicy: Always`，以便在重新颁发时生成一个符合配置要求的新私钥，而不是重用现有密钥；该字段是一个枚举值 `{Never, Always}`，默认值为 `Never`。

将 CA 密钥对提升为 CA 类型的 `ClusterIssuer`。CA 类型的 `ClusterIssuer` 通过 `spec.ca.secretName` 引用现有的 CA 密钥对，并使用它来签署请求的证书；集群上的活动 CA 类型 `ClusterIssuer` 在其签名 CA 被验证后报告状态原因 `KeyPairVerified`。

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca-issuer
spec:
  ca:
    secretName: ca-root-secret
```

从 CA 类型的颁发者请求叶 ingress 证书。通过 `issuerRef`（`kind: ClusterIssuer`，`group: cert-manager.io`）引用 CA `ClusterIssuer` 的 `Certificate` 被颁发一个叶证书，cert-manager 将其写入由 `spec.secretName` 指定的 `kubernetes.io/tls` 秘密中，携带 `tls.crt`、`tls.key` 和 `ca.crt`。叶 `Certificate` 的 `spec.dnsNames` 和 `spec.commonName` 填充了颁发证书的 SAN 和 CN 条目。

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: custom-ingress-tls
  namespace: my-app
spec:
  secretName: custom-ingress-tls
  commonName: app.example.com
  dnsNames:
    - app.example.com
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io
```

通过标准 Kubernetes `Ingress` 资源将颁发的 TLS 秘密绑定到 ingress。`spec.tls[].secretName` 字段引用与叶 `Certificate` 生成的相同 `kubernetes.io/tls` 秘密，因此 ingress 使用 cert-manager 管理的证书终止 TLS，适用于列出的主机。

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: my-app
spec:
  tls:
    - hosts:
        - app.example.com
      secretName: custom-ingress-tls
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  number: 80
```

续订由 cert-manager 处理，无需手动重新颁发：它在到期之前续订 `Certificate`，并在原地刷新 TLS 秘密的内容。在活动的叶证书上，cert-manager 填充续订状态字段 — `status.renewalTime` 是从证书的 `notAfter` 减去其 `renewBefore` 窗口计算得出的，当秘密被刷新时，修订计数器会增加。由于 ingress 从绑定的秘密中读取证书，因此轮换的材料在不更改 `Ingress` 定义的情况下提供。

## 诊断步骤

在应用上述任何资源之前，确认 cert-manager CRD 存在并解析到预期的组和版本：

```bash
kubectl get crd certificates.cert-manager.io clusterissuers.cert-manager.io \
  issuers.cert-manager.io certificaterequests.cert-manager.io
```

检查 CA 类型的 `ClusterIssuer` 是否已验证其签名密钥对；就绪的颁发者在其状态条件中报告 `KeyPairVerified` 原因：

```bash
kubectl get clusterissuer internal-ca-issuer -o yaml
```

检查叶 `Certificate` 以确认其颁发的 SAN/CN 输入及其计划的续订。`spec.dnsNames` 和 `spec.commonName` 是 cert-manager 写入叶证书的 SAN 和 CN 输入，`status.renewalTime` 以及修订计数器显示下一个计划的续订和秘密已刷新多少次：

```bash
kubectl get certificate custom-ingress-tls -n my-app \
  -o jsonpath='{.spec.dnsNames}{"\n"}{.status.renewalTime}{"\n"}{.status.revision}{"\n"}'
```

在将其绑定到 `Ingress` 之前，验证生成的 TLS 秘密具有预期的 `kubernetes.io/tls` 类型，并且其数据包含 `tls.crt`、`tls.key` 和 `ca.crt` 键；以下命令打印秘密类型及其键名称列表：

```bash
kubectl get secret custom-ingress-tls -n my-app \
  -o json | jq '{type, keys: (.data | keys)}'
```
