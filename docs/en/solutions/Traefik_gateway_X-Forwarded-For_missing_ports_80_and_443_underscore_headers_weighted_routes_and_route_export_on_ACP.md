---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
---

# Traefik gateway: X-Forwarded-For missing, ports 80 and 443, underscore headers, weighted routes and route export on ACP

## Issue

The customized Traefik gateway (`traefik.traefik.alauda.io`), delivered for specific projects, is in use, and one of these comes up:

- Traefik cannot get the client IP from the request headers. The access log for one entrypoint shows `ClientHost` `127.0.0.6` and `request_X-Real-Ip` `127.0.0.6` and no `X-Forwarded-For` value, although the client sent one. The response carries `server: istio-envoy`.
- Does Traefik drop request headers whose names contain an underscore?
- Can Traefik's default ports 80 and 443 be closed, or opened again?
- Where is a `TraefikService` maintained? The console has no page for it, and the goal is a gray release (weighted split between a stable and a new version) without the service mesh module.
- Can routes be exported and imported between environments by copying the IngressRoute YAML from the console?

## Root Cause

### Cause 1: the entrypoint has no forwardedHeaders trust

Traefik trusts `X-Forwarded-*` headers only from addresses listed in `forwardedHeaders.trustedIPs`, or from every source when `forwardedHeaders.insecure` is true, and the setting is per entrypoint. Requests reached Traefik through an Istio sidecar, so the source Traefik saw was `127.0.0.6` (the address the sidecar uses for inbound traffic to the application container). The custom entrypoint that received them (for example `mytcp` on ACP 4.2.2) had no `forwardedHeaders` setting, so the client's `X-Forwarded-For` did not appear in the log, while other ports could keep it.

### Cause 2: Traefik accepts header names with underscores by default

Traefik supports request headers whose names contain underscores by default; no extra configuration is needed. This differs from Envoy Gateway, which rejects such headers by default.

### Cause 3: ports 80 and 443 are the web and websecure entries of the instance

Ports 80 and 443 are the `web` and `websecure` entries under `spec.ports` of the Traefik instance, and their `expose.default` field controls whether they are published.

### Cause 4: TraefikService has no UI, and a weighted IngressRoute does the gray release

Traefik is a project-specific customization, and the console does not support `TraefikService`. A gray release without the service mesh module is done with an `IngressRoute` whose route lists two backend Services with weights.

### Cause 5: copying the IngressRoute YAML is a valid way to move routes

Opening a route under **Resource Management > IngressRoute**, copying its YAML, cleaning it up and creating it in another environment is a viable way to export and import Traefik routes, provided the target environment is compatible and already holds everything the route depends on.

## Resolution

### Cause 1: the entrypoint has no forwardedHeaders trust

Only when the access log of a specific entrypoint lacks the `X-Forwarded-For` value the request carried. Add `forwardedHeaders.insecure: true` to that port of the Traefik instance, at the same level as `expose`, `exposedPort` and `port`:

```yaml
spec:
  ports:
    mytcp:
      expose:
        default: true
      exposedPort: 9000
      forwardedHeaders:
        insecure: true
      port: 19090
```

Keep your own entry name and ports; only add the `forwardedHeaders` block. Traefik also accepts `forwardedHeaders.trustedIPs` with a list of trusted source CIDRs instead of `insecure`.

> **Warning:** `insecure: true` makes the entrypoint trust `X-Forwarded-For` from any source, so a client that reaches the port directly can set any address, and backends or allowlists that read the header will believe it. The Traefik Pods can roll, dropping connections. Use a maintenance window and save the instance first; removing `forwardedHeaders` or applying the saved file is the rollback.

```bash
kubectl get traefik.traefik.alauda.io <traefik-name> -n <namespace> -o yaml > /tmp/traefik-before.yaml
kubectl edit traefik.traefik.alauda.io <traefik-name> -n <namespace>
kubectl rollout status deploy/<traefik-deploy> -n <namespace>
kubectl logs -n <namespace> deploy/<traefik-deploy> --since=5m | grep '<path>'
```

The new log entry should show the `X-Forwarded-For` value. Removing the Istio sidecar from the Traefik Pod, so that Traefik is the only proxy on the hop, is a separate option; the `forwardedHeaders` change alone is enough.

### Cause 2: Traefik accepts header names with underscores by default

No change is needed. If such a header really goes missing behind Traefik, test the hop (Diagnostic Steps) before changing any setting.

### Cause 3: ports 80 and 443 are the web and websecure entries of the instance

