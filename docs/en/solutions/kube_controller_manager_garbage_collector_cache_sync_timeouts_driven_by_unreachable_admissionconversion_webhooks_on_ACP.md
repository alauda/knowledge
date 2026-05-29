---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# kube-controller-manager garbage collector cache-sync timeouts driven by unreachable admission/conversion webhooks on ACP

## Issue

On Alauda Container Platform (Kubernetes `v1.34.5`, kube-controller-manager image tag `v1.34.5`) the `kube-controller-manager` runs as a kubelet-managed static pod `kube-controller-manager-<nodeIP>` in the `kube-system` namespace; the garbage-collector controller built into that binary logs `Waiting for caches to sync for garbage collector` at startup and during reconcile (upstream source `shared_informer.go`, with the exact source line varying by build).

When the garbage-collector controller's dependency-graph builder cannot finish syncing within its wait window, the same kube-controller-manager static pod emits `Unhandled Error err="unable to sync caches for garbage collector" logger="UnhandledError"` followed by `Unhandled Error err="timed out waiting for dependency graph builder sync during GC sync (attempt <N>)" logger="UnhandledError"` from the `garbagecollector.go` emitter. The pod-garbage-collector sub-controller inside the same binary independently emits `"Garbage collecting pods" logger="pod-garbage-collector-controller" numPods=<N>` and per-pod `"PodGC is force deleting Pod" logger="pod-garbage-collector-controller" pod="<ns>/<name>"` lines from `gc_controller.go` during a pod-GC sweep, so the two loggers are observable side-by-side when reading the static pod's log stream.

The entry point for diagnosing this failure mode is inspection of the kube-controller-manager static pod itself in `kube-system` plus the GC log lines above — those log lines come from the same `garbagecollector.go` / `gc_controller.go` / `shared_informer.go` emitters observable on any conformant Kubernetes cluster running this kube-controller-manager build, with admission and conversion-webhook posture as the adjacent surface to check.

## Root Cause

The most common driver of these cache-sync timeouts is an unreachable admission or conversion webhook that the kube-apiserver must call while serving the list/watch requests the garbage collector's dependency-graph builder issues. When a registered `CustomResourceDefinition` declares `spec.conversion.strategy: Webhook` and its target webhook Service has no Ready endpoints, kube-apiserver's storage cacher / reflector logs `failed to list <group>/<version>, Kind=<Kind>: conversion webhook for <group>/<otherVersion>, Kind=<Kind> failed: Post "https://<svc>.<ns>.svc:443/convert?timeout=30s": no endpoints available for service "<svc>"` from the upstream `storage/cacher.go` and `reflector.go` sources and reinitializes the cacher. ACP today has at least four CRDs configured with `spec.conversion.strategy: Webhook` (`argocds.argoproj.io`, `clusterclasses.cluster.x-k8s.io`, `monitordashboards.ait.alauda.io`, `opentelemetrycollectors.opentelemetry.io`), any of which can drive this path if its backing webhook Service loses endpoints.

Each conversion-webhook call that the kube-apiserver makes to an unreachable webhook Service blocks the apiserver list/watch path for the affected CRD and adds per-call latency up to the per-webhook `timeoutSeconds` (default reflected in the `?timeout=30s` query parameter on conversion calls). That latency propagates to every controller — including the kube-controller-manager garbage collector and its leader-election renewals — that needs to read the affected resources, which is why GC dependency-graph builder sync can time out even though the controller itself is healthy. The same shape applies to admission webhooks: the `MutatingWebhookConfiguration` and `ValidatingWebhookConfiguration` types in `admissionregistration.k8s.io/v1` define per-webhook `timeoutSeconds` (integer 1-30, default 10) and `failurePolicy` (enum `{Fail, Ignore}`), and a webhook with `failurePolicy: Fail` whose backing Service has no Ready endpoints blocks admission until that timeout elapses.

Intermittent GC cache-sync timeouts can also be driven by a very large total number of API resources / CRDs registered on the cluster, because the garbage collector's dependency-graph builder must discover and watch every resource type before it can declare caches synced; cost scales with that count. Independently, kube-controller-manager renews its leader lease via the `kube-system/kube-controller-manager` Lease object (`coordination.k8s.io/v1`) with `--leader-elect=true` set on its static pod command line, and when the API call to that lease endpoint is slowed by the same upstream apiserver latency it logs `error retrieving resource lock kube-system/kube-controller-manager: Get "<apiserver-url>/apis/coordination.k8s.io/v1/namespaces/kube-system/leases/kube-controller-manager?timeout=<N>s": net/http: request canceled (Client.Timeout exceeded while awaiting headers)` or `: context deadline exceeded` from `leaderelection.go` — the same emitter, with the apiserver-URL host portion reflecting whatever the cluster's control-plane endpoint resolves to.

