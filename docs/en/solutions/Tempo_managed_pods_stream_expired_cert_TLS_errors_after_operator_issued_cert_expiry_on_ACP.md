---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500621
---

# Tempo-managed pods stream expired-cert TLS errors after operator-issued cert expiry on ACP

## Issue

On Alauda Container Platform (kubernetes v1.34.5, ACP install bundle `bundle-versions-v4.3.0`), tracing components deployed by a Tempo-operator-managed stack can stream continuous TLS handshake failures once the operator-issued serving certificates carried in their mounted `kubernetes.io/tls` Secrets pass their `not-after` timestamp. A Kubernetes TLS Secret of this type embeds an x509 certificate in its base64-encoded `tls.crt` field whose `not-before` / `not-after` validity window is readable directly from the Secret on ACP, with the same upstream type and PEM shape. When the workload inside such a Pod presents that certificate during a TLS handshake after `not-after` has passed, the peer's golang TLS stack rejects the handshake and surfaces the standard `x509: certificate has expired or is not yet valid` error string emitted by the `crypto/tls` / `crypto/x509` standard library — unchanged on any distribution.

## Root Cause

Long-running server processes that read their serving certificate from a mounted Secret at process start do not, by themselves, observe in-place rotation of that Secret — they keep presenting the certificate material they originally loaded. On Pod re-creation, however, the kubelet re-reads the referenced Secret from the API server at volume-mount time, so a freshly created Pod loads the current (rotated) `tls.crt` content from the underlying Secret object. The expired-handshake error itself remains the stdlib golang `x509: certificate has expired or is not yet valid` form, so it survives unchanged when the same condition occurs on ACP.

## Resolution

Trigger a Pod-level restart of the affected tracing components so that the kubelet re-mounts the referenced Secret on the recreated Pods and they load the rotated certificate material from the API server at mount time. Deleting the affected Pods via a label selector that targets the operator-managed workloads lets the owning controllers recreate them, after which the new Pods read the current `tls.crt` from the API server during their volume mount and the handshake errors against the rotated certificate stop appearing.

## Diagnostic Steps

Enumerate the candidate TLS secrets in the namespace where the tracing stack is deployed — `kubernetes.io/tls`-typed Secrets follow the standard upstream shape on ACP, so a vanilla `kubectl get secret` listing surfaces them and a simple `grep tls` narrows the list:

```bash
kubectl get secret -n <tempo-namespace> | grep tls
```

For each candidate, dump the Secret as YAML and read its embedded validity window — `not-before` / `not-after` are present on the encoded certificate and are accessible through the same `kubectl get secret -o yaml` pipeline on ACP because the Secret type and PEM shape are unchanged from upstream Kubernetes:

```bash
kubectl get secret -n <tempo-namespace> <secret-name> -o yaml
```

Decode the `tls.crt` field with `base64 -d | openssl x509 -noout -dates` when the validity window is not visible directly in the YAML; the dates read from the certificate confirm whether the Secret currently mounted into the Tempo-managed Pods has passed its expiry. Cross-check the affected Pod's logs for the standard golang TLS error string — the `x509: certificate has expired or is not yet valid` form is what the receiving peer prints once the condition is in effect:

```bash
kubectl logs -n <tempo-namespace> <pod-name> | grep -E 'expired|has expired'
```
