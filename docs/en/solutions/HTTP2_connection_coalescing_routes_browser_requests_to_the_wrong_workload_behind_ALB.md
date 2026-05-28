---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500402
---

# HTTP/2 connection coalescing routes browser requests to the wrong workload behind ALB

## Issue

On Alauda Container Platform (Kubernetes `v1.34.5`) clusters running the `alauda-alb2` chart `v4.3.1` (images `registry.alauda.cn:60080/acp/alb2:v4.3.1` and `registry.alauda.cn:60080/acp/alb-nginx:v4.3.1`), two or more applications are published behind the same ALB on distinct hostnames that share one wildcard TLS certificate (for example a SAN of `*.apps.example.com` covering both `a.apps.example.com` and `b.apps.example.com`). After a browser successfully loads the first application, subsequent navigations to other hostnames covered by the same wildcard either render the first application's content or return a `Page Not Found` error instead of the intended workload.

The same flow works correctly when each application is opened in a fresh, isolated browser session, or when Chrome is launched with the `--disable-http2` flag — each hostname then renders its own intended content. This intermittent, browser-side behaviour, scoped to hostnames that share a wildcard certificate, is the visible fingerprint of HTTP/2 connection coalescing.

## Root Cause

RFC 7540 §9.1.1 ("Connection Reuse") permits a client that has already opened a secure HTTP/2 connection to reuse that same connection for any subsequent request whose URI authority is covered by the certificate presented on the original connection. The reuse is conditional on the negotiated protocol being HTTP/2 — HTTP/1.1 has no equivalent reuse semantics, so the coalescing surface only exists once `h2` has been agreed during the TLS ALPN exchange.

A wildcard SubjectAltName such as `*.apps.example.com` is, per RFC 6125 §6.4.3, valid for every single-label host under `apps.example.com`. From the browser's perspective the original certificate is therefore "valid for" `a.apps.example.com` and `b.apps.example.com` alike, so a navigation to the second hostname is sent down the existing HTTP/2 stream to the upstream that the first request's SNI selected — not to the workload that DNS for the second hostname would otherwise resolve to.

The ALB data plane terminates TLS on its `https` frontend and negotiates HTTP/2 with clients (the running ALB nginx configuration sets `http2_max_concurrent_streams 128`), so any ALB-fronted application that is published with the same wildcard certificate as another application can be the source or the target of the coalesced stream.

## Resolution

Bind a non-wildcard, per-application certificate to each HTTP/2 application that needs to be reachable independently. Once each hostname is served with a distinct certificate, the browser's reuse precondition ("certificate valid for the requested URI") no longer holds across hostnames, and the second navigation forces a new TLS connection — and therefore a new SNI selection and a new upstream — instead of reusing the first stream.

On ACP this binding is expressed in two places, depending on which ingress object publishes the application. For an `Ingress` object, set `spec.tls[].secretName` to a TLS `Secret` that contains a certificate whose SAN matches exactly the one hostname this Ingress publishes (no wildcard). For an ALB `Rule` (`rules.crd.alauda.io`), set `spec.certificate_name` to a per-host certificate at the `https` frontend so that ALB presents that specific certificate to clients whose SNI matches this rule's host.

Example `Ingress` snippet binding a hostname-specific certificate:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
 name: app-a
 namespace: team-a
spec:
 tls:
 - hosts:
 - a.apps.example.com
 secretName: app-a-tls # cert SAN = a.apps.example.com (not a wildcard)
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
 number: 80
```

Repeat with a distinct `Secret` per hostname (`app-b-tls` for `b.apps.example.com`, etc.). The `Secret` itself is a standard Kubernetes `kubernetes.io/tls` secret:

```bash
kubectl -n team-a create secret tls app-a-tls \
 --cert=./a.apps.example.com.crt \
 --key=./a.apps.example.com.key
```

For applications published through ALB rules instead of `Ingress`, point each rule at its own per-host certificate using `spec.certificate_name` on the `Rule` CR at the `https` frontend:

```yaml
apiVersion: crd.alauda.io/v1
kind: Rule
metadata:
 name: app-a-rule
 namespace: team-a
spec:
 certificate_name: team-a_app-a-tls # underscore-separated <namespace>_<secret>, matches ALB-rendered convention
 # ... domain, backend, etc.
```

After re-binding, reopen each application from a fresh browser tab — the second navigation now triggers a new TLS handshake (and therefore a new SNI-based upstream selection) instead of reusing the existing HTTP/2 stream.

As an alternative mitigation, the cluster-wide ALB HTTP/2 toggle can be turned off so that the data plane never offers `h2` ALPN to clients. Because coalescing is only possible once HTTP/2 has been negotiated, removing HTTP/2 from the ALB `https` frontend eliminates the precondition entirely and keeps a single wildcard certificate workable across hostnames. The ALB2 CR (`alaudaloadbalancer2.crd.alauda.io`) exposes a configuration surface for this toggle on `spec.config`; consult the ALB CRD's documented configuration shape for the exact field form on this chart version before applying, since the toggle is a cluster-wide change that affects every application fronted by the same ALB.

## Diagnostic Steps

Reproduce the failure deterministically by opening the affected URLs in the same browser session in order: load `https://a.apps.example.com`, then navigate to `https://b.apps.example.com`. The second hostname will render the first application's content or a `Page Not Found` instead of its own UI.

Then repeat the same sequence with HTTP/2 disabled on the client. With Chrome this means launching with the `--disable-http2` flag; with `curl` it means forcing HTTP/1.1 on the request. The `<alb-vip>` placeholder below is the external address of the ALB `Service` in `cpaas-system` (for example `kubectl get svc -n cpaas-system <alb-svc> -o jsonpath='{.status.loadBalancer.ingress[0].ip}'`). If each hostname now renders its own intended content, the failure is HTTP/2 connection coalescing — the wildcard certificate plus a negotiated `h2` connection is the only mechanism that can cause requests to one hostname to arrive at the upstream of another:

```bash
# Force HTTP/1.1 — no h2 ALPN, so no coalescing surface
curl -v --http1.1 --resolve a.apps.example.com:443:<alb-vip> \
 https://a.apps.example.com/
curl -v --http1.1 --resolve b.apps.example.com:443:<alb-vip> \
 https://b.apps.example.com/
```

Confirm the shared-certificate precondition by inspecting the certificate ALB presents on the `https` frontend for both hostnames and checking whether the SAN list is a wildcard that covers both:

```bash
openssl s_client -connect <alb-vip>:443 -servername a.apps.example.com </dev/null 2>/dev/null \
 | openssl x509 -noout -text \
 | grep -A1 'Subject Alternative Name'
openssl s_client -connect <alb-vip>:443 -servername b.apps.example.com </dev/null 2>/dev/null \
 | openssl x509 -noout -text \
 | grep -A1 'Subject Alternative Name'
```

If both handshakes return the same wildcard SAN (e.g. `DNS:*.apps.example.com`) and HTTP/2 is in use, the coalescing precondition is satisfied — switch the affected applications to per-host certificates as described in the Resolution.
