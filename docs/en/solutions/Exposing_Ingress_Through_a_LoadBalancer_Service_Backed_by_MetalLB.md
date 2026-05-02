---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Exposing Ingress Through a LoadBalancer Service Backed by MetalLB
## Issue

On bare-metal, vSphere, or similar clusters that do not have a cloud-provider LoadBalancer, operators need to expose the cluster's ingress tier through a virtual IP rather than on NodePorts or on the host network directly. Two concrete needs arise:

- Changing the existing default ingress from a NodePort/HostNetwork style of publishing to a `LoadBalancer` Service, so that ingress traffic enters through a stable VIP that can move between nodes on failure.
- Standing up **additional** ingress tiers (for example, a dedicated apps-domain ingress with its own certificate, separate from the default) that also need VIPs rather than NodePorts, typically for router/ALB sharding by namespace or label.

On ACP the ingress tier is the **ALB Operator** (`networking/operators/alb_operator`); the VIP is provided by **MetalLB** operating in L2 or BGP advertisement mode.

## Resolution

The pattern is the same whether you are replacing the default ingress or adding a sharded tier: declare an IP pool and advertisement for MetalLB, then create (or edit) the ingress definition so its Service type is `LoadBalancer` and a MetalLB address gets assigned.

### 1. Configure the MetalLB address pool and advertisement

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: ip-addrpool-sub16-28
  namespace: metallb-system
  labels:
    subnet: "16-28"
spec:
  addresses:
    - 192.168.122.16/28
  autoAssign: true
  avoidBuggyIPs: false
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: l2-adv-ipaddpool-sub16-28
  namespace: metallb-system
spec:
  ipAddressPoolSelectors:
    - matchExpressions:
        - key: subnet
          operator: In
          values:
            - "16-28"
  nodeSelectors:
    - matchExpressions:
        - key: node-role.kubernetes.io/worker
          operator: Exists
```

Pick `L2Advertisement` when the VIP just needs to ARP-announce from one node; pick `BGPAdvertisement` if the upstream routers speak BGP and can ECMP across multiple nodes for active/active load sharing. L2 gives high availability but not load balancing — failover only.

### 2. Expose an ingress (ALB) through a LoadBalancer Service

Create the ingress definition in the cluster's ingress namespace. The essential knob is that the published endpoint is a LoadBalancer Service (not NodePort or host network), so MetalLB allocates an address from the matching pool. A sharded ingress that serves a separate apps domain with its own TLS material looks like this:

```yaml
apiVersion: <alb-operator-apiversion>  # per ACP ALB Operator docs
kind: ALB
metadata:
  name: dev-apps-ingress
  namespace: <ingress-namespace>
spec:
  domain: dev-apps.example.com
  replicas: 3
  endpointPublishing:
    type: LoadBalancer
  defaultCertificate:
    secretName: custom-cert-default
  namespaceSelector:
    matchLabels:
      devapps: "true"
  accessLog:
    enabled: true
```

The fields that matter conceptually — regardless of the exact CR name — are: publish as `LoadBalancer`, target a specific domain, select which Routes/Ingresses this tier serves (for shard isolation), attach the right certificate. Consult the ALB Operator reference for the current CR schema.

### 3. Switching the default ingress from host-network to LoadBalancer

Back up the current default ingress CR first — a mistake here takes the whole cluster offline:

```bash
kubectl get <alb-cr> default -n <ingress-namespace> -o yaml > default-ic.yaml
cp default-ic.yaml default-ic.new.yaml
# edit default-ic.new.yaml: set endpointPublishing.type to LoadBalancer,
# leave every other field unchanged.
kubectl replace -f default-ic.new.yaml
```

When the controller reconciles, the existing ingress pods are recreated and their fronting Service turns into a `LoadBalancer`; MetalLB then assigns an address from the matching pool.

### 4. Handling pools with `autoAssign: false`

If the pool is configured with `autoAssign: false`, MetalLB does not volunteer an address. Either:

- Annotate the LoadBalancer Service to pin it to the pool:

  ```bash
  kubectl annotate svc <ingress-service> -n <ingress-namespace> \
    metallb.universe.tf/address-pool=ip-addrpool-sub16-28
  ```

- Or request a specific IP with `metallb.universe.tf/loadBalancerIPs` when a particular address must be bound.

### 5. Caveats that bite in production

- **L2 advertisement is failover, not load balancing.** A single node wins the ARP election and takes all traffic for the VIP; other nodes take over only on failure. If real cross-node load distribution is needed, use BGP advertisement with an infrastructure capable of ECMP, or front MetalLB with a hardware/external load balancer.
- **`externalTrafficPolicy: Local` vs `Cluster`** changes both source-IP visibility and the hash behaviour; set it deliberately per tier rather than accepting the default without thought.
- **Do not swap a production default ingress to LoadBalancer blindly.** Stage the change on a non-critical tier first; once the VIP + ALB behaviour is confirmed, repeat on the default tier with a tested rollback path.

## Diagnostic Steps

Confirm the ingress Service acquired an external address:

```bash
kubectl get svc -n <ingress-namespace>
```

Expected: the Service is of `TYPE` `LoadBalancer` and the `EXTERNAL-IP` column holds an address from the IP pool, not `<pending>`. If it stays `<pending>`:

```bash
kubectl describe svc <ingress-service> -n <ingress-namespace>
kubectl -n metallb-system logs deploy/controller
```

MetalLB surfaces allocation failures as events on the Service (`AllocationFailed`, "no available IPs in pool") and in the controller log. Typical causes are a mismatched pool selector, an exhausted pool, or `autoAssign: false` without the required annotation.

Check which node is currently announcing the VIP (L2):

```bash
kubectl -n metallb-system logs ds/speaker | grep announcing
```

Verify traffic actually reaches the ingress pods:

```bash
curl -kv --resolve dev-apps.example.com:443:<external-ip> \
     https://dev-apps.example.com/
```

A TCP connect that times out usually means the ARP announcement has not reached the test host (L2 scope issue or `nodeSelectors` on the `L2Advertisement` that excludes the announcer node). A TLS or `404` response means the VIP is reachable and the remaining work is in the ingress / certificate / route configuration, not in MetalLB.
