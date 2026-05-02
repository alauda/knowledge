---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The platform's Hosted Control Plane (HCP) capability runs each managed cluster's control plane as workloads on a hub cluster. By default, every hosted cluster's API server, OAuth server, Konnectivity, and Ignition endpoints are published through the hub's shared ingress controller and reach the network on the hub's shared VIP — multiplexed via SNI.

This is fine for many deployments but does not satisfy environments that require:

- A unique IP per hosted control plane for firewall / Zscaler / segmentation policies that key off destination IP rather than SNI.
- Per-cluster network-level isolation of the OAuth endpoint from other tenants of the same hub.
- A supported, operator-managed configuration (manually injecting parallel `LoadBalancer` Services into the HCP namespace causes the HCP operator to drift on subsequent reconciles).

## Resolution

Configure the `HostedCluster` CR at creation time to use the `Route` publishing strategy with explicit hostnames for all four control-plane services. This triggers the HCP operator to provision a **dedicated** `IngressController` (router) per hosted cluster, and MetalLB fronts that router with a unique VIP. The result is a per-cluster network slice that survives operator reconciles.

> The `spec.services` block on a `HostedCluster` is **immutable**. The settings below must be applied at initial creation; existing hosted clusters cannot be retrofitted in-place — they need to be recreated.

### 1. Reserve a unique VIP via MetalLB

MetalLB serves the per-cluster router. On the hub, ensure an `IPAddressPool` and `L2Advertisement` make a unique address available for each HCP that needs isolation:

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: hcp-isolation
  namespace: metallb-system
spec:
  addresses:
    - 10.20.30.10-10.20.30.50          # one address per isolated HCP
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: hcp-isolation-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - hcp-isolation
```

### 2. Create the `HostedCluster` with all four services on `Route`

Set every key service to `type: Route` with an explicit hostname. On bare metal, leaving any of them — particularly `APIServer` — on `NodePort` or `LoadBalancer` skips the dedicated-router provisioning and routes traffic back to the shared hub ingress.

```yaml
apiVersion: hypershift.alauda.io/v1beta1
kind: HostedCluster
metadata:
  name: my-hcp
  namespace: clusters
spec:
  services:
    - service: APIServer
      servicePublishingStrategy:
        type: Route
        route:
          hostname: api-my-hcp.apps.hub.example.com
    - service: OAuthServer
      servicePublishingStrategy:
        type: Route
        route:
          hostname: oauth-my-hcp.apps.hub.example.com
    - service: Konnectivity
      servicePublishingStrategy:
        type: Route
        route:
          hostname: konnectivity-my-hcp.apps.hub.example.com
    - service: Ignition
      servicePublishingStrategy:
        type: Route
        route:
          hostname: ignition-my-hcp.apps.hub.example.com
```

The HCP operator reconciles the CR, sees all four services in `Route` mode, and provisions a dedicated router Deployment in the `clusters-my-hcp` namespace, fronted by a `LoadBalancer` Service whose VIP comes from the MetalLB pool.

### 3. Allow ingress from the LoadBalancer to the router pod

The HCP operator writes a default-deny `NetworkPolicy` into the HCP namespace. Add an explicit allow-from for the LoadBalancer→router path:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-from-lb-to-router
  namespace: clusters-my-hcp
spec:
  podSelector:
    matchLabels:
      app: private-router
  ingress:
    - ports:
        - port: 8443
          protocol: TCP
  policyTypes:
    - Ingress
```

In recent control-plane versions the dedicated router Deployment is named `router` (not `private-router`), but the `app: private-router` label is preserved on the pods specifically so the policy above keeps matching across versions — do not adjust the selector.

### 4. Trust the custom CA on worker nodes (Route + corporate PKI)

A known interaction with `Route`-based publishing combined with a custom (corporate) CA breaks worker-node bootstrap with `x509: certificate signed by unknown authority`. The cause is that `bootstrap-kubeconfig` does not inherit the custom CA bundle, so the kubelet on the spoke cannot validate the API server's route certificate.

A permanent fix is in the upstream tracking issue. Until that lands, manually patch the `root-ca` Secret in the HCP namespace to include the corporate CA — the HCP operator propagates the result through to `bootstrap-kubeconfig` and to all spoke-side components:

```bash
HCP_NS=clusters-my-hcp
# 1) Pull the existing root-ca cert.
kubectl -n "$HCP_NS" get secret root-ca \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > root-ca.crt

# 2) Concatenate the corporate CA chain in front of (or after) the existing cert.
cat corporate-ca-chain.pem root-ca.crt > combined-ca.crt

# 3) Patch the Secret in place.
kubectl -n "$HCP_NS" create secret generic root-ca \
  --from-file=ca.crt=combined-ca.crt --dry-run=client -o yaml \
  | kubectl -n "$HCP_NS" replace -f -
```

Restart the components that read `root-ca` so they reload the new bundle; the HCP operator handles the propagation thereafter.

## Diagnostic Steps

1. Confirm the HCP operator provisioned a dedicated router for the hosted cluster:

   ```bash
   HCP_NS=clusters-my-hcp
   kubectl -n "$HCP_NS" get deployment router
   kubectl -n "$HCP_NS" get pod -l app=private-router
   ```

2. Confirm MetalLB has assigned a unique VIP to the dedicated router Service:

   ```bash
   kubectl -n "$HCP_NS" get svc router -o jsonpath='{.status.loadBalancer.ingress[*].ip}'
   ```

   This value should differ from the hub's shared ingress VIP and should be one of the addresses in the `hcp-isolation` `IPAddressPool`.

3. Confirm traffic isolation by resolving the OAuth endpoint and comparing to the hub's shared ingress VIP. If they match, the cluster is still on the shared ingress path:

   ```bash
   dig +short oauth-my-hcp.apps.hub.example.com
   dig +short *.apps.hub.example.com    # the hub's shared ingress VIP
   ```

   Different IPs is the success signal; identical IPs means one of the four services was not set to `Route` (or the `Route` hostname was not unique enough to trigger the dedicated router path).

4. If worker nodes fail bootstrap with `x509: certificate signed by unknown authority`, confirm the `root-ca` Secret carries the corporate chain:

   ```bash
   kubectl -n "$HCP_NS" get secret root-ca -o jsonpath='{.data.ca\.crt}' \
     | base64 -d | openssl crl2pkcs7 -nocrl -certfile /dev/stdin \
     | openssl pkcs7 -print_certs -noout | head
   ```
