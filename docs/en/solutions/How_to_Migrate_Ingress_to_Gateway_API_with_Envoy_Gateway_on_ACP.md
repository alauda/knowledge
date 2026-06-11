---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x and later
tags:
  - LB
id: KB260600056
---

# How to Migrate Ingress to Gateway API with Envoy Gateway on ACP

## Overview

This guide describes how to migrate Kubernetes `Ingress` traffic rules to Gateway API resources backed by Envoy Gateway on Alauda Container Platform.

Use the migration as a behavior-preserving change, not as a mechanical YAML rename. The Gateway API model separates traffic entry, routing, and policies into different resources:

- `EnvoyGatewayCtl` deploys and manages an Envoy Gateway control plane.
- `GatewayClass` selects the Envoy Gateway controller that manages a `Gateway`.
- `Gateway` defines listeners, TLS termination, and the external traffic entry point.
- `EnvoyProxy` controls the Envoy data plane deployment and Service exposure.
- `HTTPRoute`, `TLSRoute`, `TCPRoute`, `UDPRoute`, and `GRPCRoute` define routing behavior.
- `Backend` describes non-plain-HTTP upstreams, including HTTPS upstreams that should not be modeled as ordinary HTTP `Service` backends.
- `SecurityPolicy`, `ClientTrafficPolicy`, `BackendTrafficPolicy`, `BackendTLSPolicy`, and `EnvoyExtensionPolicy` carry advanced behavior that was often stored as Ingress annotations.

The upstream Gateway API migration guide provides the standard resource mapping, and `ingress2gateway` can generate an initial Gateway API manifest. However, provider-specific annotations, regex rewrites, dynamic header logic, and backend TLS behavior must still be reviewed and tested manually.

## Migration Mapping Model

Model the migration at the same ownership level as the old entry point:

- One ingress controller entry maps to one `Gateway`. If the old traffic entry was one ingress-nginx instance or one ALB instance, create one `Gateway` to replace that entry.
- One Kubernetes `Ingress` maps to one `HTTPRoute` by default. The route attaches to the replacement `Gateway` through `parentRefs`.
- Ingress annotations do not become annotations on the `Gateway`. Convert them to `HTTPRoute` filters or Envoy Gateway policy and extension resources with the same scope as the old `Ingress`.
- Backend `Service` references remain `Service` backendRefs only when the upstream protocol is plain HTTP. If the old Ingress used a backend protocol of HTTPS, migrate that upstream to an Envoy Gateway `Backend` resource and reference the `Backend` from the `HTTPRoute`.

This mapping keeps the first migration reviewable: compare one old controller entry to one new `Gateway`, and compare each old `Ingress` to one new `HTTPRoute`. After the behavior is verified, routes can still be split or merged for long-term ownership.

## Prerequisites

1. ACP 4.3.x or later.
2. Envoy Gateway Operator is installed.
3. An `EnvoyGatewayCtl` has been created and its generated `GatewayClass` is accepted.
4. `kubectl` can access the target cluster.
5. The existing `Ingress`, `Service`, TLS `Secret`, and backend applications are healthy before migration.
6. DNS, external load balancer, or MetalLB VIP changes can be controlled during cutover.
7. If a front load balancer already owns the external IP, its listener, backend pool, backend port, health check, and traffic shifting method are known before the migration.

## Recommended Target Layout

Use one `EnvoyGatewayCtl` per cluster for normal deployments. Create a `Gateway` for each traffic boundary that needs independent exposure, scheduling, certificates, or ownership. For many user workloads, a shared project Gateway or one Gateway per project is easier to operate than one Gateway per application.

For the Gateway data plane:

- Prefer `EnvoyProxy.spec.provider.kubernetes.envoyService.type: LoadBalancer` when the cluster has a LoadBalancer provider such as MetalLB.
- Use MetalLB annotations on the `EnvoyProxy` service configuration when the Gateway needs a stable VIP. If you want to reuse the previous VIP, first release that VIP from the old LoadBalancer Service. MetalLB cannot assign the same VIP to the old entry and the new Gateway Service at the same time.
- Use `allowedRoutes.namespaces.from: Same` for private Gateways.
- Use `allowedRoutes.namespaces.from: Selector` for shared Gateways so only intended project namespaces can attach routes.
- Use `NodePort` only when there is no LoadBalancer provider and make sure users access the NodePort value, not the listener port.
- Use `hostNetwork` only for special compatibility or performance cases, and pin the Envoy pods to selected nodes to avoid port conflicts.
- If a front load balancer already exposes the stable external IP, keep that external IP on the front load balancer and migrate by changing only its backend targets. The Gateway data plane can use `hostNetwork` or `NodePort` behind the front load balancer.

