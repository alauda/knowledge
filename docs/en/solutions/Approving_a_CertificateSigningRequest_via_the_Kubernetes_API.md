---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500030
---

# Approving a CertificateSigningRequest via the Kubernetes API

## Issue

A CertificateSigningRequest (CSR) needs to be approved programmatically — for example from a CI job, a webhook handler, or an automation controller — and shelling out to `kubectl certificate approve` is not a viable option. The standard `kubectl` admin verb is missing in some build environments, the toolchain only carries an HTTP client, or the workflow needs to attach extra auditable metadata to the approval call.

## Resolution

Approve the CSR by `PATCH`ing the `/approval` subresource of the `certificates.k8s.io/v1` API directly. The subresource accepts a strategic-merge or `merge-patch+json` body that flips the `Approved` condition to `True`. The kube-apiserver then routes the change through the same admission and audit chain that `kubectl certificate approve` uses, so the result is identical (and, importantly, a downstream signer such as `kube-controller-manager` will then issue the cert).

### 1. Pick an identity that holds the approve permission

Approving a CSR is a separate RBAC verb (`approve`) on the `signers` resource. The kube-controller-manager built-in roles already grant it for cluster-scoped signers; for a custom automation account, bind it explicitly:

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

Bind the role to the ServiceAccount or user that will drive the approval. Without the `approve` verb on the matching `signers` resourceName the kube-apiserver returns `Forbidden` even if the patch payload is well-formed.

### 2. Obtain a bearer token for that identity

For a ServiceAccount-based automator, request a short-lived token:

```bash
kubectl create token csr-approver-sa -n automation --duration=10m
```

Capture the output into the `TOKEN` shell variable. Avoid long-lived static tokens for this verb; the principal can hand a TLS identity to anyone who asks once it is approved.

### 3. PATCH the `/approval` subresource

The condition list submitted on `/approval` replaces the existing condition slice; include any condition that should remain in the request body. For a fresh approval one entry is sufficient:

```bash
APISERVER="https://kubernetes.default.svc"   # or the external API URL
CSR_NAME="my-pending-csr"

curl -sk -X PATCH \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/merge-patch+json" \
  --data '{"status":{"conditions":[{"type":"Approved","status":"True","reason":"AutoApprovedByCI","message":"approved by csr-approver-sa"}]}}' \
  "${APISERVER}/apis/certificates.k8s.io/v1/certificatesigningrequests/${CSR_NAME}/approval"
```

Notes:
- The path ends in `/approval` — patching the parent CSR object directly will not flip the condition because approval lives on a dedicated subresource.
- Use `merge-patch+json` rather than `strategic-merge-patch+json`. Strategic-merge for the condition list does not honor a positional merge key on this type and silently appends instead of replacing.
- `reason` and `message` are surfaced in the audit log and on `kubectl describe csr <name>`. Populate them with the automation's identity so a later operator can answer "who approved this and why".

### 4. Confirm the approval

```bash
kubectl get csr "${CSR_NAME}" -o jsonpath='{.status.conditions[?(@.type=="Approved")].status}'
```

The expected output is `True`. The signer controller will then issue the certificate; observe `.status.certificate` becoming a non-empty base64 blob shortly after.

## Diagnostic Steps

If the PATCH returns `403 Forbidden`, verify both the namespace-less RBAC binding and the `signerName` of the CSR:

```bash
kubectl get csr "${CSR_NAME}" -o jsonpath='{.spec.signerName}'
kubectl auth can-i approve signers/<signerName> --as=system:serviceaccount:automation:csr-approver-sa
```

If the PATCH returns `200 OK` but `.status.certificate` stays empty, the issue is at the signer side: an automated signer such as kube-controller-manager only signs CSRs for signer names it is configured to handle (`kubernetes.io/kube-apiserver-client-kubelet`, `kubernetes.io/kubelet-serving`, `kubernetes.io/kube-apiserver-client`). For custom signer names a separate signer controller must be running.

If approval needs to be denied instead, submit the same call with `"type":"Denied"` (and optionally include the previous condition entries to keep them intact). Once a CSR carries a `Denied` condition the signer will not issue, even if a later request adds an `Approved` condition.
