---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

`Service.spec.allocateLoadBalancerNodePorts` is the Kubernetes upstream switch that, when set to `false`, asks the API server *not* to reserve a NodePort for a `type: LoadBalancer` service. Combined with `externalTrafficPolicy: Local`, it is an attractive configuration on clouds whose load balancers can deliver traffic straight to pod-backing hosts without needing a NodePort shim — Azure with Floating IP, some GCP and AKS topologies behave this way. It removes the `30000–32767` port consumption, simplifies firewall rules, and avoids the double hop through kube-proxy's NodePort chain.

The question this article addresses: is this combination safe to adopt on a cluster today, and what are the invariants to verify before relying on it?

## Resolution

### What the combination actually does

With both fields set:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  type: LoadBalancer
  selector:
    app: my-app
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8080
  externalTrafficPolicy: Local
  allocateLoadBalancerNodePorts: false
```

the following happens:

1. The API server does **not** allocate a NodePort. The `Service` object has no `.spec.ports[].nodePort` field populated.
2. kube-proxy does **not** program NodePort rules on the host. There is no iptables / nftables / IPVS entry listening on a host port for this service.
3. The cloud controller manager (CCM) programs the external load balancer to forward directly to the **pod endpoints** (IP:targetPort) on the nodes where they run, using the LB's own native mechanism (e.g. Azure Floating IP, GCP passthrough LB, or an LB that speaks Direct Server Return).
4. Because `externalTrafficPolicy: Local` is in force, the LB also expects a health-probe endpoint (usually the kube-proxy healthz on `10256`) to steer traffic only to nodes that host a ready pod.

The upshot is that the hop normally done by kube-proxy (`LB → nodePort → cluster-IP → pod`) is short-circuited to `LB → pod` on clouds whose load balancers support it.

### Which cloud-provider integrations actually support this

Support is per-CCM, not per-cluster. As of early 2026, the combination has been observed to work on:

- Azure with standard-tier load balancers and Floating IP enabled.
- GCP passthrough network load balancers.
- AKS, per `Azure/AKS#3453`, subject to AKS's CCM version.

It is **not** safe to assume support on:

- On-prem / bare-metal clusters that use MetalLB, unless the specific MetalLB version and mode has been tested without NodePorts (MetalLB in Layer-2 mode traditionally relies on the NodePort path).
- IaaS LBs accessed through an out-of-tree provider that has not implemented the in-tree contract for node-port-less services.
- Bring-your-own LB integrations that rely on the LB-to-node path going through a NodePort.

### Verification checklist before adopting

Before flipping the switch on a production service, confirm each of the following on a canary service in the same cluster:

1. **API server honours the request:** after applying the manifest, `kubectl get svc my-service -o yaml` must show `allocateLoadBalancerNodePorts: false` and an empty `nodePort:` in each port entry. If kube-apiserver is still filling in a NodePort, the feature is disabled or the CCM has not reconciled yet.

2. **Endpoints are pod-local on nodes that carry the LB traffic:** because `externalTrafficPolicy: Local` is in use, traffic must reach a node that has a ready endpoint or be dropped. Cross-check:

   ```bash
   kubectl get endpointslice -l kubernetes.io/service-name=my-service -o wide
   kubectl get pod -l app=my-app -o wide
   ```

   Every node appearing as an endpoint host must be a node that the cloud LB can deliver to. On Azure Floating IP specifically, the backing nodes must be in the LB's backend pool.

3. **External connectivity works without a NodePort:**

   ```bash
   LB_IP=$(kubectl get svc my-service -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
   curl -v "http://${LB_IP}:80/"
   ```

   If this times out or resets, the LB is still configured to forward to a NodePort that no longer exists — the CCM has not caught up, or the integration does not support node-port-less mode at all.

4. **kube-proxy health check is still reachable:** `externalTrafficPolicy: Local` relies on the LB probing `:10256/healthz` to decide which nodes to include. If this port is blocked by a network policy or firewall, the LB will mark all nodes unhealthy and traffic will be black-holed.

### When to leave NodePorts enabled

Leave `allocateLoadBalancerNodePorts` at its default (or explicitly `true`) when:

- The cluster runs behind an LB integration not on the support list above.
- On-cluster probes or observability flows depend on hitting the service via a NodePort (some multi-cluster tooling and legacy health-checkers do).
- Node IP addresses are unstable enough (frequent scaling / replace cycles) that the LB's backend-pool churn becomes a bigger operational cost than the saved NodePorts.

## Diagnostic Steps

If traffic does not flow after applying the manifest:

```bash
# Does the API server carry the request through?
kubectl get svc my-service -o yaml \
  | yq '{allocateLBNP: .spec.allocateLoadBalancerNodePorts,
         ports: .spec.ports, status: .status}'
```

`allocateLBNP: false`, `nodePort: null` on every port entry, and a populated `status.loadBalancer.ingress[]` are the three fields that collectively confirm the API server, CCM, and LB agree.

```bash
# What did the CCM actually program on the LB side?
# (provider-specific — Azure example)
az network lb show -g <rg> -n <lb-name> -o json \
  | jq '.loadBalancingRules, .probes'
```

The LB rule should forward directly to the backend-pool IPs on `targetPort` (not on a NodePort). If the rule still references `3xxxx`, the CCM has not reconciled — roll its pod or wait one sync interval.

```bash
# From inside the cluster, confirm no NodePort is in fact listening.
# Pick any node with a kube-proxy pod.
NODE=<node>
kubectl debug node/"$NODE" -it --image=nicolaka/netshoot -- \
  ss -tlnp | grep -E '(:3[0-9]{4})' || echo "no NodePort bound — expected"
```

If a NodePort process is still bound on the node, kube-proxy has not been reconfigured — check kube-proxy's logs for reconciliation errors, and confirm the kube-proxy version supports `allocateLoadBalancerNodePorts=false` (v1.22+).
