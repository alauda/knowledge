---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.3"
---

# Envoy Gateway access log shows a Kube-OVN join address instead of the real client IP on ACP

## Issue

The caller cannot be found in the Envoy Gateway access log, or the forwarded address is wrong:

- Which field in the gateway log is the client address, and can the log format be changed?
- The client field never changes across browser requests: it stays an address from the Kube-OVN `join` subnet, not the browser host's address. `x-forwarded-for` and `downstream_remote_address` hold that same address. The browser name resolves straight to the Envoy Gateway LoadBalancer IP from a MetalLB pool, with no proxy in front, and the cluster CNI is Kube-OVN.
- After `externalTrafficPolicy` was changed to `Cluster`, `X-Forwarded-For` carries only OVN addresses, and the site must keep `Cluster` and still pass the external client address.
- How is X-Forwarded-For (XFF) handling turned on for the gateway?

`downstream_remote_address` is the access-log field for the client IP: the address Envoy accepted the connection from. There is no console control for the gateway log format; a defined text format can be set with `EnvoyProxy` telemetry (see "Envoy Gateway limits and questions: 64 listeners, access logs, operator install, HMAC-SM3 and migration on ACP", Cause 2).

## Root Cause

### Cause 1: Service forwarding replaces the client address before Envoy sees the connection

The client address is replaced on the Service path before the packet reaches Envoy, which matches source NAT applied by the Kubernetes Service forwarding on Kube-OVN; the exact mechanism was not confirmed. A `ClientTrafficPolicy` that targets the Gateway with `clientIPDetection.xForwardedFor.trustedCIDRs: [0.0.0.0/0, ::/0]` does not change it, because MetalLB inserts neither `X-Forwarded-For` nor PROXY protocol, and an XFF policy cannot recover an address that was never in the connection or in a header. Setting `externalTrafficPolicy` to `Local` on the gateway LoadBalancer Service made the real client address appear in the log.

### Cause 2: Cluster must stay, so the original address has to come from a front proxy

With `externalTrafficPolicy: Cluster`, Service forwarding may source-NAT the connection, and Envoy cannot read the original client from it. The options are:

- use `Local` on the Envoy Gateway Service and land VIP traffic only on nodes that run a local Envoy Pod; or
- keep `Cluster` and have a front load balancer or proxy pass `X-Forwarded-For` or PROXY protocol.

### Cause 3: XFF trust is a ClientTrafficPolicy and only helps when a proxy added the header

XFF handling is a `ClientTrafficPolicy` (`gateway.envoyproxy.io/v1alpha1`) that targets the Gateway and sets `spec.clientIPDetection.xForwardedFor`, with exactly one of two fields (`kubectl explain`: "Only one of NumTrustedHops and TrustedCIDRs must be set."):

- `numTrustedHops`: the client IP is taken from the Nth address from the right end of `X-Forwarded-For`; set it to the number of trusted proxies in front of the gateway (`0` for none, `1` for one load balancer, `2` for two layers).
- `trustedCIDRs`: when the connection's remote address is in a trusted CIDR, XFF entries are evaluated right to left and the first untrusted address is the client; if all are trusted, the leftmost entry is used.

Trusting every CIDR does not fix Cause 1, because no proxy appended the real client there.

## Resolution

Read the live Service policy and the logged address before changing either:

```bash
kubectl get svc -A -l gateway.envoyproxy.io/owning-gateway-name=<gateway-name> \
  -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,POLICY:.spec.externalTrafficPolicy'
kubectl logs -n <data-plane-namespace> <envoy-pod> -c envoy --tail=20
kubectl get subnet join -o jsonpath='{.spec.cidrBlock}{"\n"}'
```

### Cause 1: Service forwarding replaces the client address before Envoy sees the connection

Set `externalTrafficPolicy: Local` on the `EnvoyProxy` the Gateway references (`spec.infrastructure.parametersRef`). A direct edit of the generated Service is reconciled away.

