---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: e94918fcf6fb899a3a628945820af28e051c5d6ec5fec52c8faf96b4ac286301
---

## 问题

在安装时生成的原始管理员 kubeconfig 可能会丢失、泄露，或者在控制平面 CA 轮换后出现 `x509: certificate signed by unknown authority` 的错误。当发生这种情况时——并且操作员不再通过 OIDC / OAuth 身份提供者拥有任何有效的集群管理员路径——集群仍然必须可访问。

此操作步骤生成一个新的短期客户端证书，该证书作为常规管理员身份（`CN=system:admin`，组 `system:masters`）进行身份验证，使用标准的 Kubernetes CSR API。这是最后的恢复路径：生成的凭证绕过 IdP，并继承每个符合标准集群附带的完整 `cluster-admin` ClusterRoleBinding。将生成的密钥视为敏感秘密，并在事件结束后立即进行轮换。

如果有非 CSR 签名路径（自定义 CA 附加到 apiserver 的 `client-ca-file`），请优先使用该路径——其过期时间由操作员自己的 CA 限制，而不是由集群签名者的 14 个月轮换周期限制。

## 解决方案

### 生成密钥 + CSR

创建一个 4096 位 RSA 密钥和一个 PKCS#10 CSR，其主题嵌入恢复身份：

```bash
openssl req -new -newkey rsa:4096 -nodes \
  -keyout admin-recovery.key \
  -out admin-recovery.csr \
  -subj "/CN=system:admin/O=system:masters"
```

通用名称是 apiserver 将看到的用户名；组织是组，`system:masters` 是绑定到内置 `cluster-admin` ClusterRole 的组。

### 将 CSR 提交到集群

CSR 资源引用上游的 `kube-apiserver-client` 签名者，这是每个标准集群用于签署客户端身份验证证书的：

```yaml
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: admin-recovery
spec:
  signerName: kubernetes.io/kube-apiserver-client
  expirationSeconds: 86400          # 1 天；限制为最短可接受的时间
  groups:
    - system:authenticated
  request: <BASE64_OF_admin-recovery.csr>
  usages:
    - client auth
```

将编码的 CSR 内联并创建它：

```bash
REQUEST=$(base64 -w0 admin-recovery.csr)
sed "s|<BASE64_OF_admin-recovery.csr>|${REQUEST}|" csr.yaml | kubectl apply -f -
```

`expirationSeconds` 由 apiserver 尊重，只要所选的签名者接受它；集群的签名 CA 可能进一步限制其生命周期。默认值——当省略时——为一年，大多数平台管理的签名者将单个证书的有效期限制得远低于签名者自己的有效性。

### 批准并获取证书

已经拥有 `certificates.k8s.io/certificatesigningrequests/approval` 权限的用户必须批准 CSR。从具有该权限的会话中：

```bash
kubectl get csr
kubectl certificate approve admin-recovery
kubectl get csr admin-recovery \
  -o jsonpath='{.status.certificate}' | base64 -d > admin-recovery.crt
```

如果没有这样的会话——意味着操作员根本没有有效的管理员路径——恢复将成为节点本地操作：SSH 到控制平面节点，提供指向 `https://localhost:6443` 的 kubeconfig，并使用本地主机提供的 CA 进行批准。该异步路径是平台特定的，应视为最后的后备。

### 组装恢复 kubeconfig

构建一个新的 kubeconfig，包含新证书、集群的服务 CA 包和选择恢复用户的上下文。从任何系统命名空间中的服务账户令牌秘密中提取 apiserver CA：

```bash
KUBECTL=kubectl
$KUBECTL get secret \
  -n kube-system \
  -l kubernetes.io/service-account.name=default \
  -o jsonpath='{.items[0].data.ca\.crt}' | base64 -d > apiserver-ca.crt
```

如果集群使用自定义 CA 签名的证书来前置 apiserver，而这些证书不属于集群内的 CA 包，请将它们附加：

```bash
cat custom-apiserver-ca.crt >> apiserver-ca.crt
```

然后使用三次 `kubectl config` 调用组装 kubeconfig，以便文件以习惯用法布局：

```bash
KCFG=/tmp/recovery.kubeconfig
SERVER=$($KUBECTL config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CLUSTER=$($KUBECTL config view --minify -o jsonpath='{.clusters[0].name}')

kubectl config set-cluster "$CLUSTER" \
  --server="$SERVER" \
  --certificate-authority=apiserver-ca.crt \
  --embed-certs \
  --kubeconfig="$KCFG"

kubectl config set-credentials system:admin \
  --client-certificate=admin-recovery.crt \
  --client-key=admin-recovery.key \
  --embed-certs \
  --kubeconfig="$KCFG"

kubectl config set-context system:admin \
  --cluster="$CLUSTER" \
  --namespace=default \
  --user=system:admin \
  --kubeconfig="$KCFG"

kubectl config use-context system:admin --kubeconfig="$KCFG"
```

### 验证凭证

对集群进行身份验证并确认主体：

```bash
kubectl --kubeconfig="$KCFG" auth whoami -o yaml
kubectl --kubeconfig="$KCFG" get nodes
```

`auth whoami` 应报告 `username: system:admin` 以及 `system:masters` 和 `system:authenticated` 组成员资格。一旦恢复 kubeconfig 被验证为有效，立即：

1. 通过常规 IdP / OAuth 路径重新建立长期管理员身份。
2. 如果有任何理由相信 apiserver CA 被泄露，则轮换集群签名者。
3. 删除恢复密钥（`shred -u admin-recovery.key`）并撤销 CSR 记录。

## 诊断步骤

如果 `kubectl certificate approve` 返回 `Forbidden`，则执行身份不具备 `signers/kubernetes.io/kube-apiserver-client` 上的 `approve` 动词。明确检查它：

```bash
kubectl auth can-i approve certificatesigningrequests \
  --subresource=approval
```

如果为 false，则无法从该会话进行恢复——升级到节点本地批准路径，或使用文件中存档的长期管理员 kubeconfig 备份。

如果生成的 kubeconfig 仍然因 `x509: certificate signed by unknown authority` 而失败，则嵌入的 CA 包不包括签署 apiserver 的服务证书的链。确认 apiserver 实际上提供了什么：

```bash
echo Q | openssl s_client -connect "${SERVER#https://}" -showcerts 2>/dev/null \
  | awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/'
```

将叶证书的颁发者与 `apiserver-ca.crt` 中的包进行比较。如果不匹配，请附加缺失的中间证书或根证书。

如果 `kubectl auth whoami` 报告 `system:anonymous` 或失败，则证书在映射到用户之前被拒绝。重新解码 CSR 的状态并确认 `Subject` 与请求的内容匹配：

```bash
openssl x509 -in admin-recovery.crt -noout -subject -issuer -dates
```

主题必须是 `CN=system:admin, O=system:masters`；如果在签名过程中 `O=` 被丢弃，集群将验证用户但不授予 cluster-admin（该 ClusterRoleBinding 是通过组而不是用户进行键控的）。

要检查授予管理员权限的绑定：

```bash
kubectl get clusterrolebinding cluster-admin -o yaml
```

默认的上游绑定将 `Group: system:masters` 映射到 `ClusterRole: cluster-admin`；如果该绑定已被编辑或替换（某些强化的发行版会这样做），请根据本地集群信任的管理员组调整恢复 CSR 的主题。
