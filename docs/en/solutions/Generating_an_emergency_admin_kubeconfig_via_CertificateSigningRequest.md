---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500014
---

# Minting a client certificate on ACP with the Kubernetes CSR API

## Issue

On Alauda Container Platform (Kubernetes `v1.34.5`), an administrator needs to mint a fresh client certificate suitable for authenticating to the kube-apiserver, using only the standard Kubernetes API. The `CertificateSigningRequest` resource (`certificates.k8s.io/v1`, kind `CertificateSigningRequest`, short name `csr`) is cluster-scoped, and a request submitted with `signerName: kubernetes.io/kube-apiserver-client` and the `client auth` usage asks that signer to issue a client certificate; once approved, the issued certificate is one that, per the signer's documented purpose, can be used to authenticate to the kube-apiserver. How that certificate's subject is then mapped to a Kubernetes user/group identity is determined by the cluster's authentication and RBAC configuration and is out of scope for this article.

## Root Cause

Requests against the `kubernetes.io/kube-apiserver-client` signer are never auto-approved by the kube-controller-manager, so a freshly submitted CSR for this signer stays pending until an authorized approver acts on it. A client-certificate request of this kind conventionally carries the `digital signature`, `key encipherment`, and `client auth` usages.

## Resolution

Submit a `CertificateSigningRequest` with the `kubernetes.io/kube-apiserver-client` signer name and the client-auth usages, embedding a base64-encoded PEM certificate signing request in `spec.request`. The optional `spec.expirationSeconds` field carries the requested validity duration of the issued certificate; in-tree signers honor that request only up to the cluster-wide maximum configured by `--cluster-signing-duration`, may issue a different (typically capped) duration, and reject any value below the minimum of 600 seconds. In the manifests and commands below, `admin-client` is a placeholder CSR name — substitute the metadata.name of the CSR you actually create:

```yaml
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: admin-client
spec:
  signerName: kubernetes.io/kube-apiserver-client
  request: <base64-encoded PEM CSR>
  expirationSeconds: 86400
  usages:
    - digital signature
    - key encipherment
    - client auth
```

Because this signer is never auto-approved, an authorized approver must approve the pending request before it is signed. Approval is recorded through the `certificatesigningrequests/approval` subresource, which is distinct from the `certificatesigningrequests/status` subresource:

```bash
kubectl certificate approve admin-client
```

After an `Approved` condition is present, the signer populates the issued certificate into `.status.certificate` via the `/status` subresource; the certificate is encoded in PEM format and is additionally base64-encoded when serialized as JSON or YAML. Read and decode it once the field is populated:

```bash
kubectl get csr admin-client \
  -o jsonpath='{.status.certificate}' | base64 -d > admin-client.crt
```

## Diagnostic Steps

Confirm the request reached the intended signer and inspect its approval state — the request remains pending until an approver acts, since this signer does not auto-approve:

```bash
kubectl get csr admin-client \
  -o jsonpath='{.spec.signerName}{"\n"}{.status.conditions}{"\n"}'
```

If `.status.certificate` is empty, verify an `Approved` condition is present: the signer only populates the certificate through the `/status` subresource after approval has been recorded through the separate `/approval` subresource. If the issued certificate's validity is shorter than the value placed in `spec.expirationSeconds`, that is expected — the signer honors the request only up to the cluster-wide `--cluster-signing-duration` and will not issue below the 600-second minimum.