Example shared Gateway:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: project-gateway
  namespace: project-gateway
spec:
  gatewayClassName: envoy-gateway-operator-cpaas-default
  infrastructure:
    parametersRef:
      group: gateway.envoyproxy.io
      kind: EnvoyProxy
      name: project-gateway
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              cpaas.io/project: demo-project
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: project-gateway-tls
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              cpaas.io/project: demo-project
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: project-gateway
  namespace: project-gateway
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: LoadBalancer
        annotations:
          metallb.universe.tf/address-pool: production
          metallb.universe.tf/loadBalancerIPs: 192.0.2.20
      envoyDeployment:
        replicas: 2
```

## Chapter 1. Inventory the Existing Ingress

### Step 1: Export the source resources

Set the namespace and Ingress name:

```bash
export APP_NAMESPACE="demo"
export INGRESS_NAME="demo-web"

kubectl get ingress "${INGRESS_NAME}" -n "${APP_NAMESPACE}" -o yaml > ingress-source.yaml
kubectl get svc -n "${APP_NAMESPACE}" -o yaml > services-source.yaml
kubectl get secret -n "${APP_NAMESPACE}" -o yaml > secrets-source.yaml
```

For a namespace-wide migration, export all Ingress objects:

```bash
kubectl get ingress -n "${APP_NAMESPACE}" -o yaml > ingress-source.yaml
```

### Step 2: Record the behavior that must be preserved

For each Ingress, record:

| Area | What to check |
| ---- | ------------- |
| Entry | Ingress class, external VIP, DNS name, HTTP and HTTPS ports |
| TLS | `spec.tls[].hosts`, `spec.tls[].secretName`, passthrough or termination behavior |
| Routing | Hostnames, path values, `pathType`, backend Service and port |
| Annotations | Rewrite, redirect, timeout, CORS, authentication, header modification, session affinity, rate limit, body size, whitelist, WAF, custom snippets |
| Backend protocol | Whether the backend Service port expects HTTP, HTTPS, gRPC, TCP, or TLS passthrough. Treat `nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"` as a signal to create an Envoy Gateway `Backend` instead of a plain `Service` backendRef. |
| Precedence | Overlapping paths such as `/`, `/api`, `/api/v1`, and regex-style paths |
| Tests | Representative curl requests, expected status codes, headers, redirects, and response bodies |

Save a simple request test list before converting anything:

```bash
cat > migration-cases.txt <<'EOF'
https://app.example.com/
https://app.example.com/api/healthz
https://app.example.com/api/v1/orders
http://app.example.com/
EOF
```

## Chapter 2. Generate a Draft with ingress2gateway

Install `ingress2gateway` from its upstream release or with Go:

```bash
go install github.com/kubernetes-sigs/ingress2gateway@v1.0.0
```

Generate an initial Gateway API manifest from live ingress-nginx resources:

```bash
ingress2gateway print \
  --providers=ingress-nginx \
  --ingress-nginx-ingress-class=nginx \
  --namespace="${APP_NAMESPACE}" \
  --output=yaml > gateway-draft.yaml
```

If you exported manifests to files and want to avoid reading from the live cluster, use:

```bash
ingress2gateway print \
  --providers=ingress-nginx \
  --input-file=ingress-source.yaml \
  --output=yaml > gateway-draft.yaml
```

Review the command output and `gateway-draft.yaml` carefully. `ingress2gateway` is useful for the first draft, but it is not a complete compatibility checker:

- It reports untranslated fields or unsupported features.
- It does not intend to copy Ingress annotations directly to Gateway API.
- Provider-specific behavior is supported only when it can be represented by Gateway API or by a supported emitter.
- For ACP Envoy Gateway, you still need to align the generated resources with the target `GatewayClass`, `Gateway`, `EnvoyProxy`, and policy layout used on your cluster.

