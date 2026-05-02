---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Registering an External Host Behind a Cluster Service
## Issue

In-cluster workloads need to reach a backend that lives outside the cluster (a legacy VM, a third-party database, a managed API) by a stable Service DNS name — for example `service-1.my-namespace.svc.cluster.local` — instead of hardcoding the external IP in every consumer. The goal is to route the traffic to that external host rather than to any pod in the cluster.

## Resolution

Create a Service with **no** `selector`, then provide the backend addresses yourself. With no selector, the control plane will not try to populate the backends automatically from pod labels; the cluster routes traffic to whatever addresses are published under the Service's name in the data plane.

There are two equivalent ways to publish those addresses. Prefer EndpointSlice on current clusters; the older Endpoints object still works and is simpler to write by hand.

**Service (selectorless):**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: service-1
  namespace: my-namespace
spec:
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8081
```

**Option A — EndpointSlice (preferred):**

```yaml
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: service-1-external
  namespace: my-namespace
  labels:
    kubernetes.io/service-name: service-1
addressType: IPv4
ports:
  - name: ""
    protocol: TCP
    port: 8081
endpoints:
  - addresses:
      - "192.168.100.200"
    conditions:
      ready: true
```

The `kubernetes.io/service-name` label is what binds the slice to the Service — the `metadata.name` of the slice is free-form.

**Option B — Endpoints (legacy, still supported):**

```yaml
apiVersion: v1
kind: Endpoints
metadata:
  name: service-1
  namespace: my-namespace
subsets:
  - addresses:
      - ip: "192.168.100.200"
    ports:
      - port: 8081
```

With either option, a pod that calls `service-1:80` has its traffic forwarded to `192.168.100.200:8081`. When the external address changes, patch only the EndpointSlice (or Endpoints) object — consumer manifests keep using the Service name.

Notes on the shape of the external address:

- Both forms expect **IP literals**, not DNS names. If the backend is only reachable by hostname, resolve it ahead of time (and refresh the slice when the IP changes) or use a `type: ExternalName` Service instead — but that returns a CNAME and does not give the client a ClusterIP.
- To route to several external replicas, add more entries under `endpoints` (EndpointSlice) or under `subsets[].addresses` (Endpoints).
- NetworkPolicy that restricts egress by podSelector does **not** apply to selectorless Services: the policy needs an `egress` rule that allows the external CIDR, otherwise traffic is dropped before it leaves the node.

## Diagnostic Steps

Confirm the Service has no selector and an EndpointSlice exists with the expected address:

```bash
kubectl -n my-namespace get svc service-1 -o yaml | grep -i selector
kubectl -n my-namespace get endpointslices -l kubernetes.io/service-name=service-1
kubectl -n my-namespace describe endpointslice <slice-name>
```

Test end-to-end from any pod in the namespace:

```bash
kubectl -n my-namespace run -it --rm curl --image=curlimages/curl --restart=Never -- \
  curl -v http://service-1/
```

A connection that hangs or is refused usually means one of: the external host is not actually reachable from a node (check nodeport/firewall/routing), the `targetPort` does not match the port the backend listens on, or an EndpointSlice/Endpoints object with the same name was replaced by the control plane because a selector got added to the Service later.