> **Warning:** With `Local`, VIP packets that arrive on a node without a ready Envoy Pod are dropped, so clients can lose the VIP unless Envoy Pods run on the nodes that receive it. Only when `downstream_remote_address` is a join-subnet address and an XFF policy did not change it. Save the object; replacing the value back with `Cluster` is the rollback.

```bash
kubectl get envoyproxy <envoyproxy-name> -n <gateway-namespace> -o yaml > /tmp/envoyproxy-before.yaml
kubectl patch envoyproxy <envoyproxy-name> -n <gateway-namespace> --type='json' -p='[
  {"op": "replace", "path": "/spec/provider/kubernetes/envoyService/externalTrafficPolicy", "value": "Local"}
]'
```

If the path does not exist yet, create it with a merge patch:

```bash
kubectl patch envoyproxy <envoyproxy-name> -n <gateway-namespace> --type=merge -p '{"spec":{"provider":{"type":"Kubernetes","kubernetes":{"envoyService":{"externalTrafficPolicy":"Local"}}}}}'
```

Scope the MetalLB `L2Advertisement` to the gateway nodes so the VIP is not announced from a node without an Envoy Pod, then send one request and confirm `downstream_remote_address` is the client:

```bash
kubectl get pods -A -o wide -l gateway.envoyproxy.io/owning-gateway-name=<gateway-name>
kubectl get l2advertisements.metallb.io -A -o yaml | grep -n -A6 nodeSelectors
```

### Cause 2: Cluster must stay, so the original address has to come from a front proxy

Configure the front load balancer or proxy to append `X-Forwarded-For` or to use PROXY protocol, then apply Cause 3 so Envoy trusts that hop. If no front proxy exists, `Local` with VIP placement on Envoy nodes (Cause 1) is the option that preserves the address.

### Cause 3: XFF trust is a ClientTrafficPolicy and only helps when a proxy added the header

Set either `numTrustedHops` or `trustedCIDRs`, never both, in one `ClientTrafficPolicy` for the Gateway. For one load balancer in front:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: enable-xff
  namespace: <gateway-namespace>
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: <gateway-name>
  clientIPDetection:
    xForwardedFor:
      numTrustedHops: 1
```

For a first test, `trustedCIDRs` with `0.0.0.0/0` and `::/0` trusts every source; for production, list only the proxy ranges (for example private ranges used by internal proxies).

> **Warning:** Trusting `0.0.0.0/0` and `::/0` lets any client set `X-Forwarded-For`, and allowlists or audit logs that use the detected client IP will follow it. Roll back by deleting the policy or removing `clientIPDetection`.

```bash
kubectl explain clienttrafficpolicies.gateway.envoyproxy.io.spec.clientIPDetection.xForwardedFor
kubectl apply -f enable-xff.yaml
kubectl get clienttrafficpolicy -A
```

## Diagnostic Steps

1. Read one access line and the Service policy together:

   ```bash
   kubectl logs -n <data-plane-namespace> <envoy-pod> -c envoy --tail=20
   kubectl get svc -A -l gateway.envoyproxy.io/owning-gateway-name=<gateway-name> \
     -o custom-columns='NAME:.metadata.name,POLICY:.spec.externalTrafficPolicy,IP:.status.loadBalancer.ingress[*].ip'
   ```

2. Check for an existing XFF policy:

   ```bash
   kubectl get clienttrafficpolicy -n <gateway-namespace> -o yaml
   ```

- `downstream_remote_address` inside the `join` subnet CIDR and the policy not `Local`, or unchanged with an XFF policy present: Cause 1.
- The policy is `Cluster` and must stay: Cause 2.
- A front proxy appends `X-Forwarded-For` and no `ClientTrafficPolicy` trusts that hop: Cause 3.

3. After a `Local` change, `curl` the VIP from a node that does not run Envoy. If it fails while an Envoy node succeeds, the address is now correct and the failure is the reachability side effect of `Local`; restrict the VIP announcement to Envoy nodes.