## Chapter 3. Convert the Core Ingress Fields

Use the following mapping for the standard Kubernetes Ingress fields:

| Ingress | Gateway API / Envoy Gateway |
| ------- | --------------------------- |
| `spec.ingressClassName` or `kubernetes.io/ingress.class` | `Gateway.spec.gatewayClassName` |
| `spec.rules[].host` | `Gateway.spec.listeners[].hostname` and `HTTPRoute.spec.hostnames` |
| HTTP listener | `Gateway` listener with `protocol: HTTP`, usually port `80` |
| HTTPS listener with TLS termination | `Gateway` listener with `protocol: HTTPS`, port `443`, and `tls.mode: Terminate` |
| `spec.tls[].secretName` | `Gateway.spec.listeners[].tls.certificateRefs[]` |
| `spec.rules[].http.paths[].path` | `HTTPRoute.spec.rules[].matches[].path.value` |
| `pathType: Exact` | `HTTPRoute` path match `type: Exact` |
| `pathType: Prefix` | `HTTPRoute` path match `type: PathPrefix` |
| `pathType: ImplementationSpecific` | Review manually. Use `PathPrefix`, `Exact`, or `RegularExpression` only after confirming the old controller behavior. |
| `backend.service.name` and `backend.service.port` with plain HTTP upstream | `HTTPRoute.spec.rules[].backendRefs[]` pointing to the `Service` |
| `backend.service.name` and `backend.service.port` with HTTPS upstream | Envoy Gateway `Backend` resource referenced from `HTTPRoute.spec.rules[].backendRefs[]`; do not leave it as an ordinary HTTP `Service` backend |
| `defaultBackend` | A catch-all `HTTPRoute`, usually `PathPrefix /`, attached to a listener with no hostname |

Example `HTTPRoute`:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: demo-web
  namespace: demo
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: project-gateway
      namespace: project-gateway
      sectionName: https
  hostnames:
    - app.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      backendRefs:
        - group: ""
          kind: Service
          name: demo-api
          port: 8080
          weight: 100
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - group: ""
          kind: Service
          name: demo-web
          port: 8080
          weight: 100
```

Apply simple routes first:

```bash
kubectl apply -f project-gateway.yaml
kubectl apply -f demo-web-httproute.yaml
```

Check status conditions:

```bash
kubectl get gateway -n project-gateway project-gateway -o yaml
kubectl get httproute -n demo demo-web -o yaml
```

The `Gateway` listener should be accepted, and the `HTTPRoute` should be accepted by the parent listener.

## Chapter 4. Replace Common Ingress Annotations

Do not move annotations blindly. Decide which Gateway API resource owns the behavior.

| Ingress behavior | Recommended Gateway API / Envoy Gateway replacement |
| ---------------- | --------------------------------------------------- |
| Static request header add/set/remove | `HTTPRoute.rules[].filters[].requestHeaderModifier` |
| Static response header add/set/remove | `HTTPRoute.rules[].filters[].responseHeaderModifier` or `ClientTrafficPolicy` when the behavior is listener-wide |
| HTTP to HTTPS redirect or path redirect | `HTTPRoute.rules[].filters[].requestRedirect` |
| Simple prefix rewrite | `HTTPRoute.rules[].filters[].urlRewrite` with `ReplacePrefixMatch` |
| Full-path rewrite | `HTTPRoute.rules[].filters[].urlRewrite` with `ReplaceFullPath` |
| Regex capture rewrite such as `/shop(/|$)(.*)` to `/$2` | Review manually. Standard `HTTPRoute` `URLRewrite` only supports `ReplaceFullPath` and `ReplacePrefixMatch`; it cannot express arbitrary capture substitution. Use an Envoy Gateway extension or policy resource, such as `HTTPRouteFilter` with `ReplaceRegexMatch`, when the behavior is required. |
| Cookie-to-header or other dynamic value extraction | `EnvoyExtensionPolicy`, usually attached to selected `HTTPRoute` objects, not the whole `Gateway` |
| CORS | `SecurityPolicy.spec.cors` or `HTTPRoute` CORS filter where supported |
| API key authentication | `SecurityPolicy.spec.apiKeyAuth` |
| Client TLS version and cipher settings | `ClientTrafficPolicy.spec.tls` |
| Backend timeout, retry, and load balancing | `HTTPRoute` rule options or `BackendTrafficPolicy`, depending on required scope |
| Header-based consistent hash | `BackendTrafficPolicy.spec.loadBalancer` with consistent hash by header, not `HTTPRoute.rules[].sessionPersistence.type: Header` |
| Headers containing underscores | `ClientTrafficPolicy.spec.withUnderscoresAction` when the old entry accepted such headers and clients still send them |
| Backend HTTPS re-encrypt | Envoy Gateway `Backend` resource referenced by the `HTTPRoute`; put TLS settings on the `Backend` or attach `BackendTLSPolicy` to that `Backend` when separate policy ownership is needed |
| Cross-namespace certificate reference | `ReferenceGrant` in the namespace that owns the `Secret` |
| TLS passthrough | `Gateway` TLS listener with `tls.mode: Passthrough` plus `TLSRoute`, not `HTTPRoute` |

Example HTTP to HTTPS redirect:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: demo-web-http-redirect
  namespace: demo
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: project-gateway
      namespace: project-gateway
      sectionName: http
  hostnames:
    - app.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

Example simple prefix rewrite:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: demo-api
  namespace: demo
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: project-gateway
      namespace: project-gateway
      sectionName: https
  hostnames:
    - app.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
      backendRefs:
        - name: demo-api
          port: 8080
```

