---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A TLS Secret created with `kubectl create secret tls` only carries `tls.crt` and `tls.key`. When a Secret is hand-built with an additional `ca.crt` key (the chain or backend CA the load balancer should trust on the upstream leg of a re-encrypt), that `ca.crt` is **not** automatically picked up by the Ingress controller's reencrypt logic — only `tls.crt` and `tls.key` get propagated to the underlying load-balancer object. The result: the platform load balancer terminates TLS in front of the workload but cannot validate the backend's certificate, and reencrypt fails.

The same pattern shows up regardless of which controller fronts the workload; it bites operators most often when an Ingress with `tls.secretName: <secret>` is used with a Secret that was prepared off-cluster and contains all three fields.

## Root Cause

The Kubernetes `kubernetes.io/tls` Secret schema defines two well-known keys:

- `tls.crt` — the certificate (and any chain) the server presents to clients.
- `tls.key` — the private key matching `tls.crt`.

`ca.crt` is *legal* in a `kubernetes.io/tls` Secret, but it is not part of the Ingress controller's TLS contract. The controller reads only `tls.crt` and `tls.key` to populate the front-end termination of the load balancer and silently ignores any `ca.crt` field. To control the **upstream** certificate validation (i.e. what the load balancer trusts when it re-establishes TLS to the backend pod) the controller needs a separate input: an explicit "destination CA" reference.

On ACP, the load balancer is **ALB** (`networking/operators/alb_operator`). ALB's reencrypt mode treats the front-end certificate (from the Ingress's `tls.secretName`) and the upstream CA bundle as **two separate inputs**, mirroring the well-known split that exists in most ingress controllers. Stuffing the CA into the Ingress TLS Secret as `ca.crt` will not make it appear in ALB's reencrypt configuration; the CA must either be folded into the certificate chain that ALB serves, or supplied through ALB's destination-CA annotation/Secret reference.

## Resolution

Two complementary techniques cover almost every scenario:

### Option A: fold the chain into `tls.crt`

If the requirement is "the load balancer must serve the full chain (leaf + intermediate(s)) to clients", concatenate the leaf certificate, the intermediate(s), and (optionally) the root into one `tls.crt` and recreate the Secret. The CLI's `--cert` flag accepts this concatenated bundle directly:

```bash
cat leaf.crt intermediate.crt root.crt > fullchain.crt
kubectl -n my-app create secret tls example-com-tls \
  --cert=fullchain.crt --key=tls.key
```

Reference this Secret from the Ingress as usual. ALB then serves the full chain to clients on the front-end. `ca.crt` does not need to be a separate field.

### Option B: tell ALB which CA to trust on the backend leg (reencrypt)

When the Ingress is annotated for reencrypt and the backend serves a certificate signed by an internal CA, ALB needs that CA explicitly. Provide it through ALB's destination-CA mechanism — typically an annotation on the Ingress that names a Secret containing the backend CA, for example:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend
  namespace: my-app
  annotations:
    # ALB-namespaced annotation: see ACP networking/operators/alb_operator
    # docs for the exact key. The value is the name of a Secret containing
    # only the backend CA(s) under a known key (commonly `ca.crt`).
    alb.networking.alauda.io/backend-ca-secret: backend-ca
spec:
  rules:
    - host: www.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend
                port: { number: 443 }
  tls:
    - hosts: [ www.example.com ]
      secretName: example-com-tls   # leaf+intermediate as in Option A
```

The companion Secret only needs the backend CA:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: backend-ca
  namespace: my-app
type: Opaque
data:
  ca.crt: <base64 of the backend CA PEM>
```

Confirm the exact annotation key against the ALB Operator documentation in `networking/operators/alb_operator`; the underlying behaviour (separate Secret for the upstream CA) is consistent across reencrypt-capable ingress controllers.

### Why a single combined Secret does not work

A frequent attempt is to drop `ca.crt` into the same `kubernetes.io/tls` Secret that holds `tls.crt`/`tls.key`, expecting the controller to pick all three apart. The Ingress object's `tls.secretName` reference is a *single* name; the controller's reencrypt code path reads at most two fields from it. Anything in `ca.crt` on that Secret is invisible to the load balancer. Splitting front-end material from backend-CA material into two Secrets — one for `tls.secretName`, one for the destination-CA annotation — keeps the contract explicit.

## Diagnostic Steps

Inspect what the Secret actually contains:

```bash
kubectl -n my-app get secret example-com-tls -o jsonpath='{.data}' \
  | jq 'keys'
# Expect ["tls.crt","tls.key"] — anything else is ignored by Ingress TLS.
```

Decode the front-end certificate and verify the chain length:

```bash
kubectl -n my-app get secret example-com-tls -o jsonpath='{.data.tls\.crt}' \
  | base64 -d | openssl crl2pkcs7 -nocrl -certfile /dev/stdin \
  | openssl pkcs7 -print_certs -noout | grep -E '^subject|^issuer'
```

A correctly built Option A bundle prints the leaf first, then each intermediate up to (but not necessarily including) the root.

Check what ALB is actually serving on the wire:

```bash
echo | openssl s_client -connect www.example.com:443 -servername www.example.com -showcerts 2>/dev/null \
  | awk '/BEGIN CERTIFICATE/{c++} {print}' \
  | grep -c 'BEGIN CERTIFICATE'
```

The count should match the number of certificates in the bundle. If only the leaf is returned, ALB is serving from the original (single-cert) Secret — re-apply Option A.

For Option B, validate the backend leg from inside the cluster:

```bash
kubectl -n my-app run tls-probe --rm -it --image=alpine \
  --restart=Never -- sh -c '
    apk add --no-cache openssl curl >/dev/null
    openssl s_client -connect frontend:443 -showcerts -CAfile /dev/null \
      </dev/null 2>/dev/null | openssl x509 -noout -issuer
  '
```

If the issuer is the internal CA, ensure that exact CA PEM is in the `backend-ca` Secret referenced by the destination-CA annotation; ALB's reencrypt log line will otherwise report `x509: certificate signed by unknown authority`.
