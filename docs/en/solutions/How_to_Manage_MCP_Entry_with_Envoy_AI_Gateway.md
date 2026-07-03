---
products:
  - Alauda Container Platform
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
tags:
  - AI
  - Gateway
  - MCP
---

# How to Manage a Unified MCP Entry with Envoy AI Gateway

## Overview

This document describes how to configure a unified MCP entry based on Envoy AI Gateway `MCPRoute`. The resource examples and fields in this document have been validated with Envoy AI Gateway v0.4.0.

The target scenario is that the platform deploys `MCPServer` instances in multiple workload namespaces through MCP Lifecycle Operator and provides one shared Gateway entry. A user's agent only needs to configure one MCP address to access all MCP Servers. The gateway aggregates tool lists, routes requests by tool name, and provides centralized authentication and authorization.

## Design Principles

- The platform provides one shared Gateway entry, avoiding a separate entry gateway for each workload namespace.
- Authentication and authorization are handled at the shared Gateway entry layer for centralized governance.
- MCP service lifecycle management is handled by MCP Lifecycle Operator.
- `MCPRoute` aggregates multiple MCP backends and provides one unified access address to clients.

## Overall Topology

```text
opencode
  -> Envoy Gateway shared Gateway
  -> Entry authentication (API key or OIDC)
  -> MCPRoute aggregates MCP backends from multiple namespaces
  -> MCPServer managed by MCP Lifecycle Operator
```

## MCPServer Integration Model

MCP Lifecycle Operator manages `MCPServer` resources. After a user declares the MCP server image, port, path, environment variables, mounts, resources, probes, and security context, the operator creates a `Deployment` and `Service` with the same name.

The in-cluster backend model is:

```text
MCPServer (workload namespace)
  -> MCP Lifecycle Operator creates a Service with the same name
  -> Platform control plane creates a Backend in the shared Gateway namespace
  -> Unified MCPRoute references the Backend through backendRefs[]
```

In this model, workload namespaces do not need to create a Gateway or `MCPRoute`. Each `MCPServer` maps to one Envoy Gateway `Backend`. The platform control plane adds these `Backend` resources to the unified `MCPRoute.backendRefs`, keeping the external entry, authentication, and governance model consistent.

Design notes:

- The platform uses one shared MCP entry to avoid the resource overhead and entry governance complexity of deploying a separate Gateway for each namespace.
- The external MCP path is fixed to `/mcp`. For multi-team or multi-workload separation, use different hostnames or match on `headers` injected by a trusted entry layer.
- Each MCP backend should use a stable and short `backendRefs[].name`, because it appears in the tool name prefix seen by clients, for example `k8s-mcp-server__get_cluster`.
- In-cluster MCP Servers are managed by MCP Lifecycle Operator `MCPServer` resources. The platform control plane creates an Envoy Gateway `Backend` for each `MCPServer` and adds it to the unified `MCPRoute.backendRefs`.
- External HTTPS MCP Servers use Envoy Gateway `Backend` together with `BackendTLSPolicy`.
- Authentication is handled at the shared Gateway entry layer. API key authentication uses Envoy Gateway `SecurityPolicy.apiKeyAuth`; OIDC uses `MCPRoute.securityPolicy.oauth`.

## Prerequisites

1. Envoy Gateway is deployed in the cluster, and an available `GatewayClass` exists.
2. Envoy AI Gateway is deployed in the cluster.
3. MCP Lifecycle Operator is deployed in the cluster.
4. MCP backends connected to `MCPRoute` provide Streamable HTTP endpoints.

## Configure a Unified MCP Entry

The following example configures a shared entry at `/mcp`. `Gateway`, `EnvoyProxy`, `MCPRoute`, and `Backend` are in the shared namespace `mcp-gateway-system`. The workload namespace only declares `MCPServer`; the platform control plane maps each `MCPServer` to a `Backend` in the shared namespace that can be referenced by `MCPRoute`.

