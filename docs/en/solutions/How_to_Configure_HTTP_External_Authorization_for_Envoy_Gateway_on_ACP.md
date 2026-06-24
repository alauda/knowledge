---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x and later
tags:
  - LB
---

# How to Configure HTTP External Authorization for Envoy Gateway on ACP

## Overview

This guide describes how to configure HTTP external authorization for Envoy Gateway on Alauda Container Platform (ACP) 4.3.x and later.

ACP 4.3 uses Envoy Gateway 1.7. The upstream Envoy Gateway CRDs are supported at the YAML level without additional wrapping or field trimming. The ACP UI may not expose every upstream CRD field or every valid combination of fields. For advanced Envoy Gateway capabilities such as external authorization, request body forwarding, dynamic request header injection, `failOpen`, and external authorization backend health checks, configure the resources directly with YAML.

The examples use a mock authorization server to demonstrate the behavior. In a production environment, replace the mock authorization Service in `SecurityPolicy.spec.extAuth.http.backendRefs` with the actual external authorization Service.

The common traffic flow is:

```text
Client
  |
  v
Gateway listener
  |
  +-- SecurityPolicy extAuth --> external authorization Service
  |
  v
Application backend Service
```

## Prerequisites

1. ACP 4.3.x or later.
2. Envoy Gateway Operator has been installed.
3. An `EnvoyGatewayCtl` instance has been created, and its generated `GatewayClass` is accepted.
4. `kubectl` can access the target cluster.
5. The namespace, application backend Service, and external authorization Service are known.

The examples in this document use the following names. Replace them with values from your environment.

| Item | Example value |
| ---- | ------------- |
| Namespace | `demo-space` |
| GatewayClass | `demo-space-external-auth` |
| Gateway | `external-auth-gateway` |
| Listener | `http` |
| Application route | `app-route` |
| Application backend Service | `app-backend` |
| Mock authorization Service | `mock-auth` |
| Gateway listener port | `7100` |

## Chapter 1. Prepare a Mock Authorization Server

Use a mock server when you need to verify the Envoy Gateway behavior before connecting a real authorization service.

The mock server exposes three endpoints:

- `/auth/allow`: returns `200` and allows the request.
- `/auth/deny`: returns `403` and rejects the request.
- `/healthz`: returns `200` for external authorization backend health checks.

The `/auth/allow` endpoint also returns response headers that can be forwarded to the application backend:

- `x-auth-user`
- `x-auth-body-bytes`
- `x-auth-extra`

Create the mock server:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mock-auth-config
  namespace: demo-space