Example header-based consistent hash:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: demo-api-header-hash
  namespace: demo
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: demo-api
  loadBalancer:
    type: ConsistentHash
    consistentHash:
      type: Header
      header:
        name: X-Session-Id
```

This is the correct replacement when the old Ingress or ALB selected upstreams by hashing a request header value, such as ingress-nginx `upstream-hash-by: "$http_x_session_id"`. Do not map that behavior to `HTTPRoute.rules[].sessionPersistence.type: Header`. `HTTPRoute` header session persistence is Envoy stateful session behavior: Envoy writes a session token in a response header, and the client must send that token back so Envoy can try to return to the previous upstream host.

Example policy for headers containing underscores:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: allow-underscore-headers
  namespace: project-gateway
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: project-gateway
  withUnderscoresAction: Allow
```

Envoy Gateway follows Envoy's default behavior and rejects request headers containing underscores unless this behavior is changed. Use `Allow` only when existing clients require those headers. Use `DropHeader` when the request should continue but the underscored header should not be forwarded.

Example regex capture rewrite with an Envoy Gateway extension:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: HTTPRouteFilter
metadata:
  name: shop-path-rewrite
  namespace: demo
spec:
  urlRewrite:
    path:
      type: ReplaceRegexMatch
      replaceRegexMatch:
        pattern: "^/shop(/|$)(.*)"
        substitution: "/\\2"
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop-web
  namespace: demo
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: project-gateway
      namespace: project-gateway
      sectionName: https
  hostnames:
    - app.example.com
  rules:
    - matches:
        - path:
            type: RegularExpression
            value: "^/shop(/|$)(.*)"
      filters:
        - type: ExtensionRef
          extensionRef:
            group: gateway.envoyproxy.io
            kind: HTTPRouteFilter
            name: shop-path-rewrite
      backendRefs:
        - name: shop-web
          port: 8080
```

Example HTTPS backend with an Envoy Gateway `Backend` resource:

```yaml
apiVersion: envoy-gateway.alauda.io/v1
kind: EnvoyGatewayCtl
metadata:
  name: default
  namespace: envoy-gateway-system
spec:
  config:
    envoyGateway:
      extensionApis:
        enableBackend: true
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: secure-api
  namespace: demo
spec:
  type: Endpoints
  endpoints:
    - fqdn:
        hostname: secure-api.demo.svc.cluster.local
        port: 8443
  tls:
    sni: secure-api.demo.svc.cluster.local
    caCertificateRefs:
      - group: ""
        kind: Secret
        name: secure-api-ca
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: secure-api
  namespace: demo
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: project-gateway
      namespace: project-gateway
      sectionName: https
  hostnames:
    - app.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /secure-api
      backendRefs:
        - group: gateway.envoyproxy.io
          kind: Backend
          name: secure-api
