---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: 150b6cb4c7fa405a5bc9340f1b175447bf6e39af362844f0f34962291d6d3342
---

## 问题

平台管理员需要为 Alauda Container Platform 集群生成一个新的 `kubeconfig` —— 用于提供对新自动化系统的访问、更换泄露的文件或轮换长期凭证。直接撤销现有 kubeconfig 的内容是有风险的，因为同一个文件可能被系统组件、CI 作业或其他管理员共享；因此，支持的工作流程是生成一个新的凭证，并以受控的方式退役旧的凭证。

## 根本原因

kubeconfig 只是一个 YAML 文档，包含一个集群端点、一个用户身份（客户端证书、令牌或执行凭证插件）和一个将两者配对的上下文。由于相同的身份可能嵌入在分发给多个用户的许多 kubeconfig 文件中，撤销访问需要使底层身份失效（轮换其证书、删除其 ServiceAccount 令牌 Secret 或移除其 RBAC 绑定）—— 而不是编辑一个本地文件。因此，通过生成一个全新的身份并导出一个引用它的 kubeconfig 来创建新的访问。

## 解决方案

选择与 kubeconfig 使用方式相匹配的凭证类型：

### 选项 1 — 长期有效的 ServiceAccount 令牌（推荐用于自动化）

手动提供令牌 Secret 的 ServiceAccount 提供了一个稳定的 bearer-token 身份，可以通过删除 Secret 来撤销，而不会影响其他用户。

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ci-readonly
  namespace: kube-system
---
apiVersion: v1
kind: Secret
metadata:
  name: ci-readonly-token
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: ci-readonly
type: kubernetes.io/service-account-token
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ci-readonly-view
subjects:
- kind: ServiceAccount
  name: ci-readonly
  namespace: kube-system
roleRef:
  kind: ClusterRole
  name: view
  apiGroup: rbac.authorization.k8s.io
```

应用，然后将凭证导出到 kubeconfig：

```bash
kubectl apply -f sa.yaml
TOKEN=$(kubectl -n kube-system get secret ci-readonly-token \
          -o jsonpath='{.data.token}' | base64 -d)
CA=$(kubectl -n kube-system get secret ci-readonly-token \
          -o jsonpath='{.data.ca\.crt}')
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CLUSTER=acp

kubectl config --kubeconfig=new-kubeconfig set-cluster "$CLUSTER" \
  --server="$SERVER" --certificate-authority=<(echo "$CA" | base64 -d) \
  --embed-certs=true
kubectl config --kubeconfig=new-kubeconfig set-credentials ci-readonly \
  --token="$TOKEN"
kubectl config --kubeconfig=new-kubeconfig set-context ci-readonly \
  --cluster="$CLUSTER" --user=ci-readonly
kubectl config --kubeconfig=new-kubeconfig use-context ci-readonly
```

### 选项 2 — 短期有效的 TokenRequest（推荐用于人工用户）

对于已经在平台身份验证后端中拥有身份的交互式用户，请请求一个有限生命周期的令牌，并让用户将其导入到他们的 kubeconfig 中：

```bash
kubectl -n kube-system create token ci-readonly --duration=8h > token.txt
```

将令牌与集群 CA 包和服务器 URL 一起分发。用户运行与上述相同的 `kubectl config set-cluster / set-credentials / set-context` 序列，替换来自 `token.txt` 的令牌。

### 选项 3 — TLS 客户端证书

如果集群身份验证器配置为接受客户端证书（在使用之前请与平台所有者确认）：

```bash
openssl genrsa -out user.key 2048
openssl req -new -key user.key -out user.csr -subj "/CN=jane/O=devs"

cat <<EOF | kubectl apply -f -
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata: { name: jane-csr }
spec:
  request: $(base64 -w0 < user.csr)
  signerName: kubernetes.io/kube-apiserver-client
  usages: [client auth]
EOF

kubectl certificate approve jane-csr
kubectl get csr jane-csr -o jsonpath='{.status.certificate}' \
  | base64 -d > user.crt
```

然后使用 `kubectl config set-credentials jane --client-certificate=user.crt --client-key=user.key --embed-certs=true` 构建 kubeconfig。

### 退役旧的 kubeconfig

在验证新文件正常工作后，使旧凭证失效：

- ServiceAccount 令牌：`kubectl delete secret <old-token-secret>`。来自旧 kubeconfig 的下一个 API 调用将返回 401。
- 绑定的 TokenRequest：无需操作 —— 令牌会自行过期。
- 客户端证书：在您的 CA/PKI 中撤销；在轮换之前，还需移除 RBAC 绑定（`kubectl delete clusterrolebinding <name>`）。

## 诊断步骤

如果新生成的 kubeconfig 无法工作：

```bash
kubectl --kubeconfig=new-kubeconfig auth can-i get nodes
kubectl --kubeconfig=new-kubeconfig get --raw='/api'
```

- 401 → 令牌/证书错误或已被删除。
- 403 → 身份有效但缺少 RBAC；请仔细检查 `RoleBinding`/`ClusterRoleBinding` 和 `subjects[].name`/`namespace` 是否与您使用的 SA 匹配。
- TLS 错误 → 嵌入的 CA 与集群 API 服务器不匹配；从 SA 令牌 Secret 或平台的证书分发机制重新获取 CA。