data:
  nginx-config: |
    worker_processes  1;
    daemon off;
    pid nginx.pid;

    events {
        worker_connections  1024;
    }

    http {
        access_log  /dev/stdout;
        error_log   /dev/stdout  info;

        server {
            listen 80;
            listen [::]:80;

            location /auth/allow {
              content_by_lua_block {
                ngx.req.read_body()
                local body = ngx.req.get_body_data() or ""
                ngx.header["x-auth-user"] = "mock-user"
                ngx.header["x-auth-body-bytes"] = tostring(string.len(body))
                ngx.header["x-auth-extra"] = ngx.var.http_x_ext_auth_extra or ""
                ngx.status = 200
                ngx.say("allow")
              }
            }

            location /auth/deny {
              content_by_lua_block {
                ngx.status = 403
                ngx.say("deny")
              }
            }

            location /healthz {
              content_by_lua_block {
                ngx.status = 200
                ngx.say("ok")
              }
            }
        }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mock-auth
  namespace: demo-space
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mock-auth
  template:
    metadata:
      labels:
        app: mock-auth
    spec:
      containers:
        - name: nginx
          image: registry.alauda.cn:60070/acp/alb2:v4.3.5
          command:
            - /usr/local/openresty/nginx/sbin/nginx
            - -c
            - /etc/nginx/nginx.conf
          ports:
            - name: http
              containerPort: 80
          volumeMounts:
            - name: nginx-config
              mountPath: /etc/nginx
      volumes:
        - name: nginx-config
          configMap:
            name: mock-auth-config
            items:
              - key: nginx-config
                path: nginx.conf
---
apiVersion: v1
kind: Service
metadata:
  name: mock-auth
  namespace: demo-space
spec:
  selector:
    app: mock-auth
  ports:
    - name: http
      port: 80
      targetPort: 80
```

The following sample backend prints the authorization headers that Envoy forwards to the application request. Use it only for validation.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-backend-config
  namespace: demo-space
data:
  nginx-config: |
    worker_processes  1;
    daemon off;
    pid nginx.pid;

    events {
        worker_connections  1024;
    }

    http {
        access_log  /dev/stdout;
        error_log   /dev/stdout  info;

        server {
            listen 80;
            listen [::]:80;

            location / {
              content_by_lua_block {
                ngx.say("backend reached")
                ngx.say("x-auth-user=" .. (ngx.var.http_x_auth_user or ""))
                ngx.say("x-auth-body-bytes=" .. (ngx.var.http_x_auth_body_bytes or ""))
                ngx.say("x-auth-extra=" .. (ngx.var.http_x_auth_extra or ""))
              }
            }
        }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-backend
  namespace: demo-space
spec:
  replicas: 1
  selector:
    matchLabels:
      app: app-backend
  template:
    metadata:
      labels:
        app: app-backend
    spec:
      containers:
        - name: nginx
          image: registry.alauda.cn:60070/acp/alb2:v4.3.5
          command:
            - /usr/local/openresty/nginx/sbin/nginx
            - -c
            - /etc/nginx/nginx.conf
          ports:
            - name: http
              containerPort: 80
          volumeMounts:
            - name: nginx-config
              mountPath: /etc/nginx
      volumes:
        - name: nginx-config
          configMap:
            name: app-backend-config
            items:
              - key: nginx-config
                path: nginx.conf
---
apiVersion: v1
kind: Service
metadata:
  name: app-backend
  namespace: demo-space
spec:
  selector:
    app: app-backend
  ports:
    - name: http
      port: 80
      targetPort: 80
```

## Chapter 2. Create the Gateway, Companion EnvoyProxy, and Base HTTPRoute

Create a `Gateway` that uses the `GatewayClass` generated by `EnvoyGatewayCtl`, create a companion `EnvoyProxy`, and create an `HTTPRoute` for the application backend.

The recommended ACP deployment pattern is one `Gateway` with one dedicated companion `EnvoyProxy`. The `Gateway` references the `EnvoyProxy` through `.spec.infrastructure.parametersRef`. The `EnvoyProxy` controls the underlying Envoy data plane configuration, such as the Service type, replicas, resources, and scheduling.

When a Gateway is created from the ACP Web Console with an `EnvoyGatewayCtl`-created `GatewayClass`, the console automatically creates a companion `EnvoyProxy` with the same name and namespace. When applying YAML directly, keep `.spec.infrastructure.parametersRef` and the referenced `EnvoyProxy` resource consistent.

The example below uses `ClusterIP` for the Envoy data plane Service. For production external exposure, change `EnvoyProxy.spec.provider.kubernetes.envoyService.type` to `LoadBalancer` when the cluster has a LoadBalancer provider such as MetalLB.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: external-auth-gateway
  namespace: demo-space
spec:
  infrastructure:
    parametersRef:
      group: gateway.envoyproxy.io
      kind: EnvoyProxy
      name: external-auth-gateway
  gatewayClassName: demo-space-external-auth
  listeners:
    - name: http
      protocol: HTTP
      port: 7100
      allowedRoutes:
        namespaces:
          from: Same
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: external-auth-gateway
  namespace: demo-space
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: ClusterIP
      envoyDeployment:
        replicas: 1
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app-route
  namespace: demo-space
spec:
  parentRefs:
    - name: external-auth-gateway
      sectionName: http
  rules:
    - backendRefs:
        - name: app-backend
          port: 80
```

Get the Gateway address:

```bash
export GW_IP="$(
  kubectl get gateway external-auth-gateway \
    -n demo-space \
    -o jsonpath='{.status.addresses[0].value}'
)"
```

If the Gateway status does not contain an address, get the address from the Envoy Gateway data plane Service created for the Gateway.

## Chapter 3. Configure Basic HTTP External Authorization

### Purpose

Use this scenario when every request must be checked by an external authorization service before it reaches the application backend. When the authorization service returns a 2xx status code, Envoy forwards the request to the backend.

### Configuration points

- Attach `SecurityPolicy` to the `HTTPRoute` that needs authorization.
- Use `extAuth.http.backendRefs` to point to the authorization Service.
- Use `extAuth.http.path` to set the authorization endpoint path.
- Use `extAuth.http.headersToBackend` to forward selected response headers from the authorization service to the application backend.

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/allow
      headersToBackend:
        - x-auth-user
        - x-auth-body-bytes
        - x-auth-extra
```

### Verification

Send a request through the Gateway:

