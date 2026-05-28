---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500325
sourceSHA: 68cda856f0fc09d4f69d0d253f91498d65a09f0d9a414d6e308b9709003f5f14
---

# CSR 审批被拒绝 — 在 signers 资源上授予 signerName 范围的批准权限

## 问题

在 Alauda 容器平台 (Kubernetes 服务器 v1.34.5) 上，尝试批准一个 `CertificateSigningRequest` (`certificates.k8s.io/v1`，一个集群范围的资源) 时，用户或服务帐户似乎具有与证书相关的访问权限，但审批失败。审批被拒绝，返回 `Forbidden` 错误，形式为 `certificatesigningrequests.certificates.k8s.io "csr-xxx" is forbidden: user not permitted to approve requests with signerName "<signerName>"`，其中 `<signerName>` 是 CSR 上指定的签名者名称（例如 `kubernetes.io/kube-apiserver-client-kubelet`）。该错误特别指出了签名者名称，而不是一般的访问拒绝。

## 根本原因

CSR 审批受到一个专用授权检查的限制，该检查位于一个虚拟的 `signers` 资源上，而不仅仅是在 `certificatesigningrequests` 资源上。`signers` 资源仅存在于 apiGroup `certificates.k8s.io` 中，作为 RBAC 授权者构造：它并不出现在集群的 API 资源中 — 只有 `certificatesigningrequests` 被列出 — 并且纯粹存在于 RBAC 可以根据签名者限制审批的目的。

授权审批的授予形式为 `apiGroups: [certificates.k8s.io]`，`resources: [signers]`，`verbs: [approve]`，其中 `resourceNames` 锁定签名者。`resourceNames` 列表必须包含被批准的 CSR 的确切、字面 `signerName` 字符串；仅对列出的签名者授权审批。

一个 `signers` 规则未在 `resourceNames` 下列出 CSR 的 `signerName` 的角色没有权限批准该 CSR，这就是 `user not permitted to approve requests with signerName` 拒绝的机制。通配符或省略的 `signerName` 并不授权批准任何签名者 — 每个要批准的 `signerName` 必须明确列出。默认的每签名者审批者 ClusterRoles 针对知名签名者提供，每个角色仅限于单个签名者（例如，kubelet-serving 审批者角色仅命名 `kubernetes.io/kubelet-serving`，并且与 kubelet-client 审批者是不同的角色）。

## 解决方案

通过一个自定义的 `ClusterRole` 授予审批权限，该角色包含审批流程所需的完整规则集。除了对签名者的 `approve` 外，该角色还需要对 `certificatesigningrequests` 的 `get`/`list`/`watch` 权限，对 `certificatesigningrequests/approval` 和 `certificatesigningrequests/status` 子资源的 `update` 权限，以及在 apiGroup `authorization.k8s.io` 中对 `subjectaccessreviews` 的 `create` 权限（在审批期间由签名者授权者发出的 SubjectAccessReview API，`authorization.k8s.io/v1`）。每个应可批准的 `signerName` 必须在 `signers` 规则的 `resourceNames` 中列出。

以下 `ClusterRole` 授权对 `kubernetes.io/kube-apiserver-client-kubelet` 签名者的 CSR 进行审批；添加更多 `resourceNames` 条目以涵盖其他签名者：

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
    resources: ["certificatesigningrequests/approval", "certificatesigningrequests/status"]
    verbs: ["update"]
  - apiGroups: ["certificates.k8s.io"]
    resources: ["signers"]
    verbs: ["approve"]
    resourceNames: ["kubernetes.io/kube-apiserver-client-kubelet"]
  - apiGroups: ["authorization.k8s.io"]
    resources: ["subjectaccessreviews"]
    verbs: ["create"]
```

将 `ClusterRole` 绑定到用户或服务帐户，并使用 `ClusterRoleBinding`，然后重试审批：

```bash
kubectl certificate approve csr-xxx
```

拒绝的最常见原因是 `signers` 规则的 `resourceNames` 中省略了 CSR 的确切 `signerName`；纠正该字段 — 使用字面签名字符串，没有通配符 — 就是授权审批的关键。

## 诊断步骤

首先读取 CSR 以获取 `resourceNames` 条目必须匹配的确切 `signerName`：

```bash
kubectl get csr csr-xxx -o jsonpath='{.spec.signerName}'
```

检查请求主体的有效规则，并确认 `signers` 规则在 `resourceNames` 下列出了该字面签名字符串。可以直接检查对审批子资源的 `update` 权限，该检查是可靠的：

```bash
kubectl auth can-i update certificatesigningrequests/approval
```

签名者审批权限的验证更难以机械化。`kubectl auth can-i approve signers --subresource=<signerName>` 运行并返回是/否的判决，但其输出对于确认此授予并不可靠：它会发出警告，表明服务器没有资源类型 `signers`，并且基于 impersonation 的检查 (`--as=<user>`) 可以返回 `yes`，而不管被 impersonated 的主体是否实际拥有 signerName 范围的授予。在这里将 `can-i` 判决视为不确定，并通过直接读取 ClusterRole 的规则来确认签名者审批：

```bash
kubectl auth can-i approve signers --subresource=kubernetes.io/kube-apiserver-client-kubelet
```

由于 `auth can-i` 探测无法确认签名者授予，通过直接读取绑定的 `ClusterRole` 并检查 `signers` 规则的 `resourceNames` 是否包含 CSR 的确切 `signerName` 来验证；缺失或不匹配的条目是 `Forbidden` 拒绝的权威解释：

```bash
kubectl get clusterrole csr-approver -o jsonpath='{.rules}'
```