The Envoy data plane Service in this example uses `LoadBalancer` and sets `externalTrafficPolicy: Cluster`. A Kubernetes `LoadBalancer` Service allocates NodePorts by default, so when no cloud load balancer address is available, the entry can also be tested through a node IP and NodePort. The Gateway listener does not set `hostname`, which means the listener does not restrict Host matching. The external domain is still provided by DNS, Ingress/LB, or an upper-layer entry.

All `Backend` resources referenced by the unified `MCPRoute` are placed in the shared namespace. For an in-cluster MCP server, `MCPServer` in the workload namespace first generates a `Service`, and then the platform control plane creates the corresponding `Backend` in the shared namespace. An external MCP server does not have a workload namespace; create its `Backend` and `BackendTLSPolicy` directly in the shared namespace.

```yaml
# Gateway that provides the unified MCP entry.
# No hostname is configured, so the listener does not restrict Host.
# The actual domain is provided by DNS/LB/an upper-layer entry.
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: ai-mcp-gateway
  namespace: mcp-gateway-system
spec:
  # Replace this with an available GatewayClass in the target cluster.
  gatewayClassName: envoy-gateway
  listeners:
    - name: http
      protocol: HTTP
      port: 80
  infrastructure:
    parametersRef:
      group: gateway.envoyproxy.io
      kind: EnvoyProxy
      name: ai-mcp-gateway
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: ai-mcp-gateway
  namespace: mcp-gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        # LoadBalancer allocates NodePorts by default; externalTrafficPolicy is Cluster.
        type: LoadBalancer
        externalTrafficPolicy: Cluster
---
# MCPRoute aggregates multiple MCP backends into the same /mcp entry.
apiVersion: aigateway.envoyproxy.io/v1alpha1
kind: MCPRoute
metadata:
  name: unified-mcp
  namespace: mcp-gateway-system
spec:
  parentRefs:
    # MCPRoute must attach to a Gateway in the same namespace.
    - name: ai-mcp-gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  # Unified MCP path accessed by opencode.
  path: /mcp
  backendRefs:
    # Backend corresponding to an in-cluster MCPServer.
    - name: k8s-mcp-server
      kind: Backend
      group: gateway.envoyproxy.io
      path: /mcp
    # Public external MCP Server, corresponding to the context7 Backend below.
    - name: context7
      kind: Backend
      group: gateway.envoyproxy.io
      path: /mcp
      toolSelector:
        include:
          - resolve-library-id
          - query-docs
```

The `k8s-mcp-server` backend in the workload namespace is managed by MCP Lifecycle Operator. The following `MCPServer` generates a `Deployment` and `Service` with the same name. This example does not require the Gateway to inject backend HTTP credentials into `k8s-mcp-server`.

```yaml
apiVersion: mcp.x-k8s.io/v1alpha1
kind: MCPServer
metadata:
  name: k8s-mcp-server
  # Workload namespace: only MCPServer is placed here, not Gateway/MCPRoute.
  namespace: team-a
spec:
  source:
    type: ContainerImage
    containerImage:
      # Upstream example image for Kubernetes MCP Server.
      ref: quay.io/containers/kubernetes_mcp_server:latest
  config:
    # Port and path where the MCPServer provides Streamable HTTP.
    port: 8080
    path: /mcp
    env:
      - name: LOG_LEVEL
        value: info
  runtime:
    replicas: 1
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
```

Confirm the address generated by the operator:

```bash
kubectl get mcpserver k8s-mcp-server -n team-a
kubectl get service k8s-mcp-server -n team-a
```

The platform control plane creates the corresponding `Backend` for this `MCPServer` in the shared namespace, so that the unified `MCPRoute` can reference it:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: k8s-mcp-server
  # Backend is placed in the shared Gateway namespace for MCPRoute references.
  namespace: mcp-gateway-system
spec:
  endpoints:
    - fqdn:
        # Points to the Service generated by MCPServer in the workload namespace.
        hostname: k8s-mcp-server.team-a.svc.cluster.local
        port: 8080
```

External HTTPS backends use Envoy Gateway `Backend` and `BackendTLSPolicy`. Here, `context7` points to a public MCP Server. It does not mean that a corresponding MCP server is deployed in the shared namespace:

```yaml
# Gateway Backend for the public external MCP Server.
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: context7
  namespace: mcp-gateway-system