```

The CA object referenced by `Backend.tls.caCertificateRefs` must contain the CA certificate in key `ca.crt`. Use `insecureSkipVerify: true` only as an explicit risk acceptance for environments where backend certificate validation is intentionally disabled.

## Chapter 5. Handle Regex and Path Precedence

Gateway API path matching is explicit and stricter than many Ingress controller behaviors.

Use these rules:

1. Prefer `Exact` for a single fixed API path.
2. Prefer `PathPrefix` for normal application subtrees such as `/api` or `/console`.
3. Use `RegularExpression` only when the old Ingress required regex behavior.
4. Re-test every regex rule because Envoy Gateway uses RE2-style regular expressions.
5. When a specific API path overlaps a broad frontend path, make the specific path `Exact` so it cannot be shadowed by a broader prefix or regex route.

Example:

```yaml
rules:
  - matches:
      - path:
          type: Exact
          value: /shop/admin/reports
    backendRefs:
      - name: shop-admin-api
        port: 80
  - matches:
      - path:
          type: RegularExpression
          value: /shop(/|$)(.*)
    backendRefs:
      - name: shop-web
        port: 8080
```

## Chapter 6. Plan a Smooth Cutover Behind a Front Load Balancer

When a front load balancer already owns the external address, do not move the external LB IP during the migration. Keep the public or private LB listener unchanged, and switch only the backend pool from the old ingress controller nodes to the new Envoy Gateway nodes.

Use this model:

```text
client -> front load balancer external IP -> backend targets -> old ingress or Envoy Gateway
```

The front load balancer should keep the same external IP, DNS record, listener ports, TLS mode, and client-facing health check behavior. The migration changes its backend targets and weights.

Before changing traffic, record:

| Area | What to record |
| ---- | -------------- |
| Frontend | External IP, DNS name, listener ports, TLS termination or passthrough mode |
| Old backend pool | Node IPs, backend ports, health check path and port, backend weight |
| Gateway backend pool | New node IPs, backend ports, health check path and port |
| Traffic shifting | Whether the front load balancer supports disabled backends, weights, drain, or immediate pool replacement |
| Source address | Whether the application depends on client source IP, `X-Forwarded-*` headers, or PROXY protocol |

### Option A: Parallel hostNetwork with port offset

This is the safest hostNetwork pattern when the old ingress controller still binds node ports `80` and `443`. Envoy Gateway can run with `hostNetwork: true` and the default privileged-port offset. Listener port `80` is reached on node port `10080`, and listener port `443` is reached on node port `10443`.

The external LB IP remains unchanged because only the front load balancer backend port changes.

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: project-gateway
  namespace: project-gateway
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: ClusterIP
      envoyDeployment:
        replicas: 2
        patch:
          type: StrategicMerge
          value:
            spec:
              template:
                spec:
                  hostNetwork: true
                  dnsPolicy: ClusterFirstWithHostNet
        pod:
          nodeSelector:
            gateway-role: envoy
```

Cutover flow:

1. Label a node set for Envoy Gateway, for example `gateway-role=envoy`.
2. Deploy the `Gateway`, `EnvoyProxy`, `HTTPRoute`, `Backend`, and policy resources.
3. Test the new data plane directly by sending requests to a Gateway node on `10080` or `10443` with the original Host header.
4. Add the Gateway nodes to the front load balancer backend pool with backend ports `10080` and `10443`, initially disabled or with weight `0` if the load balancer supports it.
5. Enable a small percentage of traffic or one low-risk hostname.
6. Increase traffic to the Gateway backend pool after status codes, latency, rewrite behavior, and backend TLS are verified.
7. Remove the old ingress backend pool after the Gateway has served all traffic for the agreed observation window.

Rollback is only a front load balancer operation: disable or set weight `0` for the Gateway backend pool and restore traffic to the old ingress backend pool.

### Option B: hostNetwork on standard ports

Use this option only when the front load balancer must send traffic to node ports `80` and `443`, or when compatibility requires Envoy Gateway to bind the same host ports as the old ingress controller.

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: project-gateway
  namespace: project-gateway
