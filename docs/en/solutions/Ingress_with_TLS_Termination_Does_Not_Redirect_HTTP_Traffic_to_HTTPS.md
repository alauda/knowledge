---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Ingress with TLS Termination Does Not Redirect HTTP Traffic to HTTPS
## Issue

A public Ingress (or equivalent ALB rule) terminates TLS at the edge and serves the application over HTTPS, but clients that hit the service over plain HTTP are answered by the application rather than being bumped to the HTTPS URL. `curl -kvL http://<host>` shows a normal 200 response with no `Location:` redirect header — instead of the expected `30x` bounce to `https://<host>`.

Browsers with HSTS cached will paper over this, but first-time visitors, scripted clients, and any downstream tool assuming TLS end-to-end will keep talking HTTP and expose traffic that should be encrypted.

## Root Cause

HTTP-to-HTTPS redirection is not automatic just because a TLS certificate is attached. The edge proxy needs an explicit instruction for what to do with inbound traffic on port 80. Without that instruction, the default behaviour depends on the controller: some pass plain HTTP through to the backend, some drop the connection, and some — the case here — serve the application without TLS.

## Resolution

On ACP the recommended path is to use the **ALB Operator** (`networking/operators/alb_operator`), which is the ACP Ingress/LB front-end and provides a declarative toggle to force HTTPS. If ALB is not available, a vanilla `Ingress` plus a controller-specific redirect annotation works as the fallback.

### Preferred: ACP ALB rule with enforced HTTPS

An ALB frontend can be configured to redirect HTTP to HTTPS at the listener layer, before any rule is evaluated. On the `Frontend` (or `Rule`, depending on the ALB CRD version in the cluster) set the redirect action:

```yaml
apiVersion: crd.alauda.io/v1
kind: Rule
metadata:
  name: my-app-redirect-http
  namespace: my-app
spec:
  domain: my-app.example.com
  port: 80
  redirect:
    scheme: https
    port: 443
    code: 301
```

Traffic hitting port 80 gets an immediate `301` without reaching the backend. The HTTPS rule on port 443 continues to terminate TLS and route as usual. The exact CRD shape depends on the ALB version installed — consult `networking/operators/alb_operator` in the cluster's documentation for the current field names.

Make sure port 80 is actually reachable on the ALB instance's LoadBalancer service; a redirect rule is useless if the ingress node never accepts port-80 connections.

### Fallback: standard Kubernetes Ingress with a redirect annotation

Where ALB is not deployed (e.g. a plain ACP cluster running an OSS ingress controller), use whichever annotation the installed controller honours. Example for ingress-nginx:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: my-app
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
spec:
  tls:
    - hosts:
        - my-app.example.com
      secretName: my-app-tls
  rules:
    - host: my-app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  number: 8080
```

`ssl-redirect` only fires if the request arrives on the HTTP listener; `force-ssl-redirect` also fires when the controller cannot tell from headers whether the original client used HTTP or HTTPS (common behind an L4 load balancer). Other controllers (Traefik, HAProxy, Contour) expose equivalent annotations with different names — consult the specific controller's docs.

## Diagnostic Steps

Confirm the absence of redirect by following 3xx chains explicitly:

```bash
# -L follows redirects; -k ignores cert mismatches for local/dev certs.
curl -kvL http://my-app.example.com -o /dev/null
```

What to look for in the trace:

- A healthy redirect chain starts with `HTTP/1.1 301 Moved Permanently` (or `302`) and a `Location: https://...` header, then proceeds to a second request against port 443 that returns `200`.
- A broken configuration shows `HTTP/1.1 200 OK` directly on port 80 — the application was reached over plain HTTP.

After applying the fix, re-run the curl above and verify the 301 is emitted by the edge proxy (look at `Server:` header; it should identify the ingress/ALB controller, not the backend application).

If the redirect still does not fire, check two common traps:

- The DNS record for the hostname points to the LoadBalancer IP of the expected ingress/ALB instance, not a second older controller that still accepts port 80 silently.
- Port 80 is open on the nodes hosting the ALB or ingress controller — if only port 443 is exposed on the service, there is nothing to redirect from.