spec:
  endpoints:
    - fqdn:
        # Public Streamable HTTP MCP endpoint domain for Context7.
        hostname: mcp.context7.com
        port: 443
---
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: context7-tls
  namespace: mcp-gateway-system
spec:
  targetRefs:
    # TLS validation policy bound to the context7 Backend.
    - group: gateway.envoyproxy.io
      kind: Backend
      name: context7
  validation:
    wellKnownCACertificates: System
    hostname: mcp.context7.com
```

### Header Forwarding in Newer Versions

Newer versions of Envoy AI Gateway provide per-MCP-backend header forwarding. A selected header from the client request can be forwarded only to a specific backend, and the header name can be changed when forwarding to the backend. The fields below follow the newer API. Check the actual installed `MCPRoute` CRD before using them.

This configuration fits the case where the client already holds credentials required by a backend, and the Gateway only performs selective forwarding or header renaming. For example, the client sends `x-context7-api-key`; the Gateway forwards it as `X-Context7-API-Key` only when accessing the `context7` backend. `k8s-mcp-server` does not configure `forwardHeaders`, so it does not receive this header.

```yaml
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: MCPRoute
metadata:
  name: unified-mcp
  namespace: mcp-gateway-system
spec:
  parentRefs:
    - name: ai-mcp-gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  path: /mcp
  backendRefs:
    - name: context7
      kind: Backend
      group: gateway.envoyproxy.io
      path: /mcp
      # Newer versions support per-backend client header forwarding and renaming.
      forwardHeaders:
        - name: x-context7-api-key
          backendHeader: X-Context7-API-Key
    - name: k8s-mcp-server
      kind: Backend
      group: gateway.envoyproxy.io
      path: /mcp
      # Without forwardHeaders, client credential headers are not forwarded to this backend.
```

## Use API Key for Entry Authentication

The shared Envoy Gateway can use `SecurityPolicy.apiKeyAuth` for entry API key authentication. The API key only protects the unified MCP entry and is not the same as backend MCP server access credentials. Backend credentials are handled independently per MCP backend.

The entry API key is stored in a Secret in the Gateway namespace. The Secret key is the client id, and the value is the API key for that client:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mcp-api-keys
  namespace: mcp-gateway-system
type: Opaque
stringData:
  # opencode-user-1 is the client id; the value is the entry API key issued by the platform.
  opencode-user-1: replace-with-real-api-key
```

Attach `SecurityPolicy` to the MCP-specific `Gateway` and read the API key from the `x-api-key` request header. After authentication succeeds, Envoy Gateway can forward the client id to the backend. `sanitize` is enabled so the entry API key is not forwarded to MCP servers:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: ai-mcp-apikey
  namespace: mcp-gateway-system
spec:
  targetRefs:
    # Attach entry API key authentication to the MCP-specific Gateway.
    - name: ai-mcp-gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  apiKeyAuth:
    # Read the entry API key from the client request header.
    extractFrom:
      - headers:
          - x-api-key
    credentialRefs:
      # Reference the mcp-api-keys Secret above.
      - name: mcp-api-keys
    # After authentication, forward the client id for logging and audit.
    forwardClientIDHeader: x-mcp-client-id
    # Remove x-api-key from the request before forwarding it to backends.
    sanitize: true
```

Notes:

- Attach `SecurityPolicy` to the MCP-specific `Gateway` to avoid protecting unrelated routes on the same Gateway.
- Use `x-api-key` to carry the entry API key.
- `x-mcp-client-id` comes from the Gateway authentication result and can be used for logging, audit, or backend awareness of the caller. Do not treat a same-name header sent by the client as authoritative identity.
- Entry API keys and backend MCP server credentials are two different types of credentials. The entry API key is used to access the unified MCP entry. Backend credentials are used by the Gateway to access a specific MCP backend.

## opencode Client Configuration Example

opencode can add a remote MCP server through `opencode mcp add`; manual JSON editing is not required. The client still connects to one unified MCP address. Tool aggregation and backend dispatching are handled by the shared Gateway and the unified `MCPRoute`. In the examples below, `<mcp-endpoint>` represents the actual entry address, which can be a domain, load balancer address, or NodePort debugging address.

When using an API key, opencode only needs to send a fixed credential in the request header:

```bash
# <mcp-api-key> is the MCP entry credential issued by the platform for the current user or automation account.
# It must match the value of one client id in the mcp-api-keys Secret above.
# The API key is injected through an environment variable and is not written into the opencode config file.
export MCP_API_KEY="<mcp-api-key>"