spec:
  provider:
    type: Kubernetes
    kubernetes:
      useListenerPortAsContainerPort: true
      envoyService:
        type: ClusterIP
      envoyDeployment:
        replicas: 2
        patch:
          type: StrategicMerge
          value:
            spec:
              strategy:
                type: RollingUpdate
                rollingUpdate:
                  maxSurge: 0
                  maxUnavailable: 1
              template:
                spec:
                  hostNetwork: true
                  dnsPolicy: ClusterFirstWithHostNet
                  containers:
                    - name: envoy
                      command:
                        - /usr/local/bin/envoy-with-cap
                      securityContext:
                        capabilities:
                          add:
                            - NET_BIND_SERVICE
        pod:
          nodeSelector:
            gateway-role: envoy
```

With this option, the old ingress pod and the new Envoy pod cannot bind the same host port on the same node. A smooth migration therefore requires one of these layouts:

- Use a separate Gateway node set. Add those nodes to the front load balancer backend pool on ports `80` and `443`, shift traffic, then remove the old ingress nodes.
- If no separate nodes are available, first drain or remove a node from the old ingress backend pool, stop the old ingress pod on that node so ports `80` and `443` are free, schedule Envoy Gateway there, validate it, and then add the node back as a Gateway backend.
- If neither separate nodes nor per-node draining is possible, the cutover cannot be fully smooth on the same host ports. Use the port-offset pattern or plan a short maintenance window.

### Option C: NodePort behind the front load balancer

If hostNetwork is not required, expose Envoy Gateway as `NodePort` and point the front load balancer to the assigned NodePort values. The external LB IP remains unchanged; only backend target ports change.

This pattern avoids host port conflicts, but the backend ports are in the Kubernetes NodePort range. Do not configure the front load balancer to use listener ports `80` and `443` unless the NodePort values have been explicitly assigned to those numbers and are valid for the cluster's NodePort range.

## Chapter 7. Validate Before Cutover

### Step 1: Validate resource status

```bash
kubectl get gateway -A
kubectl get httproute -A
kubectl get backend -A
kubectl get backendtlspolicy -A
kubectl get securitypolicy -A
kubectl get clienttrafficpolicy -A
kubectl get backendtrafficpolicy -A
```

Inspect rejected resources:

```bash
kubectl get httproute -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{" "}{.status.parents[*].conditions[*].type}{" "}{.status.parents[*].conditions[*].status}{"\n"}{end}'
```

### Step 2: Test through the Gateway address before DNS cutover

Get the Gateway Service address or the front load balancer backend target address:

```bash
kubectl get svc -n project-gateway \
  -l gateway.envoyproxy.io/owning-gateway-name=project-gateway
```

Run the recorded request cases against the Gateway VIP, NodePort, hostNetwork node port, or front load balancer canary backend while preserving the original Host header:

```bash
export GATEWAY_ADDRESS="192.0.2.20"
export GATEWAY_PORT="443"

while read -r url; do
  host="$(printf '%s\n' "$url" | sed -E 's#^https?://([^/]+)/?.*#\1#')"
  path="$(printf '%s\n' "$url" | sed -E 's#^https?://[^/]+##')"
  [ -n "$path" ] || path="/"
  curl -k -i -H "Host: ${host}" "https://${GATEWAY_ADDRESS}:${GATEWAY_PORT}${path}"
done < migration-cases.txt
```

Verify:

- Status codes match the old Ingress behavior.
- Redirect `Location` headers are correct.
- Required response headers are present.
- Backend request paths are correct after rewrite.
- Authentication and CORS behavior match the original requirement.
- HTTPS backends do not return TLS or upstream protocol errors.

### Step 3: Run both entries during cutover

Keep the old Ingress active until the new Gateway path has passed functional checks. Cut over by changing DNS, the external load balancer backend, or the VIP binding according to your environment.

During cutover:

1. Start with a low-risk hostname or low-traffic application.
2. Monitor HTTP error rate, latency, and Envoy Gateway resource conditions.
3. Keep the old Ingress manifest unchanged for rollback.
4. When a front load balancer owns the external IP, keep the frontend IP and listener unchanged; shift only the backend pool or backend weight.
5. When reusing a MetalLB VIP, release the old LoadBalancer Service before creating or exposing the new Gateway Service with `metallb.universe.tf/loadBalancerIPs`.
6. If errors appear, point traffic back to the old Ingress entry and inspect the rejected Gateway API resource or Envoy Gateway logs.

## Chapter 8. Rollback

Rollback should be a traffic steering operation, not a resource reconstruction exercise.

Before cutover, make sure:

- The old `Ingress` and its TLS `Secret` still exist.
- The old ingress controller or ALB instance is still serving traffic.
- DNS TTL or external load balancer backend changes can be reverted.
- If a front load balancer is used, the old backend pool and health checks are still present or can be restored immediately.
- The Gateway API resources are applied separately so they can be removed without touching application `Service` or `Deployment` resources.

Rollback examples:

```bash
# Remove only the new Gateway API route.
kubectl delete httproute demo-web -n demo