Set `spec.ports.web.expose.default` and `spec.ports.websecure.expose.default` to `false` to close them, or `true` to open them again. Example that keeps a custom port and closes both:

```yaml
spec:
  ports:
    mytcp:
      expose:
        default: true
      exposedPort: 9000
      port: 9000
    web:
      expose:
        default: false
    websecure:
      expose:
        default: false
```

Leave any `forwardedHeaders` settings that the entries already have.

> **Warning:** Clients that use ports 80 or 443 on this instance lose access as soon as the change applies. Confirm no route still needs `web` or `websecure`, and save the instance; setting `expose.default` back to `true` is the rollback.

```bash
kubectl edit traefik.traefik.alauda.io <traefik-name> -n <namespace>
kubectl get svc -n <namespace> -o custom-columns='NAME:.metadata.name,TYPE:.spec.type,PORTS:.spec.ports[*].port'
```

### Cause 4: TraefikService has no UI, and a weighted IngressRoute does the gray release

Give the stable (v1) and gray (v2) versions their own Services, then create a weighted `IngressRoute`. This example sends 90 percent of `app.example.com` to `app-v1` and 10 percent to `app-v2` on entrypoint `web` (use `websecure` for HTTPS, or another exposed entrypoint if `web` is closed):

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: app-ingress-gray
  namespace: <app-namespace>
spec:
  entryPoints:
    - web
  routes:
    - match: Host(`app.example.com`)
      kind: Rule
      services:
        - name: app-v1
          kind: Service
          port: 80
          weight: 90
        - name: app-v2
          kind: Service
          port: 80
          weight: 10
```

```bash
kubectl get svc app-v1 app-v2 -n <app-namespace>
kubectl apply -f /tmp/app-ingress-gray.yaml
kubectl get ingressroute app-ingress-gray -n <app-namespace> -o yaml
```

Change the two `weight` values and apply again to shift traffic to v2.

### Cause 5: copying the IngressRoute YAML is a valid way to move routes

1. Check that the target environment is ready:
   - Traefik is installed with the matching IngressRoute CRD, and the `apiVersion` is compatible (for example `traefik.io/v1alpha1`).
   - The backend Services, Middlewares, TLS Secrets and TLSOption/TLSStore resources that the route references exist there.
   - Environment-specific settings are prepared: entrypoints, domain DNS, the VIP or LoadBalancer Service, and the namespaces the Traefik instance watches.

   ```bash
   kubectl get crd | grep -i traefik
   kubectl get traefik.traefik.alauda.io -A
   kubectl get svc,secret -n <namespace>
   ```

2. Export the route, remove the server-generated fields (`metadata.uid`, `metadata.resourceVersion`, `metadata.creationTimestamp`, `metadata.generation`, `metadata.managedFields` and `status`), and adjust the domain, certificate, Services and entrypoints for the target.

   ```bash
   kubectl get ingressroute <route-name> -n <namespace> -o yaml > /tmp/<route-name>.yaml
   vi /tmp/<route-name>.yaml
   ```

3. Create it in the target environment and test the domain:

   ```bash
   kubectl apply -f /tmp/<route-name>.yaml
   kubectl get ingressroute <route-name> -n <namespace>
   ```

## Diagnostic Steps

1. Find the instance, its Pods and the entrypoint that handles the request:

   ```bash
   kubectl get traefik.traefik.alauda.io -A
   kubectl get traefik.traefik.alauda.io <traefik-name> -n <namespace> -o yaml | sed -n '/^  ports:/,/^  [a-z]/p'
   kubectl get pods -n <namespace> -o wide
   ```

2. For a missing client address, send a request with a known header and read its log line:

   ```bash
   curl -v -H 'X-Forwarded-For: 203.0.113.10' http://<traefik-address>:<port>/<path>
   kubectl logs -n <namespace> <traefik-pod> | grep '<path>'
   kubectl get pod <traefik-pod> -n <namespace> -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{end}'
   ```

   `ClientHost` and `request_X-Real-Ip` of `127.0.0.6`, no `X-Forwarded-For` value, and no `forwardedHeaders` on that port: Cause 1. An `istio-proxy` container means a sidecar sits in front of Traefik.

3. For an underscore header, send it through Traefik to a backend that logs headers and compare with a request straight to the Service:

   ```bash
   curl -v -H 'x_custom_header: test' http://<traefik-address>:<port>/<path>
   ```

4. For ports 80 and 443, read `spec.ports.web` and `spec.ports.websecure` and the ports on the Traefik Service. For gray release or route export, confirm the CRD and the Services with `kubectl get ingressroute -A` and `kubectl get svc -n <app-namespace>`.
