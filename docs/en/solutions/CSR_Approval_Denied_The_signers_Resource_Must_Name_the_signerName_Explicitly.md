---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A user with a purpose-built `ClusterRole` that was intended to let them approve CertificateSigningRequests still gets a `Forbidden` response when they run `kubectl certificate approve`:

```text
Error from server (Forbidden):
  certificatesigningrequests.certificates.k8s.io "csr-xyz" is forbidden:
  user not permitted to approve requests with signerName
  "kubernetes.io/kube-apiserver-client-kubelet"
```

The role is clearly in effect — the user can `get` and `list` CSRs, can read their details, and can even `update` the `/status` subresource. But the approve call is refused with a message that specifically names the `signerName` carried by the request.

## Root Cause

Kubernetes CSR approval is gated by an extra authorization step that does not apply to other resources. In addition to the permission on the CSR object itself (`update` on `certificatesigningrequests/approval`), the API server also requires that the caller have `approve` permission on the virtual resource **`signers`** — *limited to the specific signerName being approved*.

Concretely, the admission flow is:

1. The API server reads the CSR's `spec.signerName` (for kubelet client certificates this is `kubernetes.io/kube-apiserver-client-kubelet`; for kubelet serving certificates it is `kubernetes.io/kubelet-serving`; for user-defined signers it is whatever the CSR creator wrote).
2. The API server evaluates a SubjectAccessReview: *"Can this subject `approve` on the virtual resource `signers`, with `resourceNames` containing the exact signerName from step 1?"*
3. Only if that check returns allowed does the approval proceed.

A `ClusterRole` that grants broad permissions on `certificatesigningrequests` without a corresponding rule for `signers` with the right `resourceNames` passes the first authorization check (the CSR object is reachable) and fails the second (the signerName is not whitelisted). The error message names the signer exactly to make that second failure easy to diagnose.

The same mechanism applies to `sign` on `signers` — a signer controller has to have that verb against the signerName it will sign for. Most operators only need `approve`; signers are a smaller set.

## Resolution

### Build a ClusterRole that names every signer the role should cover

The rule set below lets a holder list CSRs, update status for bookkeeping, approve for two built-in signers, and issue SubjectAccessReviews (useful for tooling that checks its own permissions before acting). Adjust `resourceNames` to the exact set of signers the role should cover — add `kubernetes.io/kube-apiserver-client` for generic client certs, or a custom signer name for a cluster-local CA.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: csr-approver
rules:
  # 1. Read CSR objects.
  - apiGroups: [certificates.k8s.io]
    resources: [certificatesigningrequests]
    verbs: [get, list, watch]

  # 2. Update the approval / status subresources.
  - apiGroups: [certificates.k8s.io]
    resources:
      - certificatesigningrequests/approval
      - certificatesigningrequests/status
    verbs: [update]

  # 3. The signer gate — explicitly list every signerName the role may
  #    approve requests for. Without this rule, the approve call is
  #    refused even if rule (2) permits the subresource update.
  - apiGroups: [certificates.k8s.io]
    resources: [signers]
    resourceNames:
      - kubernetes.io/kube-apiserver-client-kubelet
      - kubernetes.io/kubelet-serving
      # - kubernetes.io/kube-apiserver-client    # generic client certs
      # - my.example.com/internal                # custom cluster signer
    verbs: [approve]

  # 4. Optional: let the role-holder issue SubjectAccessReviews so tooling
  #    can pre-flight whether it is allowed to approve before attempting.
  - apiGroups: [authorization.k8s.io]
    resources: [subjectaccessreviews]
    verbs: [create]
```

Apply and bind to the target principal:

```bash
kubectl apply -f csr-approver.yaml

cat <<'EOF' | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: csr-approver-binding
subjects:
  - kind: User
    name: alice@example.com
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: csr-approver
  apiGroup: rbac.authorization.k8s.io
EOF
```

`ServiceAccount` subjects follow the same pattern — change `kind: User` to `kind: ServiceAccount` with a `namespace` field. `Group` subjects (for example, federating to an external IdP group) replace the subject list altogether.

### Verify the signer gate specifically

A generic `kubectl auth can-i approve certificatesigningrequests` does **not** exercise the signer gate — it only checks the CSR object verb. The signer check needs a resource-name-qualified query:

```bash
kubectl auth can-i approve signers \
  --subresource='' \
  --resource-name=kubernetes.io/kube-apiserver-client-kubelet
```

Return value `yes` means the signer gate will pass for that exact signerName. Repeat for every signerName the role should cover. If a CSR in production carries a signerName not in the role's `resourceNames`, its approval will be rejected regardless of what the other rules say.

Separately, some platforms ship ClusterRoleBindings that grant `system:authenticated` broad access (for example a default "view" or "self-readonly" role). Those bindings do not themselves grant the signer-approve verb, but they can obscure test results when probing with `kubectl auth can-i --as=<user>` — the probe sees the aggregate of the user's bindings. Use a narrow `--as=<service-account>` in a test namespace to confirm the `csr-approver` role's effect in isolation.

### Principle of least privilege

List only the signerNames the role actually needs. `resourceNames: ["*"]` would grant approve on every signer in the cluster — including any custom signer added later — and is rarely what is intended. If a role legitimately needs to approve every signer, list them explicitly and update the role when a new signer is introduced.

## Diagnostic Steps

When an approval call is rejected, capture the signerName the CSR carries and compare it against the role's `resourceNames`:

```bash
kubectl get csr <csr-name> -o jsonpath='{.spec.signerName}{"\n"}'
```

Common built-in signer names:

| signerName | Used for |
|---|---|
| `kubernetes.io/kube-apiserver-client-kubelet` | Kubelet client certificates rotated via CSR |
| `kubernetes.io/kubelet-serving` | Kubelet serving certificates (metrics / logs endpoint) |
| `kubernetes.io/kube-apiserver-client` | Generic in-cluster client certs |
| `kubernetes.io/legacy-unknown` | Any signer not otherwise specified |

Custom signers (namespace-local CAs, external signers) carry whatever signerName the CSR creator wrote; they must be named literally in the approver's `resourceNames`.

Inspect the role actually in effect:

```bash
kubectl get clusterrole csr-approver -o yaml
```

Confirm a rule exists with `apiGroups: [certificates.k8s.io]`, `resources: [signers]`, `verbs: [approve]`, and `resourceNames:` listing the needed signerName. A rule that has every part right except `resourceNames` is the exact shape that produces the error message in the issue.

After fixing the role, re-run the approval:

```bash
kubectl certificate approve <csr-name>
kubectl get csr <csr-name> -o jsonpath='{.status.conditions}{"\n"}' | jq
```

A successful approval adds an `Approved` condition; the signer controller then issues the certificate and the `status.certificate` field fills in.
