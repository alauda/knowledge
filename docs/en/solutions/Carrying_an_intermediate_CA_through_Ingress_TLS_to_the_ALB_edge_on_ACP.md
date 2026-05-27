---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Carrying an intermediate CA through Ingress TLS to the ALB edge on ACP

## Issue

On Alauda Container Platform (Kubernetes `v1.34.5`, ALB2 `v4.3.1` running in `cpaas-system` with IngressClass `global-alb2` and controller `cpaas.io/alb2`), an HTTPS Ingress backed by a `kubernetes.io/tls` Secret terminates at the ALB edge, and the certificate chain the ALB presents to clients is determined entirely by the Secret's `tls.crt` paired with `tls.key`. When the issuing CA is an intermediate, clients that trust only the root see chain-validation errors because the edge does not append any other key from the Secret to the served chain by default.

## Root Cause

The `networking.k8s.io/v1` Ingress API exposes only `hosts` and `secretName` under each `spec.tls[*]` entry; there is no `caCertificate`, `caBundle`, or similar field at the Ingress layer through which an intermediate could be delivered. The same shape on ACP means the Ingress object itself has no carrier for CA material — any CA bundle must travel inside the referenced Secret. The `kubectl create secret tls` command surfaces only `--cert` and `--key` for certificate material, so the CLI alone cannot place a separate CA entry into the Secret. On the serving side, the ALB Frontend resource exposes a single `certificate_name` reference for HTTPS and has no separate CA-bundle field that would cause a `ca.crt` key inside the referenced Secret to be appended to the served chain.

## Resolution

Deliver the intermediate CA to clients by concatenating the intermediate-CA PEM into the leaf certificate file so the Secret's `tls.crt` carries the full chain (leaf first, then intermediate) before the Secret is created; this matches the upstream Ingress contract and is what the ALB edge serves as the certificate chain.

Build the full-chain PEM and create the Secret with `kubectl` (note that the CLI accepts only the cert and key paths):

```bash
cat leaf.crt intermediate.crt > fullchain.crt

kubectl -n <app-namespace> create secret tls my-tls \
  --cert=fullchain.crt \
  --key=leaf.key
```

If a `ca.crt` entry is also required inside the Secret (for example, for workloads that mount the Secret and read `ca.crt` for their own trust store), author the Secret as a YAML manifest with `ca.crt` placed under `.data` alongside `tls.crt` and `tls.key`, then apply it; this is the only path to populate `ca.crt`, because the `kubectl create secret tls` flag surface has no equivalent option:

```yaml
apiVersion: v1
kind: Secret
type: kubernetes.io/tls
metadata:
  name: my-tls
  namespace: <app-namespace>
data:
  tls.crt: <base64 of leaf+intermediate PEM>
  tls.key: <base64 of private key PEM>
  ca.crt: <base64 of CA PEM>
```

Reference the Secret from the Ingress under `spec.tls[*].secretName`; only `hosts` and `secretName` are accepted there, so no additional Ingress-side field is needed or available to carry the CA:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: <app-namespace>
spec:
  ingressClassName: global-alb2
  tls:
    - hosts:
        - app.example.com
      secretName: my-tls
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  number: 8080
```

Because the ALB Frontend in `cpaas-system` carries only `certificate_name` for HTTPS and has no separate CA-bundle field, the full-chain PEM inside the Secret's `tls.crt` is the served chain — clients with only the root in their trust store can then build the chain through the embedded intermediate.

## Diagnostic Steps

Inspect what the Secret actually carries before debugging client-side trust errors; the keys present under `.data` are what the platform sees, and only `tls.crt` + `tls.key` participate in what the ALB edge presents:

```bash
kubectl -n <app-namespace> get secret my-tls \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl crl2pkcs7 -nocrl \
  -certfile /dev/stdin | openssl pkcs7 -print_certs -noout
```

The output should list the leaf certificate followed by the intermediate; a single certificate indicates the chain was not concatenated into `tls.crt` and the served chain is leaf-only. Confirm the same from a client perspective by fetching the chain the ALB serves on the Ingress hostname:

```bash
echo | openssl s_client -connect app.example.com:443 -servername app.example.com -showcerts 2>/dev/null | \
  openssl crl2pkcs7 -nocrl -certfile /dev/stdin | openssl pkcs7 -print_certs -noout
```

If the served chain is still leaf-only after rebuilding `tls.crt`, verify the Ingress points at the updated Secret via `spec.tls[*].secretName` (the only Ingress-side TLS field besides `hosts`) and re-create the Secret so ALB picks up the new `tls.crt` content.
