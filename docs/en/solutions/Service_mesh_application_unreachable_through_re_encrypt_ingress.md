---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Service mesh application unreachable through re-encrypt ingress
## Issue

A workload exposed through the service mesh (Istio) becomes unreachable when the platform ingress in front of the mesh is configured to perform a TLS re-encrypt — the client TLS session is terminated at the platform ingress and a brand-new TLS session is opened toward the Istio ingress gateway. Envoy on the gateway logs:

```text
response_code_details: filter_chain_not_found
requested_server_name: null
```

The same workload works correctly when the platform ingress uses passthrough or edge termination, or when the test client connects to the gateway directly.

## Root Cause

The Istio `Gateway` is bound to a specific hostname:

```yaml
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: example-gateway
  namespace: example
spec:
  selector:
    istio: ingressgateway
  servers:
    - port:
        number: 443
        name: https
        protocol: HTTPS
      hosts:
        - test.example.com
      tls:
        mode: SIMPLE
        credentialName: tls-secret
```

When the gateway is bound to a concrete host, Envoy builds a TLS filter chain that matches only on that exact SNI. Any TLS handshake that arrives without the expected `server_name` extension is rejected with `filter_chain_not_found`, and Envoy records `requested_server_name: null`.

In a re-encrypt topology there are two independent TLS segments:

1. **Client → platform ingress.** The platform ingress terminates the client's TLS session and uses the SNI to pick the right route and certificate. This part works as expected.
2. **Platform ingress → mesh ingress gateway.** The platform ingress now acts as the TLS *client* and opens a fresh TLS handshake to the mesh gateway. By default it does **not** propagate the original client's SNI on this second handshake — many ingress implementations either omit `server_name` entirely or use the backend service's internal DNS name.

Envoy on the mesh gateway therefore sees a handshake whose SNI does not match `test.example.com`, no filter chain is selected, and the request is rejected before any HTTP routing is attempted.

## Resolution

ACP exposes mesh-fronting traffic through ALB (`networking/operators/alb_operator`); the same logic applies to any L7 load balancer placed in front of the Istio ingress gateway. Two interchangeable fixes work; pick whichever fits your security model.

### Option 1 (preferred): drop the SNI requirement on the mesh Gateway

Bind the `Gateway` server entry to `*` so Envoy accepts any SNI on that port. Hostname-based routing still happens at the `VirtualService` level, so this does not weaken request-level isolation.

```yaml
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: example-gateway
  namespace: example
spec:
  selector:
    istio: ingressgateway
  servers:
    - port:
        number: 443
        name: https
        protocol: HTTPS
      hosts:
        - "*"
      tls:
        mode: SIMPLE
        credentialName: tls-secret
```

Apply it and verify Envoy now serves the request:

```bash
kubectl -n example apply -f gateway.yaml
kubectl -n istio-system logs deploy/istio-ingressgateway --tail=50 | \
  grep -E 'filter_chain_not_found|requested_server_name'
```

### Option 2: change the front-door termination mode

If the wildcard host is not acceptable (for example because multiple tenants share the same gateway and you want strict per-host filter chains), switch the platform ingress in front of the mesh from re-encrypt to one of:

- **Passthrough** — the platform ingress forwards the original ClientHello unchanged, so the mesh gateway receives the correct SNI. The platform ingress no longer terminates TLS.
- **Edge** — the platform ingress terminates TLS and forwards plain HTTP to the gateway over an internal trusted hop. The mesh gateway's `port.protocol` should then be `HTTP` rather than `HTTPS`.

For ALB, set the corresponding `Rule` / `Frontend` mode (passthrough or edge) instead of re-encrypt.

### Option 3: have the front-door propagate SNI explicitly

Some L7 load balancers can be configured to set the upstream SNI to a literal value (in this case `test.example.com`) when opening the second-leg TLS handshake. This keeps re-encrypt and the strict per-host filter chain, at the cost of one extra knob. Consult the ALB / front-door documentation for the SNI override field.

## Diagnostic Steps

Walk the two TLS segments independently to localize the mismatch.

```bash
# 1. Confirm the symptom on the mesh gateway side.
kubectl -n istio-system logs deploy/istio-ingressgateway --tail=200 | \
  grep -E 'filter_chain_not_found|requested_server_name'

# 2. Inspect what the front-door actually saw and forwarded.
#    On ALB:
kubectl -n cpaas-system logs deploy/<alb-name> --tail=200 | \
  grep -E 'host=|sni='

# 3. Reproduce the second-leg handshake from inside the cluster
#    to isolate the SNI being sent. From any debug pod:
openssl s_client -connect istio-ingressgateway.istio-system:443 \
  -servername test.example.com -showcerts </dev/null 2>&1 | head -20
# Then repeat without -servername to mimic a missing SNI:
openssl s_client -connect istio-ingressgateway.istio-system:443 \
  </dev/null 2>&1 | head -20

# 4. Dump the live Envoy listener config to see which filter chains exist
#    and what SNI each one matches.
kubectl -n istio-system exec deploy/istio-ingressgateway -- \
  pilot-agent request GET listeners?format=json | \
  jq '.dynamic_listeners[] | .active_state.listener.filter_chains[]?.filter_chain_match'
```

If step 3 succeeds with `-servername` and fails without it, you have confirmed the front-door is dropping or rewriting the SNI — apply Option 1 or Option 3. If step 4 shows no filter chain matching `test.example.com`, the `Gateway` host binding itself is wrong and the application of the resolution is the right next step.
