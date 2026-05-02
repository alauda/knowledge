---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500037
sourceSHA: ed23f697449e8c82384c85af9adee6eb61560f8fb054baaa48fbf7a4e0aa9b31
---

# 向 Kubernetes API 服务器添加额外的客户端 CA

## 问题

必须向集群的 API 服务器添加一个额外的受信任证书颁发机构，以便能够验证由该 CA 签名的 x.509 证书的客户端。典型场景包括：

- 内部企业 PKI 正在推出新的颁发 CA，客户端正在重新签发与新根链的证书，而 API 服务器尚未信任该根。
- 为特定类型的工作负载（服务到 API 服务器、操作员自动化）引入了一个次级 CA，与现有的人类管理员 CA 并行。
- 一个分阶段的轮换，其中旧 CA 和新 CA 在旧 CA 被退役之前必须在重叠窗口内都被接受。

如果 API 服务器的客户端 CA 包中没有新的 CA，则每个呈现来自新链的证书的请求都会在 TLS 层被拒绝，客户端永远无法到达任何身份验证器。

## 根本原因

Kubernetes API 服务器通过验证所呈现的证书与 `--client-ca-file` 中配置的 CA 列表进行 x.509 客户端证书的身份验证。如果所呈现证书的签名链未终止于这些 CA 之一，则 TLS 握手完成，但 `User` 变为未认证，请求以 `401` 失败。该包是基于文件的：API 服务器需要接受的每个 CA 都必须存在于同一个 PEM 包中。

在 ACP 中，接受的客户端 CA 集合作为平台级对象呈现，而不是原始文件。平台级对象引用一个 ConfigMap，该 ConfigMap 持有 CA 包；协调 API 服务器的控制器获取 ConfigMap 引用，并将包放入 API 服务器读取的文件路径中。因此，添加 CA 是一个两步操作：创建 ConfigMap，然后将平台对象指向它。

## 解决方案

步骤 1 — 将新的 CA（以及任何应继续被信任的 CA）打包为 PEM 格式，并将其存储在平台保留的配置命名空间中的 ConfigMap 中。键名 `ca-bundle.crt` 是常规选择；选择平台级 API 在您的集群上期望的任何键名：

```bash
kubectl create configmap client-ca-custom \
  -n <platform-config-namespace> \
  --from-file=ca-bundle.crt=ca.crt
```

提供完整的包，而不仅仅是新的 CA：文件内容在控制器呈现时替换受信任的客户端 CA 集合，因此任何省略的内容将停止被信任。如果在轮换期间旧 CA 应继续被接受，请将新 CA 连接到现有包中：

```bash
cat existing-ca-bundle.crt new-ca.crt > ca-bundle.crt
kubectl create configmap client-ca-custom \
  -n <platform-config-namespace> \
  --from-file=ca-bundle.crt=ca-bundle.crt \
  --dry-run=client -o yaml | kubectl apply -f -
```

步骤 2 — 从平台级 API 服务器对象引用 ConfigMap：

```bash
kubectl patch apiserver cluster \
  --type=merge \
  -p '{"spec":{"clientCA":{"name":"client-ca-custom"}}}'
```

一旦控制器协调完成，API 服务器的 `--client-ca-file` 将使用新包重新生成。任何其证书链在包中的 CA 之一上验证且其身份（通用名称/组织用于组）映射到真实主题的客户端将进行身份验证。

基于证书的身份验证仅处理身份投影：结果用户仍然需要 RBAC 才能执行任何操作。在 CA 到位后，创建引用证书携带的 `CommonName` 或 `Organization` 的 RoleBindings / ClusterRoleBindings，或绑定到通过 x.509 `O=` 字段继承的组。

### 轮换模式

在替换 CA 而不是添加 CA 时：

1. 构建一个包含旧 CA 和新 CA 的组合包。应用它。API 服务器现在接受来自任一链的证书。
2. 从新 CA 重新签发客户端证书并分发它们。
3. 一旦每个消费者切换并确认工作，重新构建包以仅包含新 CA 并重新应用。旧 CA 在下一个控制器协调时将从 `--client-ca-file` 中删除。

切勿在实时集群中一步到位地交换 CA — 每个持有旧 CA 证书的在途客户端在协调期间都将被锁定。

## 诊断步骤

验证 ConfigMap 存在并携带您所期望的内容：

```bash
kubectl -n <platform-config-namespace> get configmap client-ca-custom -o yaml
kubectl -n <platform-config-namespace> get configmap client-ca-custom \
  -o jsonpath='{.data.ca-bundle\.crt}' \
  | openssl crl2pkcs7 -nocrl -certfile /dev/stdin \
  | openssl pkcs7 -print_certs -noout \
  | grep -E 'subject=|issuer='
```

验证平台级 API 服务器对象是否引用它：

```bash
kubectl get apiserver cluster -o jsonpath='{.spec.clientCA}{"\n"}'
```

确认控制器已协调更改 — API 服务器 Pod 应该已经重启（或通过就地重新加载获取新包，具体取决于发行版）自补丁以来。滚动重启状态通常在一个伴随的状态对象上显示；如果没有，检查 API 服务器 Pod 的年龄：

```bash
kubectl -n <apiserver-namespace> get pod -l <apiserver-label> \
  -o custom-columns=NAME:.metadata.name,AGE:.status.startTime,READY:.status.containerStatuses[0].ready
```

使用由新 CA 签名的客户端证书测试实际身份验证。成功的身份验证在审计日志条目中显示为预期的 `User`；失败则在客户端产生 `x509: certificate signed by unknown authority`：

```bash
kubectl --server=https://<api-endpoint> \
  --certificate-authority=server-ca.crt \
  --client-certificate=user.crt \
  --client-key=user.key \
  auth whoami
```

预期输出：一个 `UserInfo` 对象，命名为证书中的通用名称。这里的 `401 Unauthorized` 与格式良好的证书意味着包未正确更新 — 重新检查步骤 1 和 2，特别是确保 `ca-bundle.crt` 包含到 ConfigMap 中的根的整个签名链。

有关 x.509 概念（如何将 `CommonName` 映射到 `User`，如何将 `Organization` 映射到 `Group`，证书组如何与 RBAC 交互），上游 Kubernetes 文档中关于身份验证策略的内容详细涵盖了映射。
