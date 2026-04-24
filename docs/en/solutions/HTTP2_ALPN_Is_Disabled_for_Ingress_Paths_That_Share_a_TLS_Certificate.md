---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A single `Ingress` object declares one host and multiple paths (for example, `/` and `/health`) under the same TLS secret. Exactly one of the paths — the one with `pathType: Exact` on `/` — negotiates HTTP/2 via ALPN on TLS; the other paths with `pathType: Prefix` or `pathType: ImplementationSpecific` fall back to HTTP/1.1. An `openssl s_client` / `curl -kv` probe to the prefix paths reports `No ALPN negotiated`:

```yaml
spec:
  ingressClassName: alb-default
  rules:
    - host: test-ingress-prefix.example.internal
      http:
        paths:
          - backend: { service: { name: test-ingress-prefix, port: { number: 80 } } }
            path: /
            pathType: Prefix
          - backend: { service: { name: test-ingress-prefix, port: { number: 80 } } }
            path: /health
            pathType: Prefix
  tls:
    - hosts: [test-ingress-prefix.example.internal]
      secretName: test-ingress-prefix-tls
```

```text
$ curl -kvv https://test-ingress-prefix.example.internal/health
...
 depth=0 CN=test-ingress-prefix.example.internal
 verify return:1
 No ALPN negotiated
```

## Root Cause

Ingress-to-route conversion behind an L7 router expands a single Ingress object with N rules into N internal route entries. Each of those route entries points at a TLS certificate. When the router observes that two or more route entries share the same certificate (same secret), it **disables HTTP/2 with TLS ALPN** for all of them. This is deliberate and is there to prevent a well-known HTTP/2 correctness hazard: **client connection coalescing**.

HTTP/2 clients are allowed by RFC 7540 §9.1.1 to reuse a single connection for any host that is *covered by the server certificate*. If a client opens a connection to `foo.example.com`, receives a cert valid for `*.example.com`, and later needs to talk to `bar.example.com`, it is permitted to route the `bar` request over the existing connection — provided the server's IP and cert match. When two different Ingress paths behind the same vhost are served by different backends but share a single cert, HTTP/2 coalescing can cause a client's request for one path to be mis-steered to the sibling path's backend, or to mix stream lifetimes across paths.

Routers that understand this hazard therefore refuse to advertise `h2` in ALPN for paths that share a certificate. The TLS handshake completes, but the negotiated application protocol stays at HTTP/1.1, which does not coalesce connections.

## Resolution

### Preferred path on ACP: ALB + explicit per-path Ingress objects

On ACP, the L7 ingress is ALB. ALB applies the same coalescing safeguard: if it detects two ingress rules that share a certificate, HTTP/2 is not enabled for them. The cleanest fix that stays inside plain Ingress semantics is to **stop sharing the certificate across paths by using one Ingress object per host/backend pair** — each with its own `tls.secretName`, even if the underlying cert is the same CA-issued cert for the same SAN:

```yaml
---
# One Ingress per backend; distinct secret names even if the cert contents match.
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: app-root }
spec:
  ingressClassName: alb-default
  rules:
    - host: app.example.internal
      http:
        paths:
          - { path: /, pathType: Prefix,
              backend: { service: { name: app-root, port: { number: 80 } } } }
  tls:
    - { hosts: [app.example.internal], secretName: app-root-tls }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: app-health }
spec:
  ingressClassName: alb-default
  rules:
    - host: app.example.internal
      http:
        paths:
          - { path: /health, pathType: Prefix,
              backend: { service: { name: app-health, port: { number: 80 } } } }
  tls:
    - { hosts: [app.example.internal], secretName: app-health-tls }
```

Because the two Ingress objects now point at *different* TLS secrets, ALB does not consider them to share a certificate for the purpose of the coalescing guard, and HTTP/2 ALPN is enabled for both. The client still sees the same vhost / cert presented on the wire (identical cert material in both secrets), so end-to-end TLS behaviour is unchanged. The trade-off is that the certificate has to be mirrored into both secrets — a simple `kubectl create secret tls ...` duplication, which cert-manager can automate via a per-Ingress `Certificate` resource.

This approach is the right default on ACP because the stdlib Ingress semantics are preserved, and every path keeps its own backend without introducing an extra L7 layer.

### Richer path-level routing: Service Mesh v2 `VirtualService` / Gateway API `HTTPRoute`

When the reason for collapsing multiple paths into one Ingress is richer routing semantics (weighted splits across backends, header-based routing, retry / timeout policies, mTLS-terminated upstreams), the ACP Service Mesh v2 layer is the better abstraction. Both a mesh `VirtualService` (Istio 1.26.x in ACP Service Mesh v2) and a Gateway API `HTTPRoute` handle path-level routing at L7 without the Ingress-to-route expansion pattern, and so do not trigger the coalescing guard in the first place:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app
spec:
  parentRefs:
    - name: ingress-gateway
      sectionName: https
  hostnames:
    - app.example.internal
  rules:
    - matches:
        - path: { type: PathPrefix, value: / }
      backendRefs:
        - name: app-root
          port: 80
    - matches:
        - path: { type: PathPrefix, value: /health }
      backendRefs:
        - name: app-health
          port: 80
```

The `Gateway` parent terminates TLS once for the whole host and the route table then fans out by path. HTTP/2 is negotiated on the single gateway listener rather than on per-path routes, so the shared-cert condition simply does not arise.

### OSS fallback: upstream NGINX / plain Gateway API

On a cluster that does not have ACP Service Mesh installed, the equivalent upstream OSS patterns are:

- An upstream NGINX ingress controller accepts the original multi-path Ingress as-is and enables HTTP/2 unconditionally at the server block level — NGINX does not split routes per path internally, so the coalescing hazard does not surface through its implementation.
- A vanilla Gateway API deployment (any conformant Gateway controller) behaves the same as the Service Mesh v2 example above.

In both OSS cases the operator is trading away the ACP-integrated observability and policy surface that ALB and Service Mesh provide, so these are fallbacks rather than defaults.

## Diagnostic Steps

Confirm ALPN negotiation on each path before and after the fix. `openssl` is the most direct probe:

```bash
# On a shared-cert multi-path Ingress: no h2.
echo | openssl s_client -connect <ingress-ip>:443 \
  -servername app.example.internal -alpn h2,http/1.1 2>/dev/null \
  | grep -E 'ALPN protocol'

# After splitting into per-backend Ingress objects, each with its own secret:
# both paths report h2.
```

`ALPN protocol: h2` on the target path is the confirmation. `ALPN protocol: http/1.1` (or `No ALPN negotiated`) means the router still treats the path as sharing a certificate with a sibling — either a second Ingress is still pointing at the same secret, or the controller has not re-reconciled.

To see how the ingress controller has expanded the Ingress internally:

```bash
# ALB-level view
kubectl -n cpaas-system get frontend,rule \
  -l alauda.io/managed-by=alb \
  --show-labels | grep app.example.internal

# Count of distinct cert references across the expanded rules —
# >1 rule referencing the same secret is the coalescing trigger.
```

If the secret reference count is still greater than 1 after the per-backend split, there is a stale Ingress object sharing the same secret — delete it or point it at its own secret.

Finally, if HTTP/2 is a hard requirement for the path in question and neither splitting the Ingress nor migrating to Gateway API is acceptable, the last-resort option is **not to share the certificate** — provision a distinct SAN (or distinct cert entirely) per backend. ALPN then negotiates independently for each and the coalescing guard lifts.
