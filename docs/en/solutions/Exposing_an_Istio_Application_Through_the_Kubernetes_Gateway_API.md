---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A mesh user wants to expose an application over the mesh ingress path, but prefers the Kubernetes-native **Gateway API** (`gateway.networking.k8s.io/v1`) rather than the older Istio-flavour `networking.istio.io/v1` `Gateway` + `VirtualService` pair. This is the recommended direction for new workloads — Gateway API is portable across implementations and has first-class role separation between `Gateway` (cluster-infrastructure-owned) and `HTTPRoute` (application-owned).

This note covers the end-to-end flow on a v2-generation Istio deployment: confirming the Gateway API CRDs are in place, labeling an application namespace for sidecar injection, deploying a sample workload, and routing traffic to it via a `Gateway`/`HTTPRoute` pair.

## Resolution

### ACP-preferred path: ACP Service Mesh with Gateway API

1. **Verify the Gateway API CRDs are installed.** ACP Service Mesh v2 expects them to be present so `istiod` can reconcile Gateway API resources into mesh configuration:

   ```bash
   kubectl get crd gateways.gateway.networking.k8s.io
   kubectl get crd httproutes.gateway.networking.k8s.io
   ```

   If they are missing, install the standard-channel CRD bundle (pin to a release matching the Istio version running in the cluster):

   ```bash
   kubectl get crd gateways.gateway.networking.k8s.io >/dev/null 2>&1 \
     || kubectl kustomize "github.com/kubernetes-sigs/gateway-api/config/crd?ref=v1.0.0" \
        | kubectl apply -f -
   ```

2. **Create the application namespace.** On ACP, use a standard Namespace; there is no custom project-creation command needed for mesh onboarding:

   ```bash
   kubectl create namespace bookinfo
   ```

3. **Enable sidecar injection for the namespace.** ACP Service Mesh uses the same label pair Istio upstream does — `istio-discovery=enabled` makes the control plane ship configuration to the workloads, and `istio-injection=enabled` asks the mutating webhook to inject the sidecar container:

   ```bash
   kubectl label namespace bookinfo \
     istio-discovery=enabled \
     istio-injection=enabled
   ```

4. **Deploy the sample workload.** The upstream Bookinfo manifest works unmodified:

   ```bash
   kubectl apply -n bookinfo \
     -f https://raw.githubusercontent.com/istio/istio/release-1.24/samples/bookinfo/platform/kube/bookinfo.yaml
   ```

   Wait for each pod to report `2/2` ready — the second container is the injected sidecar:

   ```bash
   kubectl get pods -n bookinfo
   ```

5. **Deploy the Gateway API resources.** The sample bundle already includes a `Gateway` that asks for an Istio-class listener and an `HTTPRoute` wiring `/` and `/productpage` to the `productpage` Service:

   ```bash
   kubectl apply -n bookinfo \
     -f https://raw.githubusercontent.com/istio/istio/release-1.24/samples/bookinfo/gateway-api/bookinfo-gateway.yaml
   ```

   Because the `Gateway` requests `gatewayClassName: istio`, the mesh control plane provisions a gateway Deployment + `LoadBalancer` Service named `bookinfo-gateway-istio` in the application namespace.

6. **Confirm the gateway is programmed and has an address.** On ACP, the `LoadBalancer` IP is supplied by the ALB Operator (with an inline `LoadBalancer` IP address) or by a bare-metal LB controller such as MetalLB, depending on the cluster's networking model:

   ```bash
   kubectl get svc     -n bookinfo bookinfo-gateway-istio
   kubectl get gateway -n bookinfo bookinfo-gateway
   ```

   Expected shape:

   ```text
   NAME                     TYPE           CLUSTER-IP      EXTERNAL-IP    PORT(S)
   bookinfo-gateway-istio   LoadBalancer   172.30.134.19   192.168.1.20   15021:31610/TCP,80:32264/TCP

   NAME               CLASS   ADDRESS        PROGRAMMED   AGE
   bookinfo-gateway   istio   192.168.1.20   True         70s
   ```

7. **Hit the application** over the gateway's external IP:

   ```bash
   curl -I http://192.168.1.20/productpage
   ```

### OSS fallback: bare Istio with Gateway API

The same flow works on a plain upstream Istio install. Two small differences:

- The CRDs must be applied before `istiod` starts, otherwise Istio will skip registering Gateway API watchers. If CRDs were added later, bounce `istiod` so it re-registers informers:

  ```bash
  kubectl -n istio-system rollout restart deployment/istiod
  ```

- On a cluster without any LoadBalancer provider, the provisioned gateway Service sits in `Pending`. Either install MetalLB (or an equivalent) for bare-metal, or flip the service type to `NodePort` and front it with an external LB.

## Diagnostic Steps

- Confirm the `Gateway` has been accepted and the route is attached:

  ```bash
  kubectl -n bookinfo get gateway bookinfo-gateway -o yaml \
    | sed -n '/status:/,$p'
  kubectl -n bookinfo get httproute bookinfo -o yaml \
    | sed -n '/status:/,$p'
  ```

  Look for `Accepted=True` and `Programmed=True` on the `Gateway`, and for a populated `parents[*].conditions` on the `HTTPRoute`.

- If the gateway Service has no external IP, check that a LoadBalancer implementation is installed and healthy — the ALB Operator in ACP clusters, or MetalLB/cloud controller manager elsewhere.

- If requests reach the gateway but return `404` on `/productpage`, verify that the sidecars are actually running on the application pods (`2/2` ready). Mesh routing works regardless of sidecar injection, but the Bookinfo app's microservice wiring assumes sidecars are present for mTLS between hops:

  ```bash
  kubectl -n bookinfo get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[*].name}{"\n"}{end}'
  ```

- Tail `istiod` logs while applying the `Gateway` to watch it being accepted by the Istio controller:

  ```bash
  kubectl -n istio-system logs deploy/istiod -f | grep -i 'gateway'
  ```