```bash
curl -s -w '\n%{http_code}\n' \
  -H 'content-type: application/json' \
  --data '{"action":"allow"}' \
  "http://${GW_IP}:7100/allow"
```

Expected output:

```text
backend reached
x-auth-user=mock-user
x-auth-body-bytes=18
x-auth-extra=
200
```

## Chapter 4. Send the Request Body to the Authorization Service

### Purpose

Use this scenario when the authorization service must inspect the request body, such as JSON fields, form values, or uploaded content.

### Configuration points

Set `extAuth.bodyToExtAuth.maxRequestBytes` to the maximum body size that Envoy should buffer and send to the authorization service. If the request body is larger than this limit, Envoy returns `413` and does not call the authorization service.

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/allow
      headersToBackend:
        - x-auth-user
        - x-auth-body-bytes
    bodyToExtAuth:
      maxRequestBytes: 1024
```

### Verification

Send a small request body:

```bash
curl -s -w '\n%{http_code}\n' \
  -H 'content-type: application/json' \
  --data '{"action":"allow"}' \
  "http://${GW_IP}:7100/body"
```

Expected output:

```text
backend reached
x-auth-user=mock-user
x-auth-body-bytes=18
200
```

Send a request body larger than `maxRequestBytes`:

```bash
python3 -c 'print("x" * 2048)' | curl -s -w '\n%{http_code}\n' \
  -H 'content-type: text/plain' \
  --data-binary @- \
  "http://${GW_IP}:7100/oversize"
```

Expected output:

```text
Payload Too Large
413
```

This `413` behavior takes precedence over `failOpen`.

## Chapter 5. Inject a Dynamic Header Before External Authorization

### Purpose

Use this scenario when the authorization service needs information from Envoy, such as the downstream remote address, and that information is not available in the original request headers.

### Configuration points

Use `ClientTrafficPolicy.spec.headers.earlyRequestHeaders.set` to inject a request header at the Gateway listener. Values can use Envoy command operators such as `%DOWNSTREAM_REMOTE_ADDRESS%`. To pass the injected header to the authorization service, list the header in `SecurityPolicy.spec.extAuth.headersToExtAuth`.

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: ext-auth-extra-header
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: external-auth-gateway
    sectionName: http
  headers:
    earlyRequestHeaders:
      set:
        - name: x-ext-auth-extra
          value: "%DOWNSTREAM_REMOTE_ADDRESS%"
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    headersToExtAuth:
      - x-ext-auth-extra
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/allow
      headersToBackend:
        - x-auth-user
        - x-auth-body-bytes
        - x-auth-extra
```

### Verification

```bash
curl -s -w '\n%{http_code}\n' \
  -H 'content-type: application/json' \
  --data '{"action":"allow"}' \
  "http://${GW_IP}:7100/extra"
```

Expected output contains a rendered downstream address instead of the literal command operator:

```text
backend reached
x-auth-user=mock-user
x-auth-body-bytes=18
x-auth-extra=10.3.1.17:59296
200
```

## Chapter 6. Pass Explicit Request Headers to the Authorization Service

### Purpose

Use this scenario when the authorization service needs selected request headers, such as user identity, tenant identity, request ID, or proxy chain information.

### Configuration points

HTTP external authorization does not provide a wildcard setting to forward all request headers. List each required header in `SecurityPolicy.spec.extAuth.headersToExtAuth`.

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    headersToExtAuth:
      - x-ext-auth-extra
      - x-request-id
      - x-forwarded-for
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/allow
      headersToBackend:
        - x-auth-extra
```

The mock server in this guide echoes only `x-ext-auth-extra`. Add more echo logic to the mock server if you need to validate additional headers.

## Chapter 7. Reject Requests

### Purpose

Use this scenario when the authorization service denies a request. Envoy should stop the request at the Gateway and should not forward it to the application backend.

### Configuration points

The authorization service rejects a request by returning a non-2xx status code. The example below uses `/auth/deny`, which returns `403`.

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/deny
```

### Verification

```bash
curl -s -w '\n%{http_code}\n' \
  -H 'content-type: application/json' \
  --data '{"action":"deny"}' \
  "http://${GW_IP}:7100/deny"
```

Expected output:

```text
deny
403
```

## Chapter 8. Configure Failure Behavior with `failOpen`

### Purpose

Use this scenario to define what Envoy should do when the authorization service is unavailable, times out, or returns an unexpected error.

For security-first deployments, keep the default fail-closed behavior. Use fail-open behavior only when the application can safely accept traffic while the authorization service is unavailable.

