---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500350
---

# Defining Istio Gateway and VirtualService ingress routing resources on ACP

## Issue

On Alauda Container Platform (Kubernetes server v1.34.5) the `networking.istio.io` custom resource definitions are present, and platform operators preparing an ingress-routing configuration need the canonical resource shapes for an Istio `Gateway`, an Istio `VirtualService`, and the declarative namespace marker label associated with proxy injection. That label is a plain namespace marker: sidecar injection occurs only where a mesh control plane and its injector are running to act on it, so applying the label by itself neither creates nor injects anything. This article describes the resource manifests that get authored and applied — the field structure of each `networking.istio.io` object and the generic Kubernetes namespace label — so the manifests can be prepared correctly before they are submitted to the cluster.

## Resolution

A workload namespace carries the declarative marker label `istio-injection=enabled`. This label is a free-form key under the namespace's `metadata.labels` map, which is the generic Kubernetes `map[string]string` field that accepts arbitrary key/value pairs; applying the label is therefore a standard namespace-labeling operation. The label is only a declarative marker — it takes effect, producing sidecar injection, solely when a mesh control plane and its running injector are present to consume it; applying the label on a cluster without an instantiated mesh injector does not by itself inject or create anything:

```bash
kubectl label namespace <workload-namespace> istio-injection=enabled
```

An Istio `Gateway` resource describes which hosts and ports the ingress gateway is configured to accept traffic on. The CRD is served under the group/version `networking.istio.io/v1` (with `v1alpha3` and `v1beta1` also served). Its `spec` carries a `selector` field — a pod label selector identifying the ingress gateway workload the configuration binds to — and a `servers` list, where each entry pairs a port definition with the set of hosts served on that port:

```yaml
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: app-gateway
  namespace: <workload-namespace>
spec:
  selector:
    istio: ingressgateway
  servers:
    - port:
        number: 80
        name: http
        protocol: HTTP
      hosts:
        - "app.example.com"
```

An Istio `VirtualService` resource describes how inbound traffic arriving through a named gateway is routed to backing application services. The CRD is likewise served under `networking.istio.io/v1` (with `v1alpha3` and `v1beta1` also served). Its `spec` carries a `gateways` list naming the `Gateway` resources the routes apply to, a `hosts` list of destination hosts, and an `http` list of ordered HTTP route rules that direct matching requests to backing services:

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: app-routes
  namespace: <workload-namespace>
spec:
  hosts:
    - "app.example.com"
  gateways:
    - app-gateway
  http:
    - route:
        - destination:
            host: app-service
            port:
              number: 8080
```

The `Gateway.spec.selector` value and the `VirtualService.spec.gateways` reference are the two links that tie the routing configuration together: the gateway's selector points at the ingress gateway pods, and the virtual service names the gateway whose inbound traffic its HTTP rules govern.

## Diagnostic Steps

The ingress gateway pod is identified by the label selector `istio=ingressgateway`, the generic upstream label-selector form for the gateway workload. Listing pods with this selector confirms whether a gateway workload is present in a given namespace:

```bash
kubectl get pods -n <workload-namespace> -l istio=ingressgateway
```

When no gateway workload is deployed in the queried namespace, this command returns `No resources found`; that result is the expected output of the selector when the ingress gateway pods are absent, and it confirms the selector itself is well-formed against the cluster.
