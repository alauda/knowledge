---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A workload exposed through the cluster's ingress layer must return a `Content-Security-Policy` (CSP) response header — and often a related set of security headers (`Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`). The application itself does not emit them, so the headers must be injected at the load-balancer layer, either globally for every host the load balancer serves or per-host (per-Ingress).

A direct `curl -kv https://www.example.com/` shows no `Content-Security-Policy` line in the response headers; the goal is to make that line appear with a controlled value.

## Root Cause

CSP is a response-header policy: the browser only enforces it if the server emits the `Content-Security-Policy` header on each response. Backend frameworks can do this themselves, but in practice many UI workloads (especially third-party admin consoles, off-the-shelf web UIs, and short-lived utility services) do not. Injecting the header at the ingress layer keeps the policy out of the application's code path and makes it possible to roll changes without redeploying the workload.

On ACP the ingress layer is **ALB** (`networking/operators/alb_operator`). ALB exposes a header-action surface very similar in shape to other reencrypt-capable ingress controllers: response headers can be set/added/deleted either at the controller level (apply to every Ingress the controller fronts) or annotated onto a single Ingress (apply only to that host). The two scopes follow the same precedence rule that almost every controller uses — controller-wide actions take effect first, and per-Ingress actions can override them on the matching host.

## Resolution

Decide first whether the policy should be cluster-wide or host-specific:

- **Cluster-wide** is the right default for short, conservative headers that should apply to every site fronted by the same ALB instance (e.g. `X-Content-Type-Options: nosniff`, a baseline `Strict-Transport-Security` value).
- **Per-Ingress** is the right scope for `Content-Security-Policy` itself, because a meaningful CSP value lists allowed `script-src`/`style-src`/`img-src` origins specific to that application — there is no good "one CSP for everyone" string.

### Per-Ingress (recommended for CSP)

Annotate the Ingress to inject the response header for that hostname only. The exact ALB annotation key is documented in `networking/operators/alb_operator`; the pattern is a structured action map (set/add/append/delete on a named header), for example:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: console
  namespace: my-app
  annotations:
    # ALB header-action annotation. Key/format per
    # networking/operators/alb_operator docs; the value is YAML or JSON
    # describing one or more actions per header.
    alb.networking.alauda.io/response-headers: |
      - name: Content-Security-Policy
        action:
          type: Set
          value: "default-src 'self'; script-src 'self' https://trusted.cdn.example; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'"
      - name: Strict-Transport-Security
        action:
          type: Set
          value: "max-age=31536000; includeSubDomains; preload"
      - name: X-Content-Type-Options
        action:
          type: Set
          value: "nosniff"
spec:
  rules:
    - host: www.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: console
                port: { number: 80 }
```

Apply the Ingress and verify the headers (see Diagnostic Steps).

### Cluster-wide (every Ingress on the same ALB)

For headers that should be a baseline, set the action on the ALB CR (or the Frontend CR depending on the ALB version). The pattern is:

```yaml
apiVersion: crd.alauda.io/v2
kind: ALB2
metadata:
  name: my-alb
  namespace: cpaas-system
spec:
  config:
    httpHeaders:
      actions:
        response:
          - name: X-Content-Type-Options
            action:
              type: Set
              value: "nosniff"
          - name: Strict-Transport-Security
            action:
              type: Set
              value: "max-age=31536000; includeSubDomains"
```

Refer to the ALB Operator documentation for the exact CRD path and field name in the deployed version. Cluster-wide actions take precedence over per-Ingress actions for the same header name, so use cluster-wide only for headers whose value is genuinely identical for every host fronted by this ALB. Set CSP per-Ingress.

### Crafting the CSP value itself

`default-src 'self'` is a sane starting point; tighten from there. Common mistakes:

- Forgetting that browsers treat the `'self'` keyword as the *exact* origin (scheme + host + port). Use explicit hostnames for any external CDN.
- Including `'unsafe-inline'` in `script-src` "to make it work". This negates most of the CSP's value; instead, hash or nonce the inline scripts, or move them out.
- Using overly broad `*.example.com` directives that re-introduce subdomain takeover risk.

Roll out CSP changes with `Content-Security-Policy-Report-Only` first (same syntax, browser only logs violations rather than blocking) before switching to enforcing mode.

## Diagnostic Steps

Confirm the header is present on the response:

```bash
curl -ks -o /dev/null -D - https://www.example.com/ | grep -iE 'content-security-policy|strict-transport|x-content-type'
```

If the headers are absent, three causes are typical:

1. The Ingress has not yet been admitted by ALB. Check its status:

   ```bash
   kubectl -n my-app get ingress console -o jsonpath='{.status}{"\n"}'
   ```

2. The annotation key/format does not match what ALB expects in this version. Inspect ALB's logs for an annotation parse error:

   ```bash
   kubectl -n cpaas-system logs deploy/<alb-deploy> --tail=200 | grep -i 'response-headers\|annotation'
   ```

3. A cluster-wide action is overriding the per-Ingress one. Compare the two:

   ```bash
   kubectl get alb2 -A -o yaml | grep -A4 'response:' | head -n 40
   ```

If the Ingress fronts a UI whose templates the platform manages (some console-style components revert their Ingress at every reconcile), suspend that template management before annotating the Ingress; otherwise the next reconcile reverts the change. The exact mechanism is component-specific.
