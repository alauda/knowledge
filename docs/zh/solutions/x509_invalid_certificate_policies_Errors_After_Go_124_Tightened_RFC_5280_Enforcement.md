---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500035
sourceSHA: d1b36bf370cf3c88df249dc72e947bebb9ae5bfe17458763980891bb2162bff6
---

## 问题

一个集群组件在升级平台后，建立与外部端点的 TLS 连接时开始无法解析服务器的证书：

```text
tls: failed to parse certificate from server: x509: invalid certificate policies
```

该故障在不同的上下文中表现出来，具体取决于出站连接的方式——最明显的是一个基于 LDAP 的登录流程，返回 `AuthenticationError` / `Network Error`，并伴随相同的解析错误：

```text
LDAP Result Code 200 "Network Error":
  tls: failed to parse certificate from server:
  x509: invalid certificate policies
```

其他通过 TLS 连接到外部服务的组件（目录获取、Webhook 回调、遥测端点）也出现相同的消息。证书本身在 `openssl s_client` 中看起来正常，可以在浏览器中加载，并且在升级之前与相同的端点正常工作——链、过期日期或 CA 包没有明显的问题。

共同点是 **失败的组件是基于哪个运行时构建的**。

## 根本原因

[RFC 5280 §4.2.1.4](https://www.rfc-editor.org/rfc/rfc5280#section-4.2.1.4) 规定证书的 `certificatePolicies` 扩展 **不得** 重复 `policyIdentifier` OID。每个策略 OID 在扩展中最多只能出现一次。

历史上，Go 的 `crypto/x509` 解析器容忍违反此规则的证书——解析成功，调用者可以继续进行自己的验证，大多数情况下并未注意到。从 **Go 1.24** 开始，解析器严格执行该约束：包含重复 OID 的证书在 `ParseCertificate` 时会被拒绝，返回 `x509: invalid certificate policies`。

因此，故障并不是由集群或端点触发的。它是由在 Go 1.24+ 上重新构建的组件触发的，这些组件突然拒绝了在 Go 1.23 或更早版本下可以接受的证书。两个推论：

1. 客户端的 TLS 选项（`InsecureSkipVerify`、自定义验证回调、额外的信任包）无法隐藏错误。解析在验证运行之前就失败了。
2. 故障是特定于证书的，而不是特定于端点的。每个访问相同证书并基于 Go 1.24+ 构建的调用者都会以相同的方式失败。LDAP 是一个常见的早期表面，因为企业 LDAP 服务器通常位于由内部 CA 颁发的证书后面，而这些证书的工具多年前就发出了重复的 OID，没人注意到。

## 解决方案

持久的修复在于 **证书颁发者** 端。客户端无法绕过严格执行 RFC 的解析器；唯一的补救措施是提供符合 RFC 的证书。

### 重新签发没有重复 OID 的服务器证书

请要求拥有该端点的团队（LDAP 操作员、内部 PKI、设备供应商）重新签发证书，确保其 `certificatePolicies` 扩展去重。每个策略 OID 必须出现一次。具体来说：

- 颁发者的证书生成配置通常有一个接受列表的策略 OID 字段。审计该列表以查找重复项（有时相同的 OID 是从父 CA 配置继承而来，并且也列在叶子配置中——渲染器在没有去重的情况下连接）。
- 在某些商业设备上，存在一个“RFC 5280 严格”切换；启用它会导致设备拒绝自己的重复项，而不是发出它们。
- 如果证书是由内部 CA 工具（cfssl、step-ca、脚本化的 openssl）签名的，请使用列出每个 OID 恰好一次的配置文件重新生成。

将重新签发的证书部署到端点。来自 Go-1.24 客户端的下一个连接完成握手；组件恢复正常。

### 审计集群依赖的其他端点

一个端点的证书几乎从不单独携带重复项。当内部 CA 已经发出重复项一段时间时，**每个** 在此期间签发的证书都有相同的问题。列举集群的出站 TLS 依赖项，并在其依赖组件在 Go 1.24 上构建之前预先检查每个证书：

- LDAP 端点
- OIDC / SAML 身份提供者
- 外部镜像注册表
- 外部 Git 服务器（GitOps 源、Webhook）
- 外部 Webhook 接收器（Slack、PagerDuty、自定义集成）
- Syslog / 日志转发端点
- 备份存储端点（S3 兼容、NFS-over-TLS）

在 Go-1.24 组件开始指向它们之前，重新签发任何携带重复 OID 的证书。

### 没有安全的客户端绕过方法

将组件降级到 Go-1.24 之前的构建充其量是权宜之计——一旦链中的另一个组件升级到 Go 1.24，问题就会重新出现。固定 `InsecureSkipVerify` 不是缓解措施，因为解析错误发生在验证之前。构建一个手动接受证书的自定义 TLS 拨号器需要重新实现 TLS 解析，这是不合理的。

正确的修复始终是重新签发证书。

## 诊断步骤

捕获失败端点呈现的确切证书。从可以访问该端点的工作站：

```bash
echo Q | openssl s_client -showcerts -connect <endpoint>:<port> 2>/dev/null | \
  awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/' > /tmp/server-chain.pem
```

遍历链并检查每个证书的 `certificatePolicies` 扩展是否有重复项：

```bash
awk '/-----BEGIN CERTIFICATE-----/{i++; f="/tmp/chain-"i".pem"} {print > f}' < /tmp/server-chain.pem

for f in /tmp/chain-*.pem; do
  echo "=== $f ==="
  openssl x509 -in "$f" -ext certificatePolicies -noout 2>/dev/null | \
    awk '/Policy:/ {print $2}' | sort | uniq -c | awk '$1 > 1 {print "DUPLICATE: " $0}'
done
```

任何以 `DUPLICATE:` 开头的输出行标识出现多次的特定 OID，并命名携带它的证书文件。该证书是颁发者必须重新签发的证书。

在集群端验证失败的组件确实是基于 Go 1.24+ 编译的（有时故障来自不同的来源）：

```bash
# 确定运行失败组件的 Pod。
kubectl -n <ns> logs <pod> --tail=200 | grep -E 'x509: invalid certificate policies'

# 如果可能，检查二进制文件的 Go 构建信息。
kubectl -n <ns> exec <pod> -- sh -c '
  for b in /usr/bin /usr/local/bin; do
    for exe in $b/*; do
      go version "$exe" 2>/dev/null
    done
  done' 2>/dev/null | grep -E 'go1\.[0-9]+'
```

一行 `go1.24.x`（或更新版本）确认组件的运行时是引入严格执行的 Go 版本。如果显示 `go1.23.x` 或更早版本，同时仍然产生解析错误，则表明有不同的根本原因——请重新检查证书是否存在其他形状问题（负序列号、格式错误的扩展），而不是本说明所涉及的策略重复问题。

在重新签发证书后，重试失败的操作。健康的响应确认修复；审计颁发者的生成模板，以确保新证书不会重新引入重复项。