### Configuration points

The Istio `failure_mode_allow` behavior maps to `SecurityPolicy.spec.extAuth.failOpen` in Envoy Gateway.

When `failOpen` is `false` or omitted, an unavailable authorization backend returns a 5xx response:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    failOpen: false
    http:
      backendRefs:
        - name: mock-auth-missing
          port: 80
      path: /auth/allow
```

Expected result:

```text
500
```

When `failOpen` is `true`, Envoy bypasses the authorization failure and forwards the request to the backend:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    failOpen: true
    http:
      backendRefs:
        - name: mock-auth-missing
          port: 80
      path: /auth/allow
      headersToBackend:
        - x-auth-user
```

Expected result:

```text
backend reached
x-auth-user=
200
```

## Chapter 9. Configure External Authorization Backend Health Checks

### Purpose

Use this scenario to let Envoy actively check the health of the external authorization backend. This helps Envoy detect authorization backend failures and apply the configured `failOpen` behavior.

### Configuration points

Configure the health check under `SecurityPolicy.spec.extAuth.http.backendSettings.healthCheck`. Do not configure this health check on the application backend `BackendTrafficPolicy`.

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-route
  extAuth:
    failOpen: false
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/allow
      backendSettings:
        healthCheck:
          active:
            type: HTTP
            interval: 1s
            timeout: 1s
            healthyThreshold: 1
            unhealthyThreshold: 1
            http:
              path: /healthz
              expectedStatuses:
                - 200
      headersToBackend:
        - x-auth-user
        - x-auth-body-bytes
```

The mock server returns `200` on `/healthz`. If the health check returns a non-200 status or the authorization Service is unreachable, request handling follows the configured `failOpen` value.

## Chapter 10. Skip Authorization for gRPC or WebSocket Traffic

### Purpose

Use this scenario when the same Gateway carries normal HTTP traffic and protocol-specific traffic such as gRPC or WebSocket, but only the normal HTTP traffic should use HTTP external authorization.

### Configuration points

`SecurityPolicy` does not provide a separate switch to skip external authorization by gRPC or WebSocket protocol. Split the traffic into separate routes. Attach `SecurityPolicy` only to the routes that need external authorization.

Example HTTP route with external authorization:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app-http-route
  namespace: demo-space
spec:
  parentRefs:
    - name: external-auth-gateway
      sectionName: http
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /http
      backendRefs:
        - name: app-backend
          port: 80
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: app-http-extauth
  namespace: demo-space
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: app-http-route
  extAuth:
    http:
      backendRefs:
        - name: mock-auth
          port: 80
      path: /auth/allow
```

Example WebSocket route without external authorization:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app-websocket-route
  namespace: demo-space
spec:
  parentRefs:
    - name: external-auth-gateway
      sectionName: http
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /ws
      backendRefs:
        - name: websocket-backend
          port: 80
```

Example gRPC route without external authorization:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: app-grpc-route
  namespace: demo-space
spec:
  parentRefs:
    - name: external-auth-gateway
      sectionName: http
  rules:
    - backendRefs:
        - name: grpc-backend
          port: 50051
```

With this layout, requests matching the route with `SecurityPolicy` are checked by the authorization service. Requests matching the WebSocket or gRPC routes bypass the mock authorization server and go directly to their own backend Services.

## Field Reference

| Requirement | Envoy Gateway configuration |
| ----------- | --------------------------- |
| HTTP external authorization Service | `SecurityPolicy.spec.extAuth.http.backendRefs` |
| Authorization request path | `SecurityPolicy.spec.extAuth.http.path` |
| Send request body to authorization Service | `SecurityPolicy.spec.extAuth.bodyToExtAuth.maxRequestBytes` |
| Forward authorization response headers to backend | `SecurityPolicy.spec.extAuth.http.headersToBackend` |
| Send selected request headers to authorization Service | `SecurityPolicy.spec.extAuth.headersToExtAuth` |
| Inject `%DOWNSTREAM_REMOTE_ADDRESS%` or another dynamic value | `ClientTrafficPolicy.spec.headers.earlyRequestHeaders.set` |
| Istio `failure_mode_allow` equivalent | `SecurityPolicy.spec.extAuth.failOpen` |
| External authorization backend health check | `SecurityPolicy.spec.extAuth.http.backendSettings.healthCheck` |
| Skip external authorization for gRPC or WebSocket | Split routes and attach `SecurityPolicy` only to routes that need authorization |
