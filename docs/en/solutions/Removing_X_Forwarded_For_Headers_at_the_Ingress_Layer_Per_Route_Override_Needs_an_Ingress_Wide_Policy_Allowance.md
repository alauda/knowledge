---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
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

Ingress proxies on most platforms manage the XFF header centrally at the **ingress-controller level**, not the per-route level. The controller has a single `forwardedHeaderPolicy` that decides, before any per-route filter runs, whether to **append** to / **replace** / **preserve** / **never-touch** the XFF header on every request passing through the proxy.

The default value on most distributions is **Append**. In the Append mode, the ingress proxy appends its view of the client IP to whatever XFF header already exists (or creates one if none is present), and — critically — **re-injects** the header after any per-route filter runs. So a filter that removes XFF executes successfully, sees the header gone, and then the ingress controller appends it back on its way out the door. The workload sees the header.

To get a per-route "remove XFF" to take effect you need **both**:

1. The ingress controller's `forwardedHeaderPolicy` must be one that allows the downstream route to own the header (typically `Replace` or `IfNone`, not `Append`).
2. The route's filter or annotation must actually remove/overwrite the header.

A platform-level override annotation exists on several distributions (e.g. `<platform>.io/set-forwarded-headers: never`) that signals the controller to skip its policy for that specific route. When available, this is the cleanest single-knob solution; when not, the policy + filter pair in the two steps above is the fallback.

## Resolution

### Step 1 — identify the ingress layer your cluster uses

Two common shapes on ACP:

- **ALB2** (`alaudaloadbalancer2.crd.alauda.io`): configured via `AlaudaLoadBalancer2`, `Frontend`, `Rule`.
- **Gateway API** (`gateways.gateway.networking.k8s.io` + `httproutes.gateway.networking.k8s.io`): platform-neutral Gateway API resources, often backed by an ALB2 GatewayClass.

```bash
kubectl get alaudaloadbalancer2 -A 2>/dev/null
kubectl get gateway -A 2>/dev/null
```

### Step 2 — check the current forwarded-header policy

On ALB2, the policy is on the ALB2 CR:

```bash
ALB=<name>; NS=<ns>
kubectl -n "$NS" get alaudaloadbalancer2 "$ALB" -o=yaml | \
  grep -iE 'forwardedHeaderPolicy|x-forwarded|xff'
```

If the field is unset, the proxy runs with its default mode, which on most implementations is **Append**. That is the state that breaks per-route removal.

For Gateway API, check the backing gateway implementation — the field is on the GatewayClass parameters resource that references the underlying proxy. For ALB2-backed Gateway API, it is still the ALB2 CR that governs.

### Step 3 — relax the policy so the route can own the header

Change `forwardedHeaderPolicy` on the ALB2 CR from the default to `Replace` (the proxy sets the header based on the real client IP and lets any downstream filter remove it afterward) or to `IfNone` (the proxy only sets if absent):

```bash
kubectl -n "$NS" patch alaudaloadbalancer2 "$ALB" --type=merge -p='
{"spec":{"forwardedHeaderPolicy":"Replace"}}'
```

This change is cluster-wide for that ALB instance. It affects every route behind it — read the other routes' expectations before applying.

### Step 4 — remove the header at the route

Once the controller respects downstream removal, add the filter:

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

### Step 5 — prefer a per-route override if available

If your ingress implementation exposes a per-route override annotation (several distributions include one of the shape `haproxy.<platform>.io/set-forwarded-headers: never` or `nginx.<platform>.io/configuration-snippet: proxy_set_header X-Forwarded-For ""`), that annotation is the narrower lever. It affects only the annotated route; no global `forwardedHeaderPolicy` change is needed.

Check your ALB2 controller's schema for the annotation:

```bash
kubectl explain rule.spec | grep -iE 'annotation|header'
kubectl -n "$NS" get frontend -o yaml | grep -iE 'header|annotation' | head
```

Use the per-route knob when (a) only some routes need XFF removed, or (b) the global change would break a downstream route that relies on XFF being present (for example, an authorisation service doing IP allowlisting).

## Diagnostic Steps

Reproduce the problem with a controlled request — send a request containing a synthetic XFF value and see whether the application receives yours, the ingress-rewritten one, or a concatenation:

```bash
kubectl -n my-ns exec debug-pod -- curl -s \
  -H 'X-Forwarded-For: 10.99.99.99' \
  http://my-service/echo-headers
```

Expected outcomes and what they tell you:

| Application sees | Diagnosis |
|---|---|
| The literal `10.99.99.99` only | Controller is in `Never` / `IfNone` AND a route filter is not fighting you — header reached the app untouched. This is the desired state if your route says "pass through". |
| `10.99.99.99, <pod-ip>` (comma-separated) | Controller is in `Append` and per-route filter is ignored — the symptom in this article. |
| Only `<pod-ip>` (not the injected one) | Controller is in `Replace` — fine for most apps but XFF is not stripped; if you want it gone entirely, Step 4 still applies. |
| No `X-Forwarded-For` at all | Your config works. |

Watch the ALB2 pod's generated config to confirm the change took effect:

```bash
kubectl -n "$NS" exec <alb-pod> -- cat /etc/alb2/nginx.conf | \
  grep -iE 'x-forwarded-for|proxy_set_header'
```

The generated snippet should match the policy you chose in Step 3.

If after applying both Step 3 and Step 4 the header still appears, check whether **another proxy** sits in front of ALB2 (an upstream load balancer, a CDN, or an outer gateway) and is injecting XFF before traffic reaches the cluster. The same diagnosis pattern above applies at that layer — you are correctly removing it at the cluster edge, but something earlier put it back on.
