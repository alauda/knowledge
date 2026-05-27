---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Misleading istiod webhook UPDATE errors when the control plane runs more than one replica

## Issue

On Alauda Container Platform (Kubernetes `v1.34.5`), when an Istio control plane is installed through the Alauda Service Mesh path — for example via the `asm-operator` package (PackageManifest `asm-operator`, current CSV `asm.v4.3.3`, channel `alpha`) or the `servicemesh-operator2` package, with the `asm-global` ModulePlugin (chart `asm/chart-global-asm` v4.3.1) registering Istio at the cluster level — the istiod Deployment in the `istio-system` namespace packages upstream Istio unchanged. Operators following istiod logs in a multi-replica control-plane configuration see paired error lines reporting that an UPDATE of the `istio-validator-<rev>` ValidatingWebhookConfiguration could not be fulfilled. The lines look like genuine validation-controller failures but originate from the standard kube-apiserver optimistic-concurrency check rather than from a malformed webhook update.

## Root Cause

Every istiod pod runs its own validation controller, and each controller independently attempts to update the same cluster-scoped `istio-validator-<rev>` ValidatingWebhookConfiguration object. When the istiod Deployment is scaled to more than one replica, multiple controllers race to write the same object on overlapping reconcile cycles.

The kube-apiserver enforces optimistic concurrency on every UPDATE call: if the request body carries a `metadata.resourceVersion` that no longer matches the object's current resourceVersion, the request is rejected with the canonical error string beginning `Operation cannot be fulfilled on <resource>.<group> "<name>":` and ending with `the object has been modified, please apply your changes to the latest version and try again`. This behavior is built into the apiserver admission stack and applies to the entire generic `admissionregistration.k8s.io/v1` family (MutatingWebhookConfiguration, ValidatingWebhookConfiguration, and the ValidatingAdmissionPolicy(Binding) shapes), which is the same shape available on ACP.

When two or more istiod replicas reconcile the validator webhook on the same loop, only the first UPDATE in each round wins; the rest carry a now-stale resourceVersion and are rejected by the apiserver under exactly that rule. The losing reconcilers surface the rejection in istiod's logs as a pair of lines — a validationController message of the form `error validationController failed to updated: Operation cannot be fulfilled on validatingwebhookconfigurations.admissionregistration.k8s.io "istio-validator-istio-system"` followed by the standard stale-resourceVersion tail and a `resource version=<N>` token, and an immediately paired `error controllers error handling istio-validator-istio-system, retrying (retry count: 1): fail to update webhook: Operation cannot be fulfilled ... controller=validation` line from the controller layer indicating that the reconciler will retry on the next loop.

## Resolution

Treat these log lines as an expected artifact of running more than one istiod replica against a single shared ValidatingWebhookConfiguration object — they are an emergent property of the generic apiserver concurrency rule applied to a multi-writer Istio control plane, not a webhook misconfiguration. No change to the validator webhook, to the istiod Deployment manifest, or to the apiserver is required for the validation pipeline itself to keep working.

To stop the noise outright, run the istiod Deployment with a single replica when the workload does not require horizontal scaling of the control plane. With one writer there is no concurrent UPDATE against `istio-validator-<rev>` and the optimistic-concurrency rejections do not arise.

When multiple istiod replicas are required for availability or capacity reasons, leave the Deployment scaled out and filter the paired lines (validationController plus controllers/validation retry) out of istiod log alerting so that benign concurrency rejections do not generate operator pages. The underlying ACP packaging — the `asm-operator` package (CSV `asm.v4.3.3`) or `servicemesh-operator2`, surfaced on the cluster via the `asm-global` ModulePlugin (chart `asm/chart-global-asm` v4.3.1) — ships upstream istiod with the standard validation controller; the same log shape applies once an Istio control plane is instantiated.

## Diagnostic Steps

Confirm the istiod replica count in the Istio control-plane namespace (the convention is `istio-system`); a count greater than one is the precondition for the concurrent-UPDATE race that produces the log noise:

```bash
kubectl get deployment -n istio-system -l app=istiod \
 -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.replicas}{"\n"}{end}'
```

Inspect istiod logs for the paired validationController and controllers/validation lines. The first message identifies the failing UPDATE against the cluster-scoped ValidatingWebhookConfiguration; the second confirms the reconciler is treating it as a retryable error:

```bash
kubectl logs -n istio-system -l app=istiod --tail=2000 \
 | grep -E 'validationController failed to updated|controllers error handling istio-validator'
```

Verify that the target object is the single cluster-scoped ValidatingWebhookConfiguration named after the Istio revision (default revision: `istio-validator-istio-system`), at the generic `admissionregistration.k8s.io/v1` shape — the same primitive available on any conformant Kubernetes cluster including ACP:

```bash
kubectl get validatingwebhookconfiguration \
 -l app=istiod -o name
```

If the cluster has not yet had an Istio control plane instantiated — for example when `asm-operator` and `servicemesh-operator2` are only available as PackageManifests, the `asm-global` ModulePlugin is registered, but no `ClusterPluginInstance` and no Istio control-plane CR have been created — the istiod Deployment does not exist and these log lines cannot appear. Create the Istio control-plane instance first, and only then revisit istiod logs for the paired error pattern.
