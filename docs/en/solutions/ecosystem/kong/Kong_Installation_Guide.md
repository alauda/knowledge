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
| Kong Gateway (data plane, for the quickstart) | 3.10 |
| Kubernetes Gateway API | v1 (standard channel CRDs) |
| cert-manager (required) | 1.13+ |

## Prerequisites

- An ACP cluster with the **OperatorHub** feature enabled.
- **cert-manager installed and Ready in the cluster.** KGO 2.2.0 uses cert-manager to issue its admission/conversion webhook certificates and its internal CA. The default form options assume cert-manager is present; without it the install will fail to create `Issuer`/`Certificate` resources. ACP business clusters ship cert-manager by default.
- **Kubernetes Gateway API CRDs at v1.5 or newer (`standard` channel)** installed cluster-wide. KGO 2.2.0 watches `gateway.networking.k8s.io/v1` `ReferenceGrant`, which graduated to `v1` only in Gateway API v1.5. If your cluster already has Gateway API CRDs from another implementation (Envoy Gateway v1.7, Cilium, etc.) that bundle Gateway API ≤ v1.4, install the newer CRDs explicitly — Helm-installed CRDs are skipped when older versions already exist, so the Kong Operator chart will **not** upgrade them for you:

   ```bash
   kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/standard-install.yaml
   ```

   Verify `referencegrants.gateway.networking.k8s.io` lists `v1` under `spec.versions`. The upgrade is additive and backward-compatible — older controllers continue to read `v1beta1`. See [FAQ](#kgo-pod-crashloops-with-failed-to-wait-for-cache-to-sync) for the symptom this prevents.
- A target namespace where you will deploy the `Kong` instance.
- Business cluster nodes can access the platform image registry. The Kong Gateway data plane image (`kong/kong-gateway`) must be pullable; on restricted networks use a mirror (see [FAQ](#kong-gateway-pods-stay-in-imagepullbackoff)).
- (Optional) The `violet` CLI, downloaded from **App Store > App Onboarding** and matching the target platform version. Only required if the Kong Operator plugin package is not yet uploaded to the target platform.

## Install the Kong Operator

1. Download the **Kong Operator** plugin from the [Alauda Cloud Console](https://cloud.alauda.io/) Marketplace.
2. If the plugin package has not been uploaded to the target platform, follow the [Upload Packages](https://docs.alauda.io/container_platform/4.2/extend/upload_package.html) guide to upload it to the cluster, or push directly with `violet`:

   ```bash
   violet push \
     --platform-address <platform-address> \
     --clusters <business-cluster-name> \
     --platform-username <platform-admin-username> \
     --platform-password <platform-admin-password> \
     <kong-operator-plugin-package>.tgz
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

### 2. Pin the Kong Gateway Data Plane Image (Optional but Recommended)

By default KGO selects a built-in default Kong Gateway image when it creates a `DataPlane` for a `Gateway`. Pinning the image via `GatewayConfiguration` makes the version explicit and lets you point to an internal registry mirror if your cluster cannot reach `docker.io` directly.

```yaml
apiVersion: gateway-operator.konghq.com/v1beta1
kind: GatewayConfiguration
metadata:
  name: kong-config
  namespace: kong-demo
spec:
  dataPlaneOptions:
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

> [!TIP]
> If your cluster mirrors `docker.io`, replace the image references with the mirrored equivalents — for example `docker-mirrors.alauda.cn/kong/kong-gateway:3.10`.

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

Find the Gateway's in-cluster Service and probe it from a curl pod:

```bash
# The DataPlane Service that fronts the Gateway listeners
GATEWAY_SVC=$(kubectl -n ${NAMESPACE} get svc \
  -l gateway-operator.konghq.com/managed-by=dataplane \
  -o jsonpath='{.items[0].metadata.name}')
echo "Gateway service: ${GATEWAY_SVC}"

kubectl -n ${NAMESPACE} run probe --rm -it --restart=Never \
  --image=curlimages/curl:latest \
  -- curl -sS -H 'Host: echo.kong-demo.example.com' \
       http://${GATEWAY_SVC}.${NAMESPACE}.svc:80/
```

Expected output:

```text
hello from echo upstream
```

Requests to the same Gateway with a Host header that doesn't match the `HTTPRoute.hostnames` return `404` — Kong rejects them as unrouted.

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

Cause: your cluster cannot reach `docker.io` directly.

Fix: set the data plane and control plane images on the `GatewayConfiguration` to your internal mirror, for example:

```yaml
spec:
  dataPlaneOptions:
    deployment:
      podTemplateSpec:
        spec:
          containers:
            - name: proxy
              image: docker-mirrors.alauda.cn/kong/kong-gateway:3.10
  controlPlaneOptions:
    deployment:
      podTemplateSpec:
        spec:
          containers:
            - name: controller
              image: docker-mirrors.alauda.cn/kong/kong-operator:2.2.0
```

Re-apply the `GatewayConfiguration`. KGO rolls the DataPlane to the new image.

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
