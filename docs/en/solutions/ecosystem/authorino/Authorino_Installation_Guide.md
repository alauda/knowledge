---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3'
id: KB260700062
---

# Authorino Installation Guide

## Overview

Authorino is a Kubernetes-native external authorization service originally built by the Kuadrant project. It plugs into the [Envoy external authorization](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/ext_authz_filter) gRPC protocol and lets you declare authentication and authorization rules through `AuthConfig` custom resources. This guide describes how to install the Authorino Operator from the ACP Marketplace, create an `Authorino` instance, and validate end-to-end authorization through Envoy with an API-key example.

### Supported Versions

| Component | Supported Versions |
|-----------|--------------------|
| Authorino Operator | 0.25.1 |
| Authorino (operand) | 0.26.1 |
| Envoy (data plane for the quickstart) | 1.31 |

## Prerequisites

- An ACP cluster with the **OperatorHub** feature enabled.
- A target namespace where you will deploy the `Authorino` instance and the protected workload.
- Business cluster nodes can access the platform image registry.
- (Optional) The `violet` CLI, downloaded from **App Store > App Onboarding** and matching the target platform version. Only required if the Authorino Operator plugin package is not yet uploaded to the target platform.

## Install the Authorino Operator

1. Download the **Authorino Operator** plugin from the [Alauda Cloud Console](https://cloud.alauda.io/) Marketplace.
2. If the plugin package has not been uploaded to the target platform, follow the [Upload Packages](https://docs.alauda.io/container_platform/4.2/extend/upload_package.html) guide to upload it to the cluster, or push directly with `violet`:

   ```bash
   violet push \
     --platform-address <platform-address> \
     --clusters <business-cluster-name> \
     --platform-username <platform-admin-username> \
     --platform-password <platform-admin-password> \
     <authorino-operator-plugin-package>.tgz
   ```

3. Sign in to the platform as an administrator. Navigate to **Administrator > Marketplace > OperatorHub**.
4. Locate **Authorino Operator** and click **Install**. Choose the target namespace, accept the defaults, and click **Install** again. The platform creates a `Subscription` and approves the `InstallPlan`.
5. Wait until the operator `ClusterServiceVersion` reaches the `Succeeded` phase.

### Verify the Operator

```bash
# The CSV should be in the Succeeded phase
kubectl -n <operator-namespace> get csv | grep authorino

# The operator Deployment should be Available
kubectl -n <operator-namespace> get deploy -l app=authorino-operator
```

Expected result:

- The `authorino-operator.v0.25.1` CSV is in the `Succeeded` phase.
- The `authorino-operator` Deployment is `1/1` ready.

## Quick Start: Protect an API with API-Key Authentication

This section demonstrates a complete, self-contained example: the Authorino instance authorizes traffic for a sample upstream service through Envoy. A request with a valid API key is allowed (HTTP 200), and a request without a key (or with an invalid key) is denied (HTTP 401).

Set variables used in the commands below:

```bash
export NAMESPACE=authorino-demo
export CR=authorino-sample
export HOST=talker-api.authorino-demo
export API_KEY=admin123456
kubectl create namespace ${NAMESPACE}
```

### 1. Create an Authorino Instance

```yaml
apiVersion: operator.authorino.kuadrant.io/v1beta1
kind: Authorino
metadata:
  name: authorino-sample
  namespace: authorino-demo
spec:
  clusterWide: false
  replicas: 1
  listener:
    tls:
      enabled: false
  oidcServer:
    tls:
      enabled: false
```

Apply the manifest and wait for the instance to become ready:

```bash
kubectl apply -f authorino.yaml
kubectl -n ${NAMESPACE} wait authorino/${CR} --for=condition=Ready --timeout=300s
kubectl -n ${NAMESPACE} rollout status deploy/${CR}
```

Expected result:

- The `Authorino` resource reports `status.conditions[Ready] = True`.
- The `${CR}` operand Deployment is Available.
- A Service named `${CR}-authorino-authorization` exists and exposes `50051/TCP` (gRPC external authorization) and `5001/TCP` (OIDC / Festival-Wristband server).

> [!NOTE]
> Authorino's external authorization interface is **gRPC-only on port 50051**. Port 5001 is the OIDC/Festival-Wristband HTTP server and will return 404 for plain HTTP authorization probes. Always go through Envoy (or another `ext_authz` client) when validating authorization decisions.

### 2. Create the API Key Secret and AuthConfig

The Secret stores the API key. Authorino watches Secrets that carry the `authorino.kuadrant.io/managed-by=authorino` label, and the `AuthConfig` selects them with a label matcher.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: api-key-1
  namespace: authorino-demo
  labels:
    app: talker-api
    authorino.kuadrant.io/managed-by: authorino
stringData:
  api_key: admin123456
type: Opaque
---
apiVersion: authorino.kuadrant.io/v1beta3
kind: AuthConfig
metadata:
  name: talker-api-protection
  namespace: authorino-demo
spec:
  hosts:
    - talker-api.authorino-demo
  authentication:
    api-key-users:
      apiKey:
        selector:
          matchLabels:
            app: talker-api
      credentials:
        authorizationHeader:
          prefix: APIKEY
```

Apply and confirm the AuthConfig is `Ready`:

```bash
kubectl apply -f authconfig.yaml
kubectl -n ${NAMESPACE} get authconfig talker-api-protection \
  -o jsonpath='{.status.summary}{"\n"}'
```

Expected result: `numHostsReady` is `1/1` and `ready` is `true`.

### 3. Deploy a Sample Upstream and Envoy Data Plane

Envoy is required because Authorino is gRPC-only. The Envoy configuration below sets up an HTTP listener on port 8000, calls Authorino through the `ext_authz` filter, and routes allowed traffic to a tiny echo upstream.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: upstream
  namespace: authorino-demo
spec:
  replicas: 1
  selector: {matchLabels: {app: upstream}}
  template:
    metadata: {labels: {app: upstream}}
    spec:
      containers:
        - name: echo
          image: python:3.12-alpine
          command:
            - python3
            - -c
            - |
              from http.server import BaseHTTPRequestHandler, HTTPServer
              class H(BaseHTTPRequestHandler):
                  def do_GET(s):
                      s.send_response(200); s.end_headers(); s.wfile.write(b'ok')
              HTTPServer(('', 8080), H).serve_forever()
          ports: [{containerPort: 8080}]
---
apiVersion: v1
kind: Service
metadata: {name: upstream, namespace: authorino-demo}
spec:
  selector: {app: upstream}
  ports: [{port: 8080, targetPort: 8080}]
---
apiVersion: v1
kind: ConfigMap
metadata: {name: envoy-config, namespace: authorino-demo}
data:
  envoy.yaml: |
    static_resources:
      listeners:
        - name: ingress
          address: {socket_address: {address: 0.0.0.0, port_value: 8000}}
          filter_chains:
            - filters:
                - name: envoy.filters.network.http_connection_manager
                  typed_config:
                    "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                    stat_prefix: ingress
                    route_config:
                      name: r
                      virtual_hosts:
                        - name: vh
                          domains: ["*"]
                          routes:
                            - match: {prefix: "/"}
                              route: {cluster: upstream}
                    http_filters:
                      - name: envoy.filters.http.ext_authz
                        typed_config:
                          "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz
                          transport_api_version: V3
                          failure_mode_allow: false
                          grpc_service:
                            timeout: 2s
                            envoy_grpc: {cluster_name: authorino}
                      - name: envoy.filters.http.router
                        typed_config:
                          "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
      clusters:
        - name: upstream
          connect_timeout: 2s
          type: STRICT_DNS
          load_assignment:
            cluster_name: upstream
            endpoints:
              - lb_endpoints:
                  - endpoint: {address: {socket_address: {address: upstream.authorino-demo.svc, port_value: 8080}}}
        - name: authorino
          connect_timeout: 2s
          type: STRICT_DNS
          typed_extension_protocol_options:
            envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
              "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
              explicit_http_config:
                http2_protocol_options: {}
          load_assignment:
            cluster_name: authorino
            endpoints:
              - lb_endpoints:
                  - endpoint: {address: {socket_address: {address: authorino-sample-authorino-authorization.authorino-demo.svc, port_value: 50051}}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: envoy, namespace: authorino-demo}
spec:
  replicas: 1
  selector: {matchLabels: {app: envoy}}
  template:
    metadata: {labels: {app: envoy}}
    spec:
      containers:
        - name: envoy
          image: envoyproxy/envoy:v1.31-latest
          args: ["-c", "/etc/envoy/envoy.yaml", "-l", "info"]
          ports: [{containerPort: 8000}]
          volumeMounts: [{name: cfg, mountPath: /etc/envoy}]
      volumes: [{name: cfg, configMap: {name: envoy-config}}]
---
apiVersion: v1
kind: Service
metadata: {name: envoy, namespace: authorino-demo}
spec:
  selector: {app: envoy}
  ports: [{port: 8000, targetPort: 8000}]
```

> [!IMPORTANT]
> The `authorino` cluster in the Envoy configuration must enable HTTP/2 via `typed_extension_protocol_options`. Authorino's `ext_authz` endpoint is gRPC and requires HTTP/2.

Apply and wait:

```bash
kubectl apply -f dataplane.yaml
kubectl -n ${NAMESPACE} rollout status deploy/upstream
kubectl -n ${NAMESPACE} rollout status deploy/envoy
```

### 4. Verify Authorization Decisions

Run a curl pod in the cluster and exercise four cases:

```bash
kubectl -n ${NAMESPACE} run probe --rm -it --restart=Never \
  --image=curlimages/curl:latest -- sh
```

Inside the probe container:

```sh
HOST=talker-api.authorino-demo
KEY=admin123456
SVC=envoy.authorino-demo.svc:8000

# 1) No credential -> 401
curl -sS -o /dev/null -w 'no-key:     %{http_code}\n'  -H "Host: $HOST" http://$SVC/

# 2) Wrong credential -> 401
curl -sS -o /dev/null -w 'wrong-key:  %{http_code}\n'  -H "Host: $HOST" -H "Authorization: APIKEY wrong" http://$SVC/

# 3) Valid credential -> 200
curl -sS -o /dev/null -w 'valid-key:  %{http_code}\n'  -H "Host: $HOST" -H "Authorization: APIKEY $KEY" http://$SVC/

# 4) Host without a matching AuthConfig -> 404
curl -sS -o /dev/null -w 'wrong-host: %{http_code}\n'  -H "Host: not-protected.example.com" http://$SVC/
```

Expected output:

```text
no-key:     401
wrong-key:  401
valid-key:  200
wrong-host: 404
```

### 5. Inspect the Authorization Decision

```bash
# Envoy side (which hop returned 401)
kubectl -n ${NAMESPACE} logs deploy/envoy --tail=30

# Authorino side (which AuthConfig matched, which evaluator allowed or denied)
kubectl -n ${NAMESPACE} logs deploy/${CR} --tail=30
```

Typical Authorino log lines for the four cases above:

| Case | Log signature |
|------|---------------|
| Valid credential | `authorized=true reason=apiKey "api-key-users"` |
| Wrong credential | `reason=the API key provided was not found` |
| No credential | `reason=credential not found in the request` |
| Wrong host | `status=404 message=service not found` |

## Adding More Authentication Methods

Authorino supports several authentication types declared on the same `AuthConfig`. Add a JWT identity beside the API-key one by extending `spec.authentication`:

```yaml
spec:
  authentication:
    api-key-users:
      apiKey:
        selector:
          matchLabels:
            app: talker-api
      credentials:
        authorizationHeader:
          prefix: APIKEY
    jwt-users:
      jwt:
        issuerUrl: https://my-issuer.example.com/realms/talker
```

The full list of supported identity types is documented in the upstream [AuthConfig reference](https://docs.kuadrant.io/latest/authorino/docs/features/#identity-verification--authentication-authentication).

## Cleanup

For a test deployment, remove the resources created above:

```bash
kubectl delete namespace ${NAMESPACE}
```

To remove the operator, delete its `Subscription` and `ClusterServiceVersion` from **Administrator > Marketplace > OperatorHub > Installed**, or:

```bash
kubectl -n <operator-namespace> delete subscription authorino-operator
kubectl -n <operator-namespace> delete csv authorino-operator.v0.25.1
```

## FAQ

### Why do I need Envoy in front of Authorino?

Authorino implements the [Envoy `ext_authz` gRPC protocol](https://www.envoyproxy.io/docs/envoy/latest/api-v3/service/auth/v3/external_auth.proto). It does not expose a plain HTTP authorization endpoint, so an Envoy (or another `ext_authz` client) must call Authorino on port 50051 over HTTP/2. Sending a plain HTTP request directly to the Authorino Service will not return an authorization decision.

### Why does port 5001 on the Authorino Service return 404 for my requests?

Port 5001 on `<instance>-authorino-authorization` is the OIDC / Festival-Wristband HTTP server. It is not an authorization endpoint and will return 404 for arbitrary paths. Send authorization probes through Envoy on port 8000 in the quickstart, not directly to Authorino.

### Authorino does not see my API key Secret. What is missing?

Authorino only watches Secrets that carry the `authorino.kuadrant.io/managed-by=authorino` label. The `AuthConfig` then narrows the selection with `apiKey.selector.matchLabels` (for example `app: talker-api`). A Secret without the `managed-by` label is ignored even if it matches the `apiKey.selector`.

### The Host header does not seem to take effect

`AuthConfig.spec.hosts` is matched against the request's `Host` header (or the `:authority` pseudo-header for HTTP/2). Some clients override `Host` with the socket address. Use `curl -H "Host: <value>"`, or set `--resolve` explicitly, and confirm with `kubectl logs deploy/envoy`.

### Where can I learn more?

- Upstream documentation: [docs.kuadrant.io/latest/authorino](https://docs.kuadrant.io/latest/authorino/)
- AuthConfig field reference: [docs.kuadrant.io/latest/authorino/docs/features](https://docs.kuadrant.io/latest/authorino/docs/features/)
