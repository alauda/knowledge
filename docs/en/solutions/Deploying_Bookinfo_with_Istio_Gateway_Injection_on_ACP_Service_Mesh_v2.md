---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A developer wants to stand up the Istio **Bookinfo** sample on an ACP **Service Mesh v2** cluster and reach the product page from outside the cluster. The tricky part — compared to the old `ServiceMeshControlPlane`-driven model — is that gateways are no longer spun up automatically by the mesh operator. The user is responsible for declaring and deploying the ingress gateway, which is normally done through **gateway injection**: the same mechanism that injects the Envoy sidecar next to an application pod is reused to materialise a gateway Deployment from a bare Deployment manifest.

## Resolution

### Preferred: ACP Service Mesh v2 using namespace-scoped gateway injection

In Service Mesh v2 there is no implicit ingress gateway. The pattern is: label the application namespace so the mesh control plane discovers it and the sidecar injector kicks in for pods created there; deploy the application; then deploy the gateway Deployment with the gateway-injection label, which causes the injector to build an Envoy gateway pod. The gateway is exposed with a standard Kubernetes `Service` and fronted by the platform's ingress layer (ACP ALB Operator) — `Route`-style objects are not used.

1. **Create the application namespace.**

   ```bash
   kubectl create namespace bookinfo
   ```

2. **Enable discovery and sidecar injection on the namespace.** The `istio-discovery` label tells the Istio control plane it should watch this namespace; `istio-injection` tells the mutating webhook to inject sidecars into new pods.

   ```bash
   kubectl label namespace bookinfo \
     istio-discovery=enabled \
     istio-injection=enabled
   ```

   Either label (namespace-wide or per-pod) can gate injection. Namespace-wide is the simpler starting point.

3. **Deploy the Bookinfo application.** The upstream sample manifest creates the four services (productpage, details, reviews, ratings) and their deployments. With injection enabled at the namespace level, each application pod comes up with an `istio-proxy` sidecar.

   ```bash
   kubectl -n bookinfo apply -f \
     https://raw.githubusercontent.com/istio/istio/release-1.24/samples/bookinfo/platform/kube/bookinfo.yaml
   ```

4. **Verify application pods are running with two containers each.**

   ```bash
   kubectl -n bookinfo get pods
   ```

   Each pod should show `2/2` ready; the second container is the injected `istio-proxy`.

5. **Deploy the ingress gateway via gateway injection.** The manifest below creates a `Deployment` annotated/labelled so that the injector recognises it as a gateway rather than a sidecar target, and builds an Envoy gateway pod in place of the placeholder container. A ready-made sample is published by the sail-operator project:

   ```bash
   kubectl -n bookinfo apply -f \
     https://raw.githubusercontent.com/istio-ecosystem/sail-operator/main/chart/samples/ingress-gateway.yaml
   ```

   This lands an `istio-ingressgateway` Deployment + Service in `bookinfo`. Because the gateway pod was built by the mesh's injector, it understands the same xDS stream as the sidecars and picks up Istio `Gateway` + `VirtualService` resources the moment they are applied.

6. **Verify the gateway pod is running.**

   ```bash
   kubectl -n bookinfo get pods -l istio=ingressgateway
   ```

7. **Apply the Bookinfo `Gateway` + `VirtualService`.** The upstream sample configures a `Gateway` bound to the ingress gateway's selector and a `VirtualService` that routes `/productpage`, `/static`, `/login`, `/logout`, and `/api/v1/products` to the productpage service.

   ```bash
   kubectl -n bookinfo apply -f \
     https://raw.githubusercontent.com/istio/istio/release-1.24/samples/bookinfo/networking/bookinfo-gateway.yaml
   ```

8. **Expose the gateway externally through the ALB.** Because ACP's ingress layer is the ALB (not a cluster-router product), the gateway's `Service` is reached through a standard Kubernetes `Ingress` pointed at `istio-ingressgateway`. Minimal example:

   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: Ingress
   metadata:
     name: bookinfo
     namespace: bookinfo
     annotations:
       # Replace with the ALB CR name in this cluster.
       project.cpaas.io/alb-name: cpaas-alb
   spec:
     rules:
       - host: bookinfo.apps.example.com
         http:
           paths:
             - path: /
               pathType: Prefix
               backend:
                 service:
                   name: istio-ingressgateway
                   port:
                     number: 80
   ```

   Apply with `kubectl apply -f bookinfo-ingress.yaml`.

9. **Exercise the route.**

   ```bash
   curl -s http://bookinfo.apps.example.com/productpage | head -n 5
   ```

   A successful response returns the Bookinfo HTML (containing `<title>Simple Bookstore App</title>` and similar markers). The HTTP path went: client → ALB → `istio-ingressgateway` pod → `productpage` pod via sidecar.

### Fallback: plain upstream Istio (no ACP mesh management)

If Istio is installed by hand (not through ACP's `service_mesh` capability), the steps are identical with two adjustments: the `istio-discovery` label is not required (plain Istio discovers all namespaces by default unless `discoverySelectors` are configured), and the external hop in step 8 is replaced with whichever ingress mechanism the cluster uses (cloud LoadBalancer, NodePort, plain NGINX, etc.). The sail-operator gateway-injection manifest and the Bookinfo sample are unchanged.

## Diagnostic Steps

Check the sidecar was injected into each Bookinfo pod:

```bash
kubectl -n bookinfo get pod -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.containers[*]}{.name}{","}{end}{"\n"}{end}'
```

Every pod should list two containers: the application container and `istio-proxy`. If a pod has only one container, the namespace label is missing or the webhook did not fire — re-check:

```bash
kubectl get namespace bookinfo --show-labels
kubectl get mutatingwebhookconfiguration | grep sidecar
```

Confirm the gateway is routing:

```bash
kubectl -n bookinfo get gateway,virtualservice
kubectl -n bookinfo logs -l istio=ingressgateway -c istio-proxy --tail=20
```

A healthy gateway log shows xDS push receipts (`ads LDS: PUSH ...`, `ads RDS: PUSH ...`) followed by access-log lines once traffic starts flowing. Absence of either points the finger at the control-plane connection: from the gateway pod, `istioctl proxy-status` (or `kubectl exec` into the gateway and query `localhost:15000/config_dump`) shows whether routes and clusters were pushed in.

End-to-end reachability from outside:

```bash
curl -v http://bookinfo.apps.example.com/productpage 2>&1 | head -n 30
```

If the first hop (ALB) fails, check the ALB's own logs and the Ingress resource status. If the ALB connects but the gateway returns `404`, the `VirtualService` host does not match the incoming `Host` header — Istio gateways are strict on the `hosts:` field of the matching `Gateway`; adding `"bookinfo.apps.example.com"` to that list or using `"*"` during development resolves the mismatch.
