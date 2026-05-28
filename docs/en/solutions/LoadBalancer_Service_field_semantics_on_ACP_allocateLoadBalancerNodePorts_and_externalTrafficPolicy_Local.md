---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500278
---

# LoadBalancer Service field semantics on ACP — allocateLoadBalancerNodePorts and externalTrafficPolicy Local

## Overview

On Alauda Container Platform, a `type=LoadBalancer` Service is served by the cluster's on-premises load balancer, and its routing behavior is governed by two stock `core/v1` Service spec fields that behave the same on any conformant Kubernetes cluster (kube `v1.34.5`). This reference describes the default and effect of `spec.allocateLoadBalancerNodePorts`, the meaning of `spec.externalTrafficPolicy: Local`, and how to inspect both with `kubectl`.

## Resolution

The `spec.allocateLoadBalancerNodePorts` field on a Service is a boolean whose default is `true`, so a `type=LoadBalancer` Service allocates a NodePort for each Service port unless the field is explicitly overridden.

Setting `spec.allocateLoadBalancerNodePorts: false` makes the Service skip NodePort allocation; it may be set to `false` when the load balancer serving the Service does not rely on NodePorts to reach backend pods. A manifest pinning the field looks like the following:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: example-lb
spec:
  type: LoadBalancer
  allocateLoadBalancerNodePorts: false
  externalTrafficPolicy: Local
  selector:
    app: example
  ports:
    - port: 80
      targetPort: 8080
```

The `spec.externalTrafficPolicy` field accepts the enum values `Cluster` and `Local`, with `Cluster` being the default. The value `Local` preserves the client source IP of external traffic by routing only to endpoints on the same node that received the traffic, and drops traffic on nodes that have no local endpoints.

## Diagnostic Steps

The configuration of a Service, including `spec.externalTrafficPolicy` and `spec.allocateLoadBalancerNodePorts`, can be inspected with `kubectl get svc -o yaml`; when populated (on a `type=LoadBalancer` Service that has been assigned an address), `status.loadBalancer.ingress` shows that address as well:

```bash
kubectl get svc <name> -n <namespace> -o yaml
```

To confirm that endpoints are assigned and that the backing pods run on the nodes required by `externalTrafficPolicy: Local`, list the Service EndpointSlices and the backing pods with their node placement. On kube `v1.34.5` the v1 `Endpoints` API is deprecated (v1.33+ directs callers to `discovery.k8s.io/v1` EndpointSlice), so prefer `kubectl get endpointslices`:

```bash
kubectl get endpointslices -n <namespace> -l kubernetes.io/service-name=<name>
kubectl get pods -n <namespace> -o wide -l <selector>
```

A Service inventory across the cluster can be taken with `kubectl get svc -A`, which lists every Service and its type so that `type=LoadBalancer` Services can be located before inspecting their per-Service fields.
