---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Automating ingress TLS certificate renewal with cert-manager and an internal CA on ACP

## Issue

On Alauda Container Platform, ingress endpoints that terminate TLS need certificates that are issued and rotated without manual intervention. Operators who do not want to depend on an external public CA can stand up an internal CA inside the cluster and have cert-manager mint and auto-renew the leaf certificates that back the ingress TLS secrets. cert-manager is available on ACP: the `certificates`, `clusterissuers`, `issuers`, and `certificaterequests` custom resources in the `cert-manager.io` group are all present, with storage version `v1`, so every resource in this workflow uses `apiVersion: cert-manager.io/v1`. The cert-manager controller runs from image `cert-manager-controller:v1.17.18-v4.3.1` (ACP cert-manager plugin chart `cert-manager-v4.3.1`) in the `cert-manager` namespace.

## Resolution

Bootstrap the trust chain with a self-signed `ClusterIssuer`. A `ClusterIssuer` whose spec carries `selfSigned: {}` acts as a self-signed root that signs a bootstrap certificate without any external CA, which is the standard cert-manager form for seeding an internal chain.

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-bootstrap
spec:
  selfSigned: {}
```

Issue the CA certificate from that self-signed issuer. A `Certificate` with `spec.isCA: true` issued by the self-signed `ClusterIssuer` produces a CA key pair, which cert-manager writes to the secret named by `spec.secretName` as a `kubernetes.io/tls` secret holding `tls.crt` and `tls.key`.

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: internal-ca
  secretName: ca-root-secret
  privateKey:
    rotationPolicy: Always
  issuerRef:
    name: selfsigned-bootstrap
    kind: ClusterIssuer
    group: cert-manager.io
```

Set `privateKey.rotationPolicy: Always` on the CA `Certificate` so that a fresh private key matching the configured requirements is generated whenever a re-issuance occurs, rather than the existing key being reused; the field is an enum of `{Never, Always}` and defaults to `Never`.

Promote the CA key pair to a CA-type `ClusterIssuer`. A CA-type `ClusterIssuer` references the existing CA key pair through `spec.ca.secretName` and uses it to sign certificates requested against it; a live CA-type `ClusterIssuer` on the cluster reports status reason `KeyPairVerified` once its signing CA is verified.

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca-issuer
spec:
  ca:
    secretName: ca-root-secret
```

Request the leaf ingress certificate from the CA-type issuer. A `Certificate` referencing the CA `ClusterIssuer` through `issuerRef` (`kind: ClusterIssuer`, `group: cert-manager.io`) is issued a leaf certificate that cert-manager writes to a `kubernetes.io/tls` secret named by `spec.secretName`, carrying `tls.crt`, `tls.key`, and `ca.crt`. The leaf `Certificate`'s `spec.dnsNames` and `spec.commonName` populate the SAN and CN entries of the issued certificate.

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: custom-ingress-tls
  namespace: my-app
spec:
  secretName: custom-ingress-tls
  commonName: app.example.com
  dnsNames:
    - app.example.com
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io
```

Bind the issued TLS secret to an ingress through the standard Kubernetes `Ingress` resource. The `spec.tls[].secretName` field references the same `kubernetes.io/tls` secret that the leaf `Certificate` produces, so the ingress terminates TLS with the cert-manager-managed certificate for the listed hosts.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: my-app
spec:
  tls:
    - hosts:
        - app.example.com
      secretName: custom-ingress-tls
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
                  number: 80
```

Renewal is handled by cert-manager without manual reissue: it renews a `Certificate` ahead of expiry and refreshes the contents of the TLS secret in place. On a live leaf certificate cert-manager populates the renewal status fields — `status.renewalTime` is computed from the certificate's `notAfter` minus its `renewBefore` window, and the revision counter is bumped when the secret is refreshed. Because the ingress reads the certificate from the bound secret, the rotated material is served without changing the `Ingress` definition.

## Diagnostic Steps

Confirm the cert-manager CRDs are present and resolve to the expected group and version before applying any of the resources above:

```bash
kubectl get crd certificates.cert-manager.io clusterissuers.cert-manager.io \
  issuers.cert-manager.io certificaterequests.cert-manager.io
```

Check that the CA-type `ClusterIssuer` has verified its signing key pair; a ready issuer reports the `KeyPairVerified` reason in its status conditions:

```bash
kubectl get clusterissuer internal-ca-issuer -o yaml
```

Inspect the leaf `Certificate` to confirm its issued SAN/CN inputs and its scheduled renewal. The `spec.dnsNames` and `spec.commonName` are the SAN and CN inputs cert-manager writes into the leaf, and `status.renewalTime` together with the revision counter shows the next scheduled renewal and how many times the secret has been refreshed:

```bash
kubectl get certificate custom-ingress-tls -n my-app \
  -o jsonpath='{.spec.dnsNames}{"\n"}{.status.renewalTime}{"\n"}{.status.revision}{"\n"}'
```

Verify the resulting TLS secret has the expected `kubernetes.io/tls` type and that its data carries the `tls.crt`, `tls.key`, and `ca.crt` keys before binding it into the `Ingress`; the command below prints the secret type followed by the list of key names:

```bash
kubectl get secret custom-ingress-tls -n my-app \
  -o json | jq '{type, keys: (.data | keys)}'
```