## Resolution

Restore the webhook's backing pods to a Ready state so the target Service has Ready endpoints again; this eliminates the `no endpoints available for service` rejection and allows the webhook calls to succeed without timing out, which in turn lets the garbage collector's dependency-graph builder finish syncing and the apiserver list/watch path resume normal latency.

Alternatively, when the webhook's backing workload cannot be recovered promptly and the webhook is not required for the operation of the cluster, delete the offending admission webhook configuration object — removing it eliminates the per-call latency that webhook adds to kube-apiserver admission and list/watch paths:

```bash
kubectl delete mutatingwebhookconfiguration <name>
kubectl delete validatingwebhookconfiguration <name>
```

For an unreachable conversion webhook tied to a CRD, the equivalent unblock is to restore the backing Service endpoints, since the conversion-webhook clientConfig is part of the CRD spec and the `apiextensions.k8s.io/v1` `ServiceReference` shape (`name` required, `namespace` required, `path` optional, `port` default 443) is byte-identical to the standard form.

## Diagnostic Steps

Read the kube-controller-manager static pod log stream in `kube-system` for the `garbage-collector-controller` and `pod-garbage-collector-controller` loggers — the upstream `shared_informer.go`, `garbagecollector.go`, and `gc_controller.go` emitters all log against these loggers, so a single log fetch surfaces the GC startup, cache-sync, and pod-GC sweep lines:

```bash
kubectl get pods -n kube-system | grep kube-controller-manager
kubectl logs -n kube-system kube-controller-manager-<nodeIP> \
  | grep -E 'garbage|GC|garbagecollector|gc_controller|shared_informer'
```

Look for the leader-election precursor `error retrieving resource lock kube-system/kube-controller-manager` line in the same stream — its appearance alongside GC cache-sync errors points to upstream apiserver latency rather than a controller-local problem, since lease renewals run on the same client the controllers use:

```bash
kubectl get lease -n kube-system kube-controller-manager -o yaml
```

Enumerate the admission webhooks the kube-apiserver will call during admission, plus the conversion webhooks the apiserver storage cacher will call while serving list/watch — listing `MutatingWebhookConfiguration` and `ValidatingWebhookConfiguration` (cluster-scoped in `admissionregistration.k8s.io/v1`) and inspecting each for the target Service and `clientConfig` / `failurePolicy` identifies the candidate offending webhook:

```bash
kubectl get mutatingwebhookconfiguration
kubectl get validatingwebhookconfiguration
kubectl describe mutatingwebhookconfiguration <name>
```

Cross-reference each webhook configuration's target Service against the current Endpoints in its namespace — a webhook whose `clientConfig.service` points at a Service with no Ready endpoints is the candidate for either Service-side recovery (Resolution `c11_b`) or webhook-config deletion (Resolution `c11_a`):

```bash
kubectl -n <webhook-svc-namespace> get endpoints <webhook-svc-name> -o yaml
```

For CRDs that go through a conversion webhook, list those with `spec.conversion.strategy: Webhook` and inspect each one's `spec.conversion.webhook.clientConfig.service` against the matching Service Endpoints — the conversion-webhook clientConfig follows the upstream `apiextensions.k8s.io/v1` `ServiceReference` shape (`name` required, `namespace` required, `path` optional, `port` default 443) so the same Endpoints check applies:

```bash
kubectl get crd \
  -o jsonpath='{range .items[?(@.spec.conversion.strategy=="Webhook")]}{.metadata.name}{"\n"}{end}'
kubectl get crd <name> \
  -o jsonpath='{.spec.conversion.webhook.clientConfig.service}{"\n"}'
```

When the total number of registered CRDs and API resources is unusually large, factor that into the cache-sync timeout window — the garbage collector's dependency-graph builder must discover and watch every kind before caches sync, and cost scales with the count:

```bash
kubectl api-resources | wc -l
kubectl get crd | wc -l
```
