---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The cluster serves workloads over HTTPS using an internal (non-public) Certificate Authority. Manually issuing, rotating, and re-attaching the ingress certificate is error-prone: the wildcard expires, somebody forgets to rotate the private key along with it, or the renewal lands outside a maintenance window. The desired outcome is that the platform bootstraps its own internal CA, issues the wildcard certificate that fronts the ingress layer, and rotates everything on a timer with no manual touch-up.

## Root Cause

There is no bug; this is a configuration exercise. cert-manager is the standard Kubernetes component that manages `Issuer` / `ClusterIssuer` / `Certificate` / `CertificateRequest` objects and reconciles them into valid TLS `Secret` resources. ACP's `security/cert` surface exposes cert-manager in-cluster, so the pieces required for an internal-CA flow are already available; what is needed is a description of the right three CRs and where to attach the resulting secret on the ingress side.

## Resolution

### Preferred: ACP cert-manager + ALB for ingress termination

ACP's ingress layer is delivered by the **ALB Operator** (`networking/operators/alb_operator`). Instead of patching a monolithic ingress-controller spec with a new default certificate, the ALB's Ingress / Frontend resources reference a TLS secret directly. The full flow is:

1. **Bootstrap issuer — self-signed, cluster-scoped.** This issuer exists only to sign the first certificate (the Root CA). Once the Root CA exists, nothing else uses the bootstrap issuer.

   ```yaml
   apiVersion: cert-manager.io/v1
   kind: ClusterIssuer
   metadata:
     name: bootstrap-issuer
   spec:
     selfSigned: {}
   ```

2. **Root CA certificate.** The Root CA certificate lives in the `cert-manager` namespace so that the follow-up `ClusterIssuer` can reference its secret cluster-wide. `isCA: true` marks the resulting X.509 object as a CA (the `CA:TRUE` basic-constraint is set). `rotationPolicy: Always` forces a fresh private key on every renewal rather than reusing the old one.

   ```yaml
   apiVersion: cert-manager.io/v1
   kind: Certificate
   metadata:
     name: internal-root-ca
     namespace: cert-manager
   spec:
     commonName: internal-ca.example.com
     isCA: true
     secretName: ca-root-secret
     privateKey:
       algorithm: ECDSA
       size: 256
       rotationPolicy: Always
     issuerRef:
       name: bootstrap-issuer
       kind: ClusterIssuer
       group: cert-manager.io
   ```

3. **Internal CA ClusterIssuer.** The `ca:` issuer type wraps the Root CA secret and signs every subsequent certificate request with it.

   ```yaml
   apiVersion: cert-manager.io/v1
   kind: ClusterIssuer
   metadata:
     name: internal-ca-issuer
   spec:
     ca:
       secretName: ca-root-secret
   ```

4. **Wildcard certificate for the ingress domain.** The secret produced by this `Certificate` is the one the ALB will actually serve. Put it in a namespace the ALB can read (conventionally a dedicated ingress namespace, for example `cpaas-system` or whatever the ALB frontend's namespace is).

   ```yaml
   apiVersion: cert-manager.io/v1
   kind: Certificate
   metadata:
     name: ingress-wildcard-cert
     namespace: cpaas-system
   spec:
     isCA: false
     commonName: "apps.example.com"
     dnsNames:
       - "apps.example.com"
       - "*.apps.example.com"
     secretName: ingress-wildcard-tls
     privateKey:
       algorithm: ECDSA
       size: 256
       rotationPolicy: Always
     issuerRef:
       name: internal-ca-issuer
       kind: ClusterIssuer
       group: cert-manager.io
   ```

5. **Attach the secret to the ALB.** The ALB's Frontend (for HTTPS listeners) or Ingress (for HTTP-route style) references `ingress-wildcard-tls` by name. Example for a Kubernetes `Ingress` that the ALB is serving:

   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: Ingress
   metadata:
     name: platform-console
     namespace: cpaas-system
     annotations:
       # project.cpaas.io/alb-name matches the ALB CR that should pick this up;
       # replace with the actual ALB name in this cluster.
       project.cpaas.io/alb-name: cpaas-alb
   spec:
     tls:
       - hosts: ["apps.example.com", "*.apps.example.com"]
         secretName: ingress-wildcard-tls
     rules:
       - host: apps.example.com
         http:
           paths:
             - path: /
               pathType: Prefix
               backend:
                 service:
                   name: console-web
                   port:
                     number: 443
   ```

   On reconcile, the ALB controller loads the secret, programs the listener certificate, and on cert-manager renewals the new secret content is picked up without restarting the ALB pods.

Apply the four CRs in the order above (`kubectl apply -f <file>.yaml`), then wait for each `Certificate` to reach `Ready=True`:

```bash
kubectl get certificate -A -o wide
```

The last column shows renewal time. Once `ingress-wildcard-cert` is `Ready=True`, distribute the Root CA (`ca-root-secret` → `ca.crt` key) to clients that need to trust it, either as part of the platform's trust-store distribution or as a one-off out-of-band push.

### Fallback: vanilla in-cluster cert-manager against a generic Kubernetes Ingress

The same four CRs work unchanged against any in-cluster cert-manager installation — the `cert-manager.io` API is a single upstream CRD set. The only thing that changes is step 5: if the cluster uses a non-ALB ingress controller (in-cluster NGINX, Contour, Traefik), attach the secret via that controller's usual knob. For NGINX Ingress with its IngressController object, point the default-SSL-certificate field at the `ingress-wildcard-tls` secret; the cert-manager half of the pipeline is identical.

## Diagnostic Steps

Check the `Certificate` object for its condition and next renewal time:

```bash
kubectl -n cpaas-system describe certificate ingress-wildcard-cert
```

A healthy certificate shows:

```text
Conditions:
  Type    Status  Reason   Message
  Ready   True    Ready    Certificate is up to date and has not expired
Events:
  Normal  Issuing    ...   The certificate has been successfully issued
```

Confirm the secret was written and contains the expected keys:

```bash
kubectl -n cpaas-system get secret ingress-wildcard-tls \
  -o jsonpath='{.data}' | jq 'keys'
# -> ["ca.crt","tls.crt","tls.key"]
```

Inspect the served certificate from inside the cluster, bypassing DNS:

```bash
kubectl -n cpaas-system get svc
# pick the ALB service IP, then:
echo | openssl s_client -connect <alb-svc-ip>:443 \
  -servername apps.example.com 2>/dev/null | openssl x509 -noout -subject -issuer -dates
```

The `issuer=` line should reference `internal-ca.example.com` (the Root CA common name). If it still shows a previous default, the ALB has not picked up the secret — check the ALB controller pod logs:

```bash
kubectl -n cpaas-system logs -l app.kubernetes.io/name=alb
```

If the ALB never reconciled, confirm the Ingress is labeled or annotated to belong to the correct ALB frontend (the annotation key varies by ALB deployment; `kubectl describe ingress platform-console` shows what the controller matched on).

Force a renewal for a dry-run of the rotation path:

```bash
kubectl cert-manager renew -n cpaas-system ingress-wildcard-cert
```

A new secret version should appear within seconds and the ALB should serve it without service restart. If the ALB pods still serve the old certificate after a few minutes, capture `kubectl -n cpaas-system describe ingress platform-console` and the ALB controller logs around the renewal time — that is usually an annotation / secret-watch configuration issue rather than a cert-manager one.