# Add the unified MCP entry. opencode writes the configuration into its own config file.
# --header uses name=value format; the actual HTTP request header is x-api-key: <MCP_API_KEY>.
opencode mcp add alauda-mcp \
  --url "<mcp-endpoint>/mcp" \
  --header "x-api-key={env:MCP_API_KEY}"
```

Check the MCP server status:

```bash
opencode mcp list
```

## OIDC Integration

API key authentication is used to bring up the main flow first. When OIDC is required, switch entry authentication to `MCPRoute.securityPolicy.oauth`.

When opencode logs in to a remote MCP server through OAuth, the MCP entry needs to return the authentication challenge and protected resource metadata defined by the MCP Authorization specification. This capability is provided by `MCPRoute.securityPolicy.oauth`:

```yaml
apiVersion: aigateway.envoyproxy.io/v1alpha1
kind: MCPRoute
metadata:
  name: unified-mcp
  namespace: mcp-gateway-system
spec:
  parentRefs:
    - name: ai-mcp-gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  path: /mcp
  securityPolicy:
    oauth:
      # Authorization server issuer. MCPRoute uses it to discover authorization server metadata and JWKS.
      issuer: https://idp.example.com/realms/ai
      # Validate that the access token is issued for the MCP entry.
      audiences:
        - ai-mcp
      protectedResourceMetadata:
        # Protected resource identifier. It must match the URL used by opencode to access the MCP entry.
        resource: "<mcp-endpoint>/mcp"
        resourceName: alauda-mcp
  backendRefs:
    # Omitted: keep this consistent with backendRefs in "Configure a Unified MCP Entry".
    - name: k8s-mcp-server
      kind: Backend
      group: gateway.envoyproxy.io
      path: /mcp
```

In OIDC mode, do not attach API key authentication to this MCP entry, so the client does not have to maintain two entry credentials. If additional platform-level authorization is needed, connect a separate authorization service.

In OIDC mode, opencode uses the remote MCP OAuth flow to log in. The MCP entry must provide the authentication challenge and protected resource metadata defined by the MCP OAuth specification, so opencode can discover the authorization server and complete login.

On the opencode side, add the remote MCP entry first, then start OAuth login:

```bash
# Add the unified MCP entry. Do not configure a static Authorization header in OIDC/OAuth mode.
opencode mcp add alauda-mcp \
  --url "<mcp-endpoint>/mcp"

# Start the OAuth login flow. opencode opens the authorization URL or prints it in the terminal.
opencode mcp auth alauda-mcp

# Check the MCP server status after login.
opencode mcp list
```

After login, opencode stores and refreshes OAuth tokens, and sends `Authorization: Bearer <access-token>` when accessing the MCP entry. `MCPRoute.securityPolicy.oauth` validates the token issuer, audience, signature, and required claims. The MCPRoute and MCPServer integration model remains unchanged.

## References

- Envoy AI Gateway MCP documentation (v0.4.0 validation source): https://github.com/envoyproxy/ai-gateway/blob/v0.4.0/site/docs/capabilities/mcp/index.md
- Envoy AI Gateway MCPRoute API (v0.4.0 validation source): https://github.com/envoyproxy/ai-gateway/blob/v0.4.0/api/v1alpha1/mcp_route.go
- Envoy AI Gateway MCP example (v0.4.0 validation source): https://github.com/envoyproxy/ai-gateway/tree/v0.4.0/examples/mcp
- opencode MCP servers configuration documentation: https://opencode.ai/docs/mcp-servers/
- MCP Lifecycle Operator: https://github.com/kubernetes-sigs/mcp-lifecycle-operator
- MCP Lifecycle Operator documentation: https://mcp-lifecycle-operator.sigs.k8s.io/