# Or move DNS / external LB traffic back to the old Ingress address.
kubectl get ingress demo-web -n demo
```

## Troubleshooting

| Symptom | Check |
| ------- | ----- |
| `HTTPRoute` is ignored | `parentRefs`, listener `sectionName`, listener protocol, and `allowedRoutes` namespace rules |
| 404 from Envoy Gateway | Hostname intersection, path type, path value, and route precedence |
| TLS certificate is not used | Listener `certificateRefs`, Secret namespace, Secret type, and `ReferenceGrant` for cross-namespace references |
| Backend returns 503 or TLS errors | Backend protocol, whether HTTPS upstreams use `Backend` instead of a plain `Service` backendRef, `BackendTLSPolicy` when used, CA secret key `ca.crt`, and SNI hostname |
| Redirect loop | HTTP and HTTPS routes both redirecting, or redirect target points back to the HTTP listener |
| Regex route matches too much | Replace with `Exact` or `PathPrefix` where possible; add path boundary such as `(/|$)` when regex is required |
| Header-based affinity changed | Use `BackendTrafficPolicy` consistent hash by request header for ALB or ingress-nginx `upstream-hash-by` style behavior |
| In-cluster clients cannot reach the LoadBalancer VIP | Use the Gateway Service ClusterIP for in-cluster traffic, or change `EnvoyProxy` `externalTrafficPolicy` only when that behavior is intentionally required |
| Gateway pod cannot start with hostNetwork | Check whether another pod already binds the same host port on that node; use a separate node set, the default port-offset pattern, or `maxSurge: 0` during rolling updates |
| Front load balancer health checks fail after migration | Check the backend target port. With hostNetwork port offset, listener `80` maps to node port `10080` and listener `443` maps to node port `10443`. With standard host ports, Envoy must bind `80` and `443` successfully. |

## References

- Gateway API: [Migrating from Ingress](https://gateway-api.sigs.k8s.io/guides/getting-started/migrating-from-ingress/)
- Kubernetes SIG Network: [ingress2gateway](https://github.com/kubernetes-sigs/ingress2gateway)
- Kubernetes Blog: [Before You Migrate: Five Surprising Ingress-NGINX Behaviors You Need to Know](https://kubernetes.io/blog/2026/02/27/ingress-nginx-before-you-migrate/)
- Kubernetes Blog: [Announcing Ingress2Gateway 1.0: Your Path to Gateway API](https://kubernetes.io/blog/2026/03/20/ingress2gateway-1-0-release/)
- ACP Docs: [Envoy Gateway Operator](https://docs-dev.alauda.cn/container_platform/main/networking/operators/envoy_gateway_operator)
- ACP Docs: [Configure GatewayAPI Gateway](https://docs-dev.alauda.cn/container_platform/main/configure/networking/functions/configure_gatewayapi_gateway)
- ACP Docs: [Configure GatewayAPI Route](https://docs-dev.alauda.cn/container_platform/main/configure/networking/functions/configure_gatewayapi_route)
- ACP Docs: [Configure GatewayAPI Policy](https://docs-dev.alauda.cn/container_platform/main/configure/networking/functions/configure_gatewayapi_policy)
- ACP Docs: [Tasks for Envoy Gateway](https://docs-dev.alauda.cn/container_platform/main/configure/networking/how_to/tasks_for_envoy_gateway)
- ACP Docs: [Ingress Load Balancing with Envoy Gateway](https://docs-dev.alauda.cn/container_platform/main/networking/ingress_loadbalancing/ingress_loadbalance_with_envoy_gateway)
