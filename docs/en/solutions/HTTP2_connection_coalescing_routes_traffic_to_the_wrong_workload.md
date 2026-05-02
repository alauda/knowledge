---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# HTTP/2 connection coalescing routes traffic to the wrong workload
## Issue

After visiting one HTTPS application, every other ingress hostname covered by the same wildcard server certificate appears to serve content from the first one — or returns `404 / Page Not Found` even though each backend is healthy on its own. Common variants:

- The platform web console becomes unreachable after first visiting an in-cluster Keycloak, Service Mesh, or security-scanner UI on the same cluster.
- Two distinct application hostnames (`a.apps.example.com`, `b.apps.example.com`) intermittently swap their HTML responses depending on which one was visited first in the browser session.
- Opening an incognito window, switching browsers, or appending `--disable-http2` to the browser launch makes the symptom disappear.

This is a browser-side artefact of HTTP/2 connection coalescing, triggered when the cluster ingress fronts multiple hostnames with **TLS passthrough** (or any setup where one TLS certificate covers all of them) and the same wildcard certificate is presented for each request.

## Root Cause

[RFC 7540 §9.1.1](https://datatracker.ietf.org/doc/html/rfc7540#section-9.1.1) lets an HTTP/2 client reuse an open TLS connection for any other request whose `:authority` is covered by the certificate the server presented during the first handshake. So when the server cert carries `subjectAltName = *.apps.example.com`, a browser that already opened `https://a.apps.example.com` is permitted to push `https://b.apps.example.com` requests through the *same* TCP socket — the second request never re-runs SNI, never opens a new TLS session, and never gets the chance to land on a different backend.

For Layer 7 ingress that terminates TLS at the proxy and inspects the HTTP request, this is benign: the proxy reads `:authority` and routes to the right backend regardless. The problem only surfaces when the proxy is configured for **TLS passthrough** — the proxy can't read the request because it never decrypts it, so it has to pin every byte from the coalesced connection to the backend it picked at handshake time. That backend is usually the first hostname the browser loaded.

The same pattern explodes whenever a single certificate (typically the cluster's default wildcard or an organisation-wide wildcard) is reused across many otherwise-unrelated workloads exposed through passthrough ingresses.

## Resolution

Three workable fixes exist; pick by impact radius.

### Best fix — give each application its own non-wildcard certificate

A certificate whose `subjectAltName` matches exactly one hostname does not satisfy the coalescing precondition, so the browser is forced to open a fresh TLS session per host. Use ACP's certificate stack (cert-manager via the `Certificate for cert-manager` operator) to mint a per-host certificate and attach it to the Ingress / route:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: app-a-tls
  namespace: app-a
spec:
  secretName: app-a-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - a.apps.example.com   # exactly one — no wildcard
```

Then reference the resulting Secret from the application's Ingress (or the platform's ALB CR for tls-terminate use cases). This is the only fix that scales as more workloads are added — the symptom can never resurface.

### Pragmatic fix — terminate TLS at the proxy (re-encrypt or edge)

If the workloads can accept incoming traffic on plain HTTP from the cluster fabric or with a different in-cluster certificate, switch the ingress termination from passthrough to **edge** (proxy presents the cert, plain HTTP to backend) or **re-encrypt** (proxy terminates and re-establishes a separate TLS session to the backend, presenting an internal cert). At that point the ingress proxy can read `:authority` and route the coalesced connection's individual streams to different backends.

ACP's ALB Operator covers both modes through the standard Ingress object's `spec.tls` plus the ALB rule annotations:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-a
  namespace: app-a
  annotations:
    alb.alauda.io/backend-protocol: HTTPS    # re-encrypt
spec:
  tls:
    - hosts:
        - a.apps.example.com
      secretName: app-a-tls                  # public cert presented to client
  rules:
    - host: a.apps.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: app-a
                port:
                  number: 443
```

For backends that absolutely insist on TLS passthrough (mTLS-clients-to-pod, or proprietary protocols smuggled inside TLS), passthrough remains the only choice — fall back to the per-host certificate fix above.

### Disable HTTP/2 (last resort)

Disabling HTTP/2 on the affected ingress class forces clients into HTTP/1.1, which has no coalescing semantics. This works as a global panic-button, but loses head-of-line-blocking improvements and h2-specific multiplexing. Scope the change to the smallest ingress controller that contains the offending workloads, never to the whole cluster, unless every workload behind it has the same pathology.

## Diagnostic Steps

To confirm coalescing is the cause (not a routing or DNS bug), reproduce in a single browser instance:

1. Open `https://a.apps.example.com/` and let the page render.
2. In the **same** tab, navigate to `https://b.apps.example.com/`.
3. If `b` shows `a`'s content (or a `404 / Page Not Found`), connection coalescing is in play.

Confirm with `curl --http2`:

```bash
curl -v --http2 --resolve a.apps.example.com:443:<INGRESS_IP> https://a.apps.example.com/ \
   --next \
   --resolve b.apps.example.com:443:<INGRESS_IP> https://b.apps.example.com/
```

A coalesced session shows `Re-using existing connection!` on the second URL even though `:authority` differs. Re-running with `--http1.1` opens two distinct connections and the right backend answers each.

Check the certificate the ingress is presenting:

```bash
echo | openssl s_client -servername a.apps.example.com \
  -connect a.apps.example.com:443 2>/dev/null \
  | openssl x509 -noout -text | grep -A1 'Subject Alternative Name'
```

If the SAN is a wildcard (`DNS:*.apps.example.com`) and the affected hostname is covered by it, coalescing is possible. A leaf certificate that lists exactly the requested hostname is immune.

To enumerate every workload behind the same wildcard certificate, list ingresses and their referenced TLS secrets:

```bash
kubectl get ingress -A \
  -o custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,\
HOSTS:.spec.rules[*].host,SECRETS:.spec.tls[*].secretName \
  | column -t
```

Anything sharing a `secretName` is a coalescing peer; either give it its own cert or move it to a different ingress class.

For ALB-managed listeners specifically, inspect the running listener configuration to confirm passthrough vs re-encrypt mode:

```bash
kubectl -n cpaas-system get alb2 -o yaml \
  | yq '.items[].spec.config.listeners[] | {port, protocol, mode}'
```

A `mode: tls-passthrough` listener serving multiple hostnames through one certificate is the configuration that makes coalescing visible. Change it to `mode: terminate` (with backend-protocol HTTPS for re-encrypt) and re-test.
