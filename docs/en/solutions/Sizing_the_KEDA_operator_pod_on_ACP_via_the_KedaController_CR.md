---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500841
---

# Sizing the KEDA operator pod on ACP via the KedaController CR

## Issue

The CPU and memory requests/limits on the KEDA operator pod (`keda-operator` deployment, reconciled by the KEDA `OperatorBundle`) need to be raised — for example to handle a larger number of `ScaledObject`/`ScaledJob` CRs or to avoid OOMKills under load. Editing the `keda-operator` Deployment directly is not stable because the operator's own controller continually reconciles the Deployment spec back to whatever the `KedaController` CR declares.

## Resolution

Edit the `KedaController` CR instance and add a `resources` block under `spec.operator`. ACP ships KEDA as the `keda` `OperatorBundle` (default channel `stable`, current CSV `keda.v2.16.0`, repository `middleware/keda-bundle`) in the `cpaas-system` `custom` catalog. The `KedaController` CRD (`kedacontrollers.keda.sh/v1alpha1`, owned by the CSV) is what the operator reconciles into the `keda-operator`, `keda-metrics-apiserver`, and `keda-admission-webhooks` Deployments.

```yaml
apiVersion: keda.sh/v1alpha1
kind: KedaController
metadata:
  name: keda
  namespace: keda
spec:
  operator:
    resources:
      requests:
        cpu: "1"
        memory: 1Gi
      limits:
        cpu: "1"
        memory: 2Gi
```

After the `KedaController` is updated, the operator rolls the `keda-operator` Deployment to the new resource values on its next reconcile.

The same shape is available for the other two KEDA component pods, each accepting a standard Kubernetes `ResourceRequirements` object (`limits` / `requests`):

- `spec.metricsServer.resources` — sizes the `keda-metrics-apiserver` Deployment (the `external.metrics.k8s.io` provider that backs HPAs driven by `ScaledObject`s).
- `spec.admissionWebhooks.resources` — sizes the `keda-admission-webhooks` Deployment.

> **Version note.** The article that motivated this solution describes two different KEDA versions: `2.9.X` (field path `spec.operator.resourcesKedaOperator`) and `2.11.X` (field path `spec.operator.resources`). ACP ships only KEDA `2.16.0`; on `2.16.0` the field is `spec.operator.resources` (matches the 2.11.X-style path). The `resourcesKedaOperator` field name does not exist in the `2.16.0` `KedaController` CRD — applying a CR with `spec.operator.resourcesKedaOperator` would be silently dropped by apiserver schema validation. Use `spec.operator.resources` on ACP.

## Diagnostic Steps

Confirm the catalog has the `keda` package and which CSV version is current.

```bash
kubectl get packagemanifest -A | grep -i keda
kubectl get packagemanifest keda -n cpaas-system \
  -o jsonpath='{.status.channels[*].currentCSV} {.status.defaultChannel}{"\n"}'
```

On a verified install the package is `cpaas-system keda <catalog>`, `currentCSV` is `keda.v2.16.0`, default channel `stable`.

Confirm the `KedaController` CRD is registered (it is owned by the KEDA CSV — present once the bundle is subscribed). Expected output: `v1alpha1`.

```bash
kubectl get crd kedacontrollers.keda.sh \
  -o jsonpath='{.spec.versions[*].name}{"\n"}'
```

Inspect the live CRD schema to confirm the field path before applying — the field is `spec.operator.resources` on KEDA `2.16.0`; each `explain` should describe a standard `ResourceRequirements` object (`limits`, `requests`, `claims`).

```bash
kubectl explain kedacontroller.spec.operator.resources
kubectl explain kedacontroller.spec.metricsServer.resources
kubectl explain kedacontroller.spec.admissionWebhooks.resources
```

Confirm the `KedaController` instance and the resulting `keda-operator` Deployment spec after editing the CR.

```bash
kubectl -n keda get kedacontroller keda \
  -o jsonpath='{.spec.operator.resources}{"\n"}'
kubectl -n keda get deploy keda-operator \
  -o jsonpath='{.spec.template.spec.containers[*].resources}{"\n"}'
```

The values on the Deployment should match what is set under `spec.operator.resources` on the `KedaController` CR. If they do not match, look at the KEDA operator pod logs in the operator's install namespace for reconcile errors.
