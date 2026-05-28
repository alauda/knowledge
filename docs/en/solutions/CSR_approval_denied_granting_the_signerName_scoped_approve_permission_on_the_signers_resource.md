---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# CSR approval denied — granting the signerName-scoped approve permission on the signers resource

## Issue

On Alauda Container Platform (Kubernetes server v1.34.5), an attempt to approve a `CertificateSigningRequest` (`certificates.k8s.io/v1`, a cluster-scoped resource) fails for a user or service account that otherwise appears to have certificate-related access. The approval is rejected with a `Forbidden` error of the form `certificatesigningrequests.certificates.k8s.io "csr-xxx" is forbidden: user not permitted to approve requests with signerName "<signerName>"`, where `<signerName>` is the signer named on the CSR (for example `kubernetes.io/kube-apiserver-client-kubelet`). The error specifically calls out the signer name rather than a generic access denial.

## Root Cause

CSR approval is gated by a dedicated authorization check on a virtual `signers` resource rather than on the `certificatesigningrequests` resource alone. The `signers` resource lives only in apiGroup `certificates.k8s.io` as an RBAC authorizer construct: it does not appear among the cluster's API resources — only `certificatesigningrequests` is listed there — and exists purely so RBAC can gate approval per signer.

The grant that authorizes approval takes the shape `apiGroups: [certificates.k8s.io]`, `resources: [signers]`, `verbs: [approve]`, with `resourceNames` pinning the signer. The `resourceNames` list must contain the exact, literal `signerName` string of the CSR being approved; approval is authorized only for the signer(s) named there.

A role whose `signers` rule does not list the CSR's `signerName` under `resourceNames` is unauthorized to approve that CSR, which is the mechanism behind the `user not permitted to approve requests with signerName` denial. A wildcard or an omitted `signerName` does not authorize approval of any signer — each `signerName` to be approved must be listed explicitly. Default per-signer approver ClusterRoles ship for the well-known signers, each scoped to a single signer (for example, the kubelet-serving approver role names only `kubernetes.io/kubelet-serving` and is a separate role from the kubelet-client approver).

## Resolution

Grant approval through a custom `ClusterRole` that carries the complete set of rules the approval flow requires. Beyond `approve` on the signer, the role needs `get`/`list`/`watch` on `certificatesigningrequests`, `update` on both the `certificatesigningrequests/approval` and `certificatesigningrequests/status` subresources, and `create` on `subjectaccessreviews` in apiGroup `authorization.k8s.io` (the SubjectAccessReview API, `authorization.k8s.io/v1`, that the signer authorizer issues during approval). Each `signerName` that should be approvable must be listed in the `resourceNames` of the `signers` rule.

The following `ClusterRole` authorizes approval of CSRs for the `kubernetes.io/kube-apiserver-client-kubelet` signer; add further `resourceNames` entries to cover additional signers:

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

Bind the `ClusterRole` to the user or service account with a `ClusterRoleBinding`, then retry the approval:

```bash
kubectl certificate approve csr-xxx
```

The single most common cause of the denial is a `signers` rule whose `resourceNames` omits the CSR's exact `signerName`; correcting that one field — to the literal signer string, with no wildcard — is what authorizes the approval.

## Diagnostic Steps

First read the CSR to obtain the exact `signerName` that the `resourceNames` entry must match:

```bash
kubectl get csr csr-xxx -o jsonpath='{.spec.signerName}'
```

Inspect the requesting subject's effective rules and confirm the `signers` rule lists that literal signer string under `resourceNames`. The `update` permission on the approval subresource can be checked directly, and that check is reliable:

```bash
kubectl auth can-i update certificatesigningrequests/approval
```

The signer-approval permission is harder to verify mechanically. `kubectl auth can-i approve signers --subresource=<signerName>` runs and returns a yes/no verdict, but its output is unreliable for confirming this grant: it emits a warning that the server has no resource type `signers`, and an impersonation-based check (`--as=<user>`) can return `yes` independent of whether the impersonated subject actually holds the signerName-scoped grant. Treat the `can-i` verdict as inconclusive here and confirm signer approval by reading the ClusterRole's rules directly instead:

```bash
kubectl auth can-i approve signers --subresource=kubernetes.io/kube-apiserver-client-kubelet
```

Because the `auth can-i` probe cannot confirm the signer grant, verify it by reading the bound `ClusterRole` directly and checking that the `signers` rule's `resourceNames` contains the CSR's exact `signerName`; a missing or mismatched entry is the authoritative explanation for the `Forbidden` denial:

```bash
kubectl get clusterrole csr-approver -o jsonpath='{.rules}'
```
