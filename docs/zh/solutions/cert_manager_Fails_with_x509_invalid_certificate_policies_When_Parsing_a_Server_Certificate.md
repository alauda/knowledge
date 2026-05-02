---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: 78959ba75133f5633d8053b54df5e2bb0844f0935e7c6f6f9af48b8eb6ba3dde
---

## 问题

`cert-manager` 报告无法解析由 `Issuer` 端点（ACME 服务器、CA webhook、远程 `https://…` 目标）提供的证书，并记录如下形式的错误：

```text
failed to parse certificate from server: x509: invalid certificate policies
```

`Issuer` 处于未就绪状态，依赖于它的 `Certificate` 资源无法进展，ACME 账户注册失败，且在 cert-manager 控制器日志中出现相同的错误。远程端点本身是健康的，可以通过其他 TLS 客户端访问——浏览器、`curl`、`openssl s_client` 都能协商 TLS 并正确显示证书。只有基于 Go 的客户端出现问题。

## 根本原因

该错误源于 Go 标准库的 `crypto/x509` 包。该库的旧版本（Go 1.22 之前）拒绝包含 `policyIdentifier` 的 X.509 `certificatePolicies` 扩展，其 ASN.1 OID 的组件值足够大，以至于在解析器所采取的路径上溢出机器 `int`。因此，符合 RFC 的证书如果恰好使用了长 OID，则会因“无效的证书策略”而解析失败，尽管其他所有 TLS 工具都能毫无问题地接受它们。

由于 cert-manager（以及许多其他 Kubernetes 生态系统组件）是用 Go 编写的，并链接到标准库，因此任何早于 Go 1.22 修复的 cert-manager 构建在与其交互的端点提供此类证书时都会出现此症状。修复已在上游：基于 Go 1.22+ 构建的 cert-manager 版本能够顺利解析相同的证书。任何链接到旧版 `crypto/x509` 的 Go 程序都受到同类错误的影响，这并不特定于 cert-manager。

## 解决方案

1. **将 cert-manager 升级到基于 Go 1.22 或更高版本构建的版本。** 在 ACP 上，cert-manager 是支持的证书生命周期机制（`ClusterIssuer` / `Issuer` / `Certificate` CRD 都可以直接使用），并且跟踪的 cert-manager 构建会随着产品的更新而推进。将 cert-manager 安装升级到集群上当前支持的通道；除非有充分理由，否则不要停留在早于 Go 1.22 发布日期的版本上。

2. **检查任何其他与同一端点通信的基于 Go 的组件。** 在与 Git 服务器通信的 Argo CD repo-server、与接收器通信的 Prometheus `remote_write`、与入站 webhook 端点通信的 webhook 客户端中，都会重新出现相同的解析错误——任何旧版 Go 二进制文件解析有问题的服务器证书的地方。仅升级 cert-manager 并不能使集群的其他部分免受此问题的影响，如果它们共享目标端点。

3. **作为临时缓解措施，重新签发有问题的服务器证书，去掉有问题的策略。** 如果立即升级基于 Go 的客户端不可行，请要求颁发服务器证书的 CA 删除或缩短 `certificatePolicies` 下的 OID。这是一个端点侧的修复，而不是客户端侧的修复，它可以一次性解除所有受影响客户端的阻塞。并非总是可用（某些 CA 不会应请求重新签发），这就是为什么升级是持久的解决方案。

4. **不要通过禁用 TLS 验证来规避此问题。** 抑制错误——例如，告诉 cert-manager 跳过对端点的验证，或通过代理路由流量，该代理重新终止 TLS 并使用不同的证书——会隐藏 Go 标准库底层错误的诊断信号，并使其他客户端暴露于风险中。升级二进制文件或重新签发证书；不要掩盖解析器错误。

## 诊断步骤

确认 cert-manager 正在记录确切的此错误，并将其归因于目标 `Issuer`：

```bash
kubectl -n <cert-manager-namespace> logs deploy/cert-manager | grep -i "invalid certificate policies"
```

预期输出格式：

```text
E... cert-manager/issuers "msg"="failed to register an ACME account"
"error"="Get \"https://<endpoint>/acme/server\":
tls: failed to parse certificate from server: x509: invalid certificate policies"
"resource_kind"="Issuer" "resource_name"="<name>" "resource_namespace"="<ns>"
```

检索端点实际呈现的证书链，以便检查是什么导致了解析器的问题：

```bash
true | openssl s_client -showcerts -connect <endpoint-host>:443 </dev/null 2>/dev/null \
  | awk '/BEGIN CERT/,/END CERT/'
```

将每个 PEM 块保存到单独的文件中，然后要求 OpenSSL 显示 `certificatePolicies` 扩展——OpenSSL 能够顺利解析，这使其成为此特定检查的正确工具：

```bash
openssl x509 -in server.crt -ext certificatePolicies -noout
```

受影响证书的预期输出格式：

```text
X509v3 Certificate Policies:
    Policy: <very-long-dotted-OID-string>
      CPS: http://www.example.com/CPS
```

上述 cert-manager 错误与同一证书上具有长 OID 的 `certificatePolicies` 扩展的组合确认了 Go 解析器与 OID 之间的交互。通过解决步骤 1（升级）或步骤 3（重新签发而不使用长 OID）进行修复。
