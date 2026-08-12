---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Removing X-Forwarded-For Headers at the Ingress Layer — Per-Route Override Needs an Ingress-Wide Policy Allowance
## Issue

A workload receives an `X-Forwarded-For` (XFF) header on every request even though the ingress route for that workload was configured to strip the header. Configuring a per-route header-removal action — either via an ALB2 `Rule` / `Frontend`, a Gateway API `HTTPRoute` filter, or an `Ingress` annotation — has no effect:

```yaml
# Example HTTPRoute filter that appears to do the right thing but is ignored:
filters:
  - type: RequestHeaderModifier
    requestHeaderModifier:
      remove:
        - X-Forwarded-For
```

The client-side behaviour: applications still read `X-Forwarded-For` from the request and behave as if the ingress is still injecting it.

## Root Cause

Ingress proxies on most platforms manage the XFF header centrally at the **proxy level**, not the per-route level. Once the proxy is configured to append/inject the header on every forwarded request, a downstream per-route filter that removes XFF executes successfully, sees the header gone, and then the proxy re-appends it on its way out — the workload sees the header.

ACP's ingress is the **ALB2** (`alaudaloadbalancer2.crd.alauda.io`) controller, which renders an nginx pod-spec from the ALB2 CR plus its `Frontend` / `Rule` children. ALB2 does **not** expose a top-level `forwardedHeaderPolicy` switch (the field name comes from another platform's IngressController API; ALB2's `spec.config` schema has no equivalent). What ALB2 *does* expose is per-`Rule` annotations / config that map to nginx `proxy_set_header` directives. To strip XFF, the answer is a per-rule rewrite, not a top-level policy flip.

## Resolution

### Step 1 — confirm the ingress layer your cluster uses

```bash
kubectl get alaudaloadbalancer2 -A 2>/dev/null
kubectl get gateway -A 2>/dev/null
```

If `alaudaloadbalancer2` returns rows, ALB2 is the ingress proxy and the rest of this article applies. If only `gateway` returns rows, the cluster uses pure Gateway API; the principle (per-route filter + understanding what the proxy re-injects) carries over but the YAML differs.

### Step 2 — read what the proxy actually injects

ALB2 renders its nginx config from the CR. Read the live config to see what `proxy_set_header X-Forwarded-For ...` directive (if any) is in effect:

```bash
ALB_NS=cpaas-system
ALB_POD=$(kubectl -n "$ALB_NS" get pod -l alb2.cpaas.io/pod_type=alb \
            -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$ALB_NS" exec "$ALB_POD" -- \
  grep -E 'X-Forwarded-For|proxy_set_header' /etc/alb2/nginx/nginx.conf | head
```

This shows the actual directive the proxy runs with. If it appends a remote-addr value to XFF, every request reaches the workload with that value in addition to whatever the client sent.

### Step 3 — strip the header at the rule

ALB2 `Rule` objects accept per-rule config (annotations or a `rewriteResponse` / `rewriteRequest` block, depending on ALB2 version) that translates into nginx `proxy_set_header X-Forwarded-For ""` (or to a fixed value the workload should see). Read the operator's CR docs for the version installed on the cluster:

```bash
kubectl explain rule.spec | head -40
kubectl -n "$ALB_NS" get frontend -o yaml | grep -iE 'header|annotation' | head
```

The exact YAML for "set/clear XFF on this rule" is ALB2-version-specific; the operational answer is "it lives on the Rule (or the Frontend its Rule references), not on the ALB2 root CR."

### Step 4 — alternative: take ownership at the workload

When the ingress side cannot be changed (shared cluster, lack of permission to edit ALB2 / Rule, or the proxy's nginx template predates the per-rule knob), strip XFF inside the workload. Most application frameworks have a config switch:

- **NGINX inside the pod**: `proxy_set_header X-Forwarded-For "";` in the workload's own server block.
- **Spring Boot**: set `server.forward-headers-strategy=none` (or strip in a `WebFilter`).
- **Express / Node**: read and overwrite `req.headers['x-forwarded-for']` early in the middleware chain.

This is the only path that survives a non-cooperating upstream proxy.

### Step 5 — Gateway API alternative (if applicable)

If the ingress is Gateway API rather than direct ALB2, a per-route filter on the `HTTPRoute` does the equivalent — and Gateway API treats the filter as authoritative without needing a separate proxy-level toggle:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: my-route
  namespace: my-ns
spec:
  parentRefs:
    - name: my-gateway
      namespace: gateway-ns
  rules:
    - matches:
        - path: {type: PathPrefix, value: /}
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            remove:
              - X-Forwarded-For
      backendRefs:
        - name: my-service
          port: 80
```

The equivalent on `Ingress` (classic) is the per-ingress-class mechanism for `proxy_set_header X-Forwarded-For ""`.

Apply, then confirm from inside a workload pod:

```bash
kubectl -n my-ns exec <app-pod> -- curl -sD- http://localhost/ | \
  grep -i x-forwarded-for
```

The header should be absent.

## Diagnostic Steps

Reproduce the problem with a controlled request — send a request containing a synthetic XFF value and see whether the application receives yours, the ingress-rewritten one, or a concatenation:

```bash
kubectl -n my-ns exec <debug-pod> -- curl -s \
  -H 'X-Forwarded-For: 10.99.99.99' \
  http://my-service/echo-headers
```

Expected outcomes and what they tell you:

| Application sees | Diagnosis |
|---|---|
| The literal `10.99.99.99` only | The proxy did not append; the per-rule rewrite (or absence of any rewrite) is letting the client value through. This is the desired state if your route says "pass through". |
| `10.99.99.99, <client-ip>` (comma-separated) | The proxy appended its view; per-rule strip filter (if any) is being overridden — the symptom in this article. |
| Only `<client-ip>` (not the injected value) | The proxy replaced rather than appended; XFF reflects the proxy's view of the client. If you want it gone entirely, Step 3 / Step 4 still applies. |
| No `X-Forwarded-For` at all | Your config works. |

Watch the ALB2 pod's generated config to confirm the rule edit took effect:

```bash
kubectl -n "$ALB_NS" exec "$ALB_POD" -- \
  grep -E 'X-Forwarded-For|proxy_set_header' /etc/alb2/nginx/nginx.conf
```

The generated snippet should match the per-rule rewrite you applied.

If after applying both the ALB2 rule edit and the workload-side strip the header still appears, check whether **another proxy** sits in front of ALB2 (an upstream load balancer, a CDN, or an outer gateway) and is injecting XFF before traffic reaches the cluster. The same diagnosis pattern above applies at that layer — you are correctly removing it at the cluster edge, but something earlier put it back on.
