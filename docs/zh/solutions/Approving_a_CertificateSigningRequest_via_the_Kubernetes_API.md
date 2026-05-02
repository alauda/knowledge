---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: f57062440686d55d0f3e32fce686752bf047e0d83f1adbfae4c9601a9278d556
---

## 问题

需要以编程方式批准证书签名请求（CSR）——例如来自 CI 作业、Webhook 处理程序或自动化控制器——而使用 `kubectl certificate approve` 的方式并不可行。在某些构建环境中，标准的 `kubectl` 管理动词缺失，工具链仅携带 HTTP 客户端，或者工作流需要在批准调用中附加额外的可审计元数据。

## 解决方案

通过直接 `PATCH` `/approval` 子资源来批准 CSR，使用 `certificates.k8s.io/v1` API。该子资源接受一个战略合并或 `merge-patch+json` 的请求体，将 `Approved` 条件切换为 `True`。然后，kube-apiserver 通过与 `kubectl certificate approve` 使用相同的准入和审计链路路由更改，因此结果是相同的（重要的是，像 `kube-controller-manager` 这样的下游签名者将会签发证书）。

### 1. 选择一个具有批准权限的身份

批准 CSR 是 `signers` 资源上的一个单独的 RBAC 动词（`approve`）。kube-controller-manager 内置角色已经为集群范围的签名者授予了该权限；对于自定义自动化帐户，请显式绑定：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: csr-approver
rules:
  - apiGroups: ["certificates.k8s.io"]
    resources: ["certificatesigningrequests"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["certificates.k8s.io"]
    resources: ["certificatesigningrequests/approval"]
    verbs: ["update", "patch"]
  - apiGroups: ["certificates.k8s.io"]
    resources: ["signers"]
    resourceNames: ["kubernetes.io/kube-apiserver-client", "example.com/my-signer"]
    verbs: ["approve"]
```

将角色绑定到将执行批准的 ServiceAccount 或用户。如果在匹配的 `signers` resourceName 上没有 `approve` 动词，kube-apiserver 将返回 `Forbidden`，即使补丁负载格式正确。

### 2. 为该身份获取一个令牌

对于基于 ServiceAccount 的自动化程序，请请求一个短期令牌：

```bash
kubectl create token csr-approver-sa -n automation --duration=10m
```

将输出捕获到 `TOKEN` shell 变量中。避免为该动词使用长期静态令牌；一旦获得批准，主体可以将 TLS 身份交给任何请求者。

### 3. PATCH `/approval` 子资源

提交到 `/approval` 的条件列表将替换现有的条件切片；在请求体中包含任何应保留的条件。对于新的批准，一个条目就足够了：

```bash
APISERVER="https://kubernetes.default.svc"   # 或外部 API URL
CSR_NAME="my-pending-csr"

curl -sk -X PATCH \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/merge-patch+json" \
  --data '{"status":{"conditions":[{"type":"Approved","status":"True","reason":"AutoApprovedByCI","message":"approved by csr-approver-sa"}]}}' \
  "${APISERVER}/apis/certificates.k8s.io/v1/certificatesigningrequests/${CSR_NAME}/approval"
```

注意：

- 路径以 `/approval` 结尾——直接补丁父 CSR 对象不会切换条件，因为批准位于专用子资源上。
- 使用 `merge-patch+json` 而不是 `strategic-merge-patch+json`。条件列表的战略合并在此类型上不尊重位置合并键，而是静默地附加而不是替换。
- `reason` 和 `message` 会在审计日志和 `kubectl describe csr <name>` 中显示。用自动化的身份填充它们，以便后续操作员可以回答“谁批准了这个，为什么”。

### 4. 确认批准

```bash
kubectl get csr "${CSR_NAME}" -o jsonpath='{.status.conditions[?(@.type=="Approved")].status}'
```

预期输出为 `True`。签名控制器将随后签发证书；观察 `.status.certificate` 在短时间内变为非空的 base64 blob。

## 诊断步骤

如果 PATCH 返回 `403 Forbidden`，请验证无命名空间的 RBAC 绑定和 CSR 的 `signerName`：

```bash
kubectl get csr "${CSR_NAME}" -o jsonpath='{.spec.signerName}'
kubectl auth can-i approve signers/<signerName> --as=system:serviceaccount:automation:csr-approver-sa
```

如果 PATCH 返回 `200 OK` 但 `.status.certificate` 仍为空，则问题出在签名者一侧：像 kube-controller-manager 这样的自动化签名者仅为其配置处理的签名者名称签署 CSR（`kubernetes.io/kube-apiserver-client-kubelet`、`kubernetes.io/kubelet-serving`、`kubernetes.io/kube-apiserver-client`）。对于自定义签名者名称，必须运行单独的签名控制器。

如果需要拒绝批准，请提交相同的调用，使用 `"type":"Denied"`（并可选择性地包含先前的条件条目以保持其完整）。一旦 CSR 带有 `Denied` 条件，签名者将不会签发，即使后续请求添加了 `Approved` 条件。
