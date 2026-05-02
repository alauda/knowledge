---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500007
---
## Overview

Applications running in the cluster increasingly require TLS for service-to-service traffic: mesh sidecars, user-facing gateways, database drivers with `sslmode=verify-full`, and compliance-driven policies that disallow plaintext between pods. Operators want this to be automatic — certificates issued per service, rotated before expiry, and trustable by other workloads without hand-distributing CA bundles.

ACP delivers this through **cert-manager**. cert-manager owns the `Certificate` CRD and a set of `Issuer` / `ClusterIssuer` resources that describe where certificates come from (an internal CA, HashiCorp Vault, an ACME endpoint, etc.). A single `Certificate` object becomes a `Secret` full of `tls.crt` / `tls.key` / `ca.crt`, which the application mounts.

## Resolution

The workflow is: pick an issuer once, then let `Certificate` resources drive every service cert.

### Create a Cluster-Wide Internal CA Issuer

For internal service-to-service TLS, an in-cluster self-signed CA is the simplest pattern. It mirrors what platform-managed "service serving cert" operators do, and gives you a CA that every workload can trust without reaching out to external infrastructure.

```yaml
# 1. One-shot self-signed issuer used only to mint the CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-bootstrap
spec:
  selfSigned: {}
---
# 2. A long-lived root Certificate signed by the bootstrap issuer
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: cluster-internal-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: cluster-internal-ca
  subject:
    organizations: [internal]
  duration: 87600h0m0s        # 10 years
  privateKey:
    algorithm: ECDSA
    size: 256
  secretName: cluster-internal-ca
  issuerRef:
    name: selfsigned-bootstrap
    kind: ClusterIssuer
---
# 3. The day-to-day issuer: sign workload certs with the root CA above
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: cluster-internal
spec:
  ca:
    secretName: cluster-internal-ca
```

Apply once per cluster. Every subsequent workload cert refers to `cluster-internal`.

### Issue a Certificate for a Service

Create a `Certificate` alongside the Service. The DNS names should match how the service is addressed in-cluster:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: app-tls
  namespace: team-a
spec:
  secretName: app-tls                  # produced Secret with tls.crt / tls.key / ca.crt
  duration: 2160h0m0s                  # 90 days
  renewBefore: 720h0m0s                # rotate 30 days before expiry
  dnsNames:
    - app.team-a.svc
    - app.team-a.svc.cluster.local
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: cluster-internal
    kind: ClusterIssuer
```

Within a few seconds cert-manager reconciles a `Secret/app-tls` containing the leaf certificate, its private key, and the issuing CA. Rotation happens automatically `renewBefore` the expiry; no human touches the secret.

### Mount the Certificate into a Pod

```yaml
spec:
  volumes:
    - name: tls
      secret:
        secretName: app-tls
        defaultMode: 0400
  containers:
    - name: app
      volumeMounts:
        - name: tls
          mountPath: /etc/tls
          readOnly: true
      env:
        - name: TLS_CERT
          value: /etc/tls/tls.crt
        - name: TLS_KEY
          value: /etc/tls/tls.key
```

If your runtime does not hot-reload TLS material, pair the mount with a sidecar like `reloader` — which watches the Secret and performs a rolling restart on change — rather than guessing how long a pod's cache will hold the old cert.

### Let Clients Trust the CA

Distribute the CA once and every workload that needs to talk to the service can validate its certificate without extra configuration.

```bash
# Export the in-cluster CA bundle
kubectl -n cert-manager get secret cluster-internal-ca -o jsonpath='{.data.ca\.crt}' \
  | base64 -d > cluster-internal-ca.crt

# Distribute as a ConfigMap to each namespace that needs to trust it
kubectl -n team-a create configmap cluster-internal-ca \
  --from-file=ca.crt=cluster-internal-ca.crt
```

Clients mount the ConfigMap and point their HTTP/SQL/gRPC client at that file as their trust anchor.

### Plan for External Services

For services exposed outside the cluster (public APIs, mTLS with third parties), swap the `cluster-internal` ClusterIssuer for an ACME-based one (Let's Encrypt, ZeroSSL) or an external PKI bridge. The workload-side `Certificate` object is otherwise unchanged — this is the main reason cert-manager is worth standardising on over one-off certificate scripts.

## Diagnostic Steps

Check cert-manager is healthy:

```bash
kubectl -n cert-manager get pod
kubectl get clusterissuer
kubectl get certificate -A
```

If a Certificate is stuck on `Issuing`:

```bash
kubectl -n team-a describe certificate app-tls
kubectl -n team-a get certificaterequest
kubectl -n cert-manager logs deploy/cert-manager --tail=200
```

Confirm the produced Secret contains all three keys and the CA chains up to your root:

```bash
kubectl -n team-a get secret app-tls -o jsonpath='{.data.tls\.crt}' | base64 -d \
  | openssl x509 -noout -subject -issuer -dates
kubectl -n team-a get secret app-tls -o jsonpath='{.data.ca\.crt}'  | base64 -d \
  | openssl x509 -noout -subject
```

Verify a client can actually validate the cert with the distributed CA bundle:

```bash
kubectl -n team-a run curl --rm -it --image=curlimages/curl:8.10.1 \
  --restart=Never -- \
  sh -c 'curl --cacert /etc/ssl/ca.crt https://app.team-a.svc/healthz -v'
```

If validation fails with `self-signed certificate in certificate chain`, the pod is using the host's default trust store instead of your CA bundle; confirm the client is reading the right `--cacert` path and the ConfigMap was mounted correctly.
