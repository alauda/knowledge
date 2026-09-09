---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3'
id: TBD
---

# Kong Installation Guide

## Overview

Kong is a Kubernetes-native API gateway built around the [Kubernetes Gateway API](https://gateway-api.sigs.k8s.io/). The Kong Gateway Operator (KGO) watches Gateway API resources (`GatewayClass`, `Gateway`, `HTTPRoute`, ...) and reconciles the underlying Kong control plane (Kong Ingress Controller) and data plane (Kong Gateway) for you. This guide describes how to install the Kong Operator from the ACP Marketplace, create a `Kong` instance, and validate end-to-end traffic with a minimal Gateway + HTTPRoute example.

### Supported Versions

| Component | Supported Versions |
|-----------|--------------------|
| Kong Operator (KGO) | 2.2.0 |
| Kong Operator chart | 1.3.0 |
| Kong Gateway (data plane) | 3.10 (bundled in the operator package; pinned via `GatewayConfiguration`) |
| Kubernetes Gateway API CRDs | **v1.5 or newer (standard channel)** |
| Kubernetes | **1.30 or newer** (Gateway API v1.5 requirement) |

## Prerequisites

- A target namespace where you will deploy the `Kong` instance.
- **Kubernetes Gateway API CRDs at v1.5 or newer (`standard` channel)** installed cluster-wide. KGO 2.2.0 watches `gateway.networking.k8s.io/v1` `ReferenceGrant`, which graduated to `v1` only in Gateway API v1.5. If your cluster already has Gateway API CRDs from another implementation (Envoy Gateway v1.7, Cilium, etc.) that bundle Gateway API ≤ v1.4, install the newer CRDs explicitly — Helm-installed CRDs are skipped when older versions already exist, so the Kong Operator chart will **not** upgrade them for you:

   ```bash
   kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/standard-install.yaml
   ```

   Verify `referencegrants.gateway.networking.k8s.io` lists `v1` under `spec.versions`. The upgrade is additive and backward-compatible — older controllers continue to read `v1beta1`. See [FAQ](#kgo-pod-crashloops-with-failed-to-wait-for-cache-to-sync) for the symptom this prevents.
- (Optional) The `violet` CLI, downloaded from **App Store > App Onboarding** and matching the target platform version. Only required if the Kong Operator package is not yet uploaded to the target platform.

## Install the Kong Operator

1. Download the **Kong Operator** package from the [Alauda Cloud Console](https://cloud.alauda.io/) Marketplace.
2. If the package has not been uploaded to the target platform, follow the [Upload Packages](https://docs.alauda.io/container_platform/4.2/extend/upload_package.html) guide to upload it to the cluster, or push directly with `violet`:

   ```bash
   violet push \
     --platform-address <platform-address> \
     --clusters <business-cluster-name> \
     --platform-username <platform-admin-username> \
     --platform-password <platform-admin-password> \
     <kong-operator-package>.tgz
   ```

3. Sign in to the platform as an administrator. Navigate to **Administrator > Marketplace > OperatorHub**.
4. Locate **Kong Operator** and click **Install**. Choose the target namespace and accept the defaults. The platform creates a `Subscription` and approves the `InstallPlan`.
5. Wait until the operator `ClusterServiceVersion` reaches the `Succeeded` phase.

### Verify the Operator

```bash
# The CSV should be in the Succeeded phase
kubectl -n <operator-namespace> get csv | grep kong-operator

# The operator Deployment should be Available
kubectl -n <operator-namespace> get deploy kong-operator
```

Expected result:

- The `kong-operator.v2.2.0` CSV is in the `Succeeded` phase.
- The `kong-operator` Deployment is `1/1` ready.

> [!NOTE]
> The `kong-operator` Deployment in the operator namespace is the OLM **wrap operator** — it watches `Kong` custom resources and installs the upstream Kong Operator chart when one is created. The actual Kong Gateway Operator (KGO) controller comes up only after you create a `Kong` instance in the next step.

### Create a Kong Instance

Installing the OLM bundle only brings up the wrap operator. To actually deploy the Kong Gateway Operator (KGO) you create a single **`Kong`** custom resource. We recommend creating it through the OperatorHub form so the install-time defaults are explicit and reviewable.

1. From **Administrator > Marketplace > OperatorHub > Installed**, open **Kong Operator**, switch to the **`Kong`** tab, and click **Create Instance**.
2. The form is grouped into three sections; defaults are tuned for a typical ACP business cluster (which ships cert-manager):

   | Group | Field | Default | Recommendation |
   |-------|-------|---------|----------------|
   | **Certificates** | Use cert-manager for Webhooks | **On** | Leave on. Lets cert-manager issue and auto-renew the conversion / validating webhook certificates. Turn off only if cert-manager is not installed in the cluster (the chart will then self-sign). |
   | **Certificates** | Use cert-manager for Operator CA | **On** | Leave on. cert-manager creates the Issuer that signs the DataPlane ↔ ControlPlane mutual-TLS certificates. |
   | **High Availability** | Replica Count | `1` | Set to `2` or more for production so KGO survives a single Pod restart (leader election handles failover). |
   | **Resources** (advanced) | CPU / Memory requests + limits | `10m / 128Mi` request, `500m / 256Mi` limit | Raise the memory limit to `512Mi+` if you expect many `DataPlane` instances; the default 256Mi limit can OOM under load. |

3. Submit the form. The platform creates a `Kong` resource equivalent to the YAML below (cert-manager toggles on, single replica). All of these fields can also be edited later by reopening the `Kong` instance in the same UI.

   ```yaml
   apiVersion: kong-operator.alauda.io/v1
   kind: Kong
   metadata:
     name: kong-sample
     namespace: kong-system          # any namespace works; the wrap operator watches cluster-wide
   spec:
     global:
       webhooks:
         options:
           certManager:
             enabled: true
       certificateAuthority:
         options:
           certManager:
             enabled: true
     replicaCount: 1
   ```

> [!NOTE]
> The `Kong` CR is a **singleton install-level resource** — it controls how KGO itself is deployed (replicas, resources, cert-manager toggles). Day-to-day routing is managed through the standard Gateway API resources (`GatewayClass`, `Gateway`, `HTTPRoute`), which are created independently of the `Kong` CR. This separation lets cluster admins manage the install once while application teams add routes on their own cadence.

Verify the install completed:

```bash
NAMESPACE=<the namespace you chose>
KONG_CR=kong-sample

kubectl -n ${NAMESPACE} wait kong/${KONG_CR} \
  --for=jsonpath='{.status.conditions[?(@.type=="Deployed")].status}'=True --timeout=300s
kubectl -n ${NAMESPACE} rollout status \
  deploy/${KONG_CR}-kong-operator-controller-manager --timeout=300s
kubectl -n ${NAMESPACE} get certificates
```

Expected result:

- The `Kong` resource reports `status.conditions[Deployed] = True`.
- The `${KONG_CR}-kong-operator-controller-manager` Deployment is Available (1/1).
- Two cert-manager `Issuers` and three `Certificates` (webhook serving, validating webhook serving, operator CA) are all `Ready=True`.
- KGO's own CRDs (`controlplanes`, `dataplanes`, `gatewayconfigurations` under `gateway-operator.konghq.com`) and the Kubernetes Gateway API standard CRDs (`gateways`, `gatewayclasses`, `httproutes`, ... under `gateway.networking.k8s.io`) are registered cluster-wide.

## Quick Start: Serve Traffic Through Kong Gateway

This section assumes the install from the previous chapter is complete — you have a running `Kong` instance and KGO is reconciling Gateway API resources. The quickstart walks through a minimal end-to-end example: declare a `GatewayClass` + `Gateway`, route HTTP traffic to a sample upstream with an `HTTPRoute`, and verify with `curl`.

Set variables used in the commands below:

```bash
export NAMESPACE=kong-demo
export GATEWAY=demo-gateway
kubectl create namespace ${NAMESPACE}
```

### 1. Create a GatewayClass

`GatewayClass` is cluster-scoped and tells the Gateway API which controller manages a given class of Gateways. KGO watches GatewayClasses whose `controllerName` is `konghq.com/gateway-operator`.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: kong
spec:
  controllerName: konghq.com/gateway-operator
```

Apply and confirm KGO has accepted the class:

```bash
kubectl apply -f gatewayclass.yaml
kubectl get gatewayclass kong \
  -o jsonpath='{.status.conditions[?(@.type=="Accepted")].status}{"\n"}'
```

Expected result: `True`. KGO is now ready to reconcile Gateways that reference this class.

### 2. Pin the Kong Gateway Data Plane Image and Service Type

By default KGO creates the `DataPlane`'s ingress Service as `type: LoadBalancer`. On clusters without a LoadBalancer provider (no MetalLB / cloud LB controller) the Service stays `EXTERNAL-IP: <pending>` and the Gateway never reaches `Programmed=True`. `GatewayConfiguration` lets you both pin the data plane image and set the ingress Service type to `NodePort` or `ClusterIP` instead.

The `kong/kong-gateway:3.10` image is bundled with the Kong Operator package — it is synced to the cluster's internal registry and registered in the platform's image whitelist, so the `docker.io/kong/kong-gateway` reference below is rewritten automatically to the internal location. No manual mirroring is needed.

```yaml
apiVersion: gateway-operator.konghq.com/v1beta1
kind: GatewayConfiguration
metadata:
  name: kong-config
  namespace: kong-demo
spec:
  dataPlaneOptions:
    network:
      services:
        ingress:
          type: NodePort           # ClusterIP also works for in-cluster only access
    deployment:
      podTemplateSpec:
        spec:
          containers:
            - name: proxy
              image: kong/kong-gateway:3.10
  controlPlaneOptions:
    deployment:
      podTemplateSpec:
        spec:
          containers:
            - name: controller
              image: kong/kong-operator:2.2.0
```

> [!IMPORTANT]
> Create the `GatewayConfiguration` **before** the `Gateway`. KGO snapshots the configuration when it first creates the `DataPlane` CR for the Gateway; later changes to `GatewayConfiguration` do **not** propagate to existing `DataPlane`s automatically. To apply a change after the fact, `kubectl delete dataplane <name> -n <ns>` — KGO immediately re-creates the DataPlane from the current `GatewayConfiguration`.

### 3. Create a Gateway

A `Gateway` is the request entry point. It references the `GatewayClass` from step 1 and (optionally) the `GatewayConfiguration` from step 2. KGO sees the `Gateway` and dynamically creates a `ControlPlane` + `DataPlane` to serve it.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: demo-gateway
  namespace: kong-demo
spec:
  gatewayClassName: kong
  infrastructure:
    parametersRef:
      group: gateway-operator.konghq.com
      kind: GatewayConfiguration
      name: kong-config
  listeners:
    - name: proxy
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: Same
```

Apply and wait for the Gateway to be programmed:

```bash
kubectl apply -f gateway.yaml
kubectl -n ${NAMESPACE} wait gateway/${GATEWAY} --for=condition=Programmed --timeout=300s
kubectl -n ${NAMESPACE} get gateway ${GATEWAY}
```

Expected result:

- `Accepted=True` (KGO acknowledged the Gateway).
- `Programmed=True` (the underlying `ControlPlane` + `DataPlane` Pods are running and reconciled).
- The Gateway's `status.addresses` shows a Service address you can route traffic to.

### 4. Deploy a Sample Upstream Service

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: echo
  namespace: kong-demo
spec:
  replicas: 1
  selector: {matchLabels: {app: echo}}
  template:
    metadata: {labels: {app: echo}}
    spec:
      containers:
        - name: echo
          image: python:3.12-alpine
          command:
            - python3
            - -c
            - |
              from http.server import BaseHTTPRequestHandler, HTTPServer
              class H(BaseHTTPRequestHandler):
                  def do_GET(s):
                      s.send_response(200); s.end_headers()
                      s.wfile.write(b'hello from echo upstream\n')
              HTTPServer(('', 8080), H).serve_forever()
          ports: [{containerPort: 8080}]
---
apiVersion: v1
kind: Service
metadata: {name: echo, namespace: kong-demo}
spec:
  selector: {app: echo}
  ports: [{port: 8080, targetPort: 8080}]
```

Apply and wait:

```bash
kubectl apply -f echo.yaml
kubectl -n ${NAMESPACE} rollout status deploy/echo
```

### 5. Route Traffic with an HTTPRoute

`HTTPRoute` declares which host/path on the Gateway maps to which backend Service. This is the resource application teams typically create — separately from the `Kong` install CR.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: echo-route
  namespace: kong-demo
spec:
  parentRefs:
    - name: demo-gateway
  hostnames:
    - echo.kong-demo.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: echo
          port: 8080
```

Apply:

```bash
kubectl apply -f httproute.yaml
kubectl -n ${NAMESPACE} get httproute echo-route \
  -o jsonpath='{.status.parents[0].conditions[?(@.type=="Accepted")].status}{"\n"}'
```

Expected result: `True`. The route is bound to the Gateway and KGO has pushed the Kong configuration to the data plane.

### 6. Verify with curl

Find the Gateway's in-cluster ingress Service and probe it from a curl pod. KGO emits **two** Services per DataPlane — an `-admin-` Service (port 8444, internal Kong admin API) and an `-ingress-` Service (port 80, the proxy listener). Filter to the ingress one by name; the chart label `gateway-operator.konghq.com/managed-by=dataplane` is set on both and is not specific enough.

```bash
# Pick the ingress Service (not the admin Service)
GATEWAY_SVC=$(kubectl -n ${NAMESPACE} get svc -o name \
  | grep dataplane-ingress | head -1 | sed 's|service/||')
echo "Gateway service: ${GATEWAY_SVC}"

kubectl -n ${NAMESPACE} run probe --rm -it --restart=Never \
  --image=curlimages/curl:latest \
  -- sh -c "
       echo '--- valid host -> expect 200 ---'
       curl -sS -H 'Host: echo.kong-demo.example.com' http://${GATEWAY_SVC}.${NAMESPACE}.svc:80/
       echo '--- wrong host -> expect 404 ---'
       curl -sS -o /dev/null -w 'http %{http_code}\n' -H 'Host: other.example.com' http://${GATEWAY_SVC}.${NAMESPACE}.svc:80/
     "
```

Expected output:

```text
--- valid host -> expect 200 ---
hello from echo upstream
--- wrong host -> expect 404 ---
http 404
```

If you set `dataPlaneOptions.network.services.ingress.type: NodePort` in step 2, you can also reach the Gateway from outside the cluster via any node IP and the assigned NodePort:

```bash
kubectl -n ${NAMESPACE} get svc | grep dataplane-ingress
# Look for the "80:<NODEPORT>/TCP" column

NODE_IP=$(kubectl get node -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
NODE_PORT=$(kubectl -n ${NAMESPACE} get svc \
  -o jsonpath="{.items[?(@.metadata.name=='${GATEWAY_SVC}')].spec.ports[0].nodePort}")
curl -sS -H 'Host: echo.kong-demo.example.com' http://${NODE_IP}:${NODE_PORT}/
```

## Cleanup

For a test deployment, remove the resources created above:

```bash
kubectl delete namespace ${NAMESPACE}
kubectl delete gatewayclass kong
```

> [!IMPORTANT]
> Many of the chart-installed CRDs are annotated with `helm.sh/resource-policy: keep` to preserve schema (and therefore any user resources) across re-installs. Deleting the namespace removes the `Kong` CR and triggers `helm uninstall`, but the CRDs persist by design. If you intend to re-install Kong with a **different release name later**, you may need to re-stamp the ownership annotations on those CRDs so the new release can claim them. Re-installing with the same `Kong` CR name (`kong-sample` in this guide) avoids the issue.

To remove the operator, delete its `Subscription` and `ClusterServiceVersion` from **Administrator > Marketplace > OperatorHub > Installed**, or:

```bash
kubectl -n <operator-namespace> delete subscription kong-operator
kubectl -n <operator-namespace> delete csv kong-operator.v2.2.0
```

## FAQ

### What is the difference between the "Kong Operator" in OperatorHub and the "Kong Gateway Operator"?

There are two operators in this stack:

1. **The OLM wrap operator** (shown as "Kong Operator" in OperatorHub) is a thin helm-operator installed by ACP. Its job is to watch the `Kong` custom resource and apply the upstream Kong Operator Helm chart for you.
2. **The Kong Gateway Operator (KGO)** is the upstream Kong project (`github.com/Kong/kong-operator`). It reconciles Gateway API resources into actual Kong Gateway and Kong Ingress Controller Pods.

You install (1) once from OperatorHub. Creating a `Kong` CR triggers (1) to deploy (2). All day-to-day routing work targets the Gateway API resources reconciled by (2).

### Why isn't there a single "Kong" CR that contains my Gateways and HTTPRoutes?

`Gateway`, `GatewayClass`, and `HTTPRoute` are first-class Kubernetes Gateway API resources, designed to be managed independently:

- `GatewayClass` is cluster-scoped and typically owned by the platform admin.
- `Gateway` is namespaced and typically owned by a network/platform team.
- `HTTPRoute` is namespaced and typically owned by an application team — there can be hundreds of them.

Embedding these inside the `Kong` install CR would collapse three distinct lifecycles into one giant object and break the standard tooling (kubectl plugins, GitOps, policy engines) that expects them as separate resources. The `Kong` CR is intentionally limited to install-time concerns.

### KGO pod CrashLoops with "failed to wait for Cache to sync"

Symptom: the `<release>-kong-operator-controller-manager` Pod restarts every ~5 minutes. Its previous-container log shows:

```
failed to wait for gateway caches to sync kind source: *v1.ReferenceGrant: timed out waiting for cache to be synced
"if kind is a CRD, it should be installed before calling Start","kind":"ReferenceGrant.gateway.networking.k8s.io"
"no matches for kind \"ReferenceGrant\" in version \"gateway.networking.k8s.io/v1\""
```

Cause: KGO 2.2.0 watches `gateway.networking.k8s.io/v1` `ReferenceGrant`, which only exists in Gateway API CRDs at **v1.5 or newer**. If the cluster already had older Gateway API CRDs from another implementation (Envoy Gateway v1.7 ships Gateway API v1.4.1, for example), Helm-installed CRDs are skipped on conflict, and the Kong Operator chart leaves the older CRDs in place. KGO then can't find the `v1` group it expects.

Fix: install the upstream Gateway API v1.5+ standard CRDs (additive, backward-compatible — older controllers keep working on `v1beta1`):

```bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/standard-install.yaml

kubectl get crd referencegrants.gateway.networking.k8s.io \
  -o jsonpath='{range .spec.versions[*]}{.name}{"\n"}{end}'
# Expected output includes v1, v1beta1, v1alpha2

kubectl -n <namespace> rollout restart deploy/<release>-kong-operator-controller-manager
```

After the restart, the Pod stays Ready=True without further CrashLoops.

### Kong Gateway Pods stay in `ImagePullBackOff`

Symptom: after step 3 the Gateway never reaches `Programmed=True`, and `kubectl describe pod` on a DataPlane Pod shows `Failed to pull image "kong/kong-gateway:3.10": rpc error: ...`.

Cause: this should be rare — the Kong Operator package bundles `kong/kong-gateway:3.10` to the cluster's internal registry, and the platform's image whitelist rewrites `docker.io/kong/kong-gateway` references automatically. If you hit this, it usually means the image whitelist was not provisioned for your namespace yet, or the namespace was created before the Kong Operator was installed.

Fix: confirm the image is on the internal registry, and that your namespace receives the rewrite (the platform tool surface for image whitelists varies by ACP version). As a workaround you can override the image on the `GatewayConfiguration` to a fully-qualified internal path, for example `<your-internal-registry>/3rdparty/kong/kong-gateway:3.10`. Re-apply the `GatewayConfiguration` and `kubectl delete dataplane <name>` to force KGO to re-create the DataPlane with the new image.

### The `Kong` install fails with "cannot import: invalid ownership metadata"

Symptom: `kubectl describe kong kong-sample` reports a `ReleaseFailed` condition with text like:

```
CustomResourceDefinition "<name>" exists and cannot be imported into the current release:
invalid ownership metadata; annotation validation error: key "meta.helm.sh/release-name"
must equal "<new-release>": current value is "<old-release>"
```

Cause: a previous `Kong` CR with a different name (or in a different namespace) installed the chart, was deleted, and the chart's cluster-scoped CRDs (annotated `helm.sh/resource-policy: keep`) survived. The new `Kong` install cannot claim CRDs owned by a different Helm release.

Fix: either re-install with the original release name, or re-stamp the CRD ownership to the new release:

```bash
NEW_REL=kong-sample
NEW_NS=kong-demo
for crd in $(kubectl get crd -o name | grep -E 'konghq\.com$|kong-operator'); do
  kubectl annotate $crd \
    meta.helm.sh/release-name=$NEW_REL \
    meta.helm.sh/release-namespace=$NEW_NS --overwrite
  kubectl label $crd app.kubernetes.io/managed-by=Helm --overwrite
done
```

Repeat for `ClusterRole`, `ClusterRoleBinding`, `ValidatingAdmissionPolicy`, `ValidatingAdmissionPolicyBinding`, and `ValidatingWebhookConfiguration` resources if their ownership metadata also mismatches.

### Where can I learn more?

- Upstream Kong Operator: [github.com/Kong/kong-operator](https://github.com/Kong/kong-operator)
- Upstream Helm chart: [github.com/Kong/charts](https://github.com/Kong/charts/tree/main/charts/kong-operator)
- Kubernetes Gateway API: [gateway-api.sigs.k8s.io](https://gateway-api.sigs.k8s.io/)
- Kong Gateway documentation: [docs.konghq.com/gateway](https://docs.konghq.com/gateway/)
