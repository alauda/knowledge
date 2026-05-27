---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500219
---

# Diagnosing garbage collector sync failures in kube-controller-manager

## Issue

On Alauda Container Platform (Kubernetes v1.34.5, `kube-controller-manager` static pod image `registry.alauda.cn:60080/tkestack/kube-controller-manager:v1.34.5` in the `kube-system` namespace), the garbage-collector controller inside `kube-controller-manager` can fail to finish syncing its dependency-graph builder after the controllers start. When this happens the controller — running under `logger="garbage-collector-controller"` — emits `Starting controller` at `garbagecollector.go:144`, `Garbage collector: not all resource monitors could be synced, proceeding anyways` at `garbagecollector.go:152`, `Proceeding to collect garbage` at `garbagecollector.go:157`, and an `Unhandled Error` at `garbagecollector.go:237` whose `err=` is the literal `timed out waiting for dependency graph builder sync during GC sync`.

## Root Cause

The garbage-collector controller builds a dependency graph by walking every GroupVersionResource it can discover through the cluster's API discovery loop and starting an informer monitor for each one. When a CustomResourceDefinition's GroupVersion is stale, its conversion webhook fails, or it otherwise cannot be reached through the discovery API, the corresponding monitor never completes and the dependency-graph builder times out — the failing-API-discovery branch of the upstream cause family that classically prevents the controller from reaching one of the watched resources. On this cluster the controller logs the failure together with the specific GroupVersion that did not respond: the `failed to discover some groups` line at `garbagecollector.go:787` names a stale `app.alauda.io/v1alpha2` GroupVersion in its `groups=` map. The same root cause also surfaces when an owner reference points at a GroupVersionKind whose CRD has been removed: the controller emits a per-item `error syncing item` at `garbagecollector.go:358` with `err="unable to get REST mapping for <gvk>."` and an `item="[<gvk>, namespace: <ns>, name: <name>, uid: <uid>]"` field that names both the offending GVK and the orphan object.

## Resolution

Identify the offending CRD directly from the controller log: the GroupVersion is named in the `groups=` map of the `failed to discover some groups` line, and the GroupVersionKind plus the offending namespace, name, and uid are named in the `error syncing item ... unable to get REST mapping for <gvk>` line, so the controller already points at the resource that needs remediation.

With the CRD identified, fix or disable its conversion webhook so the GroupVersion responds to discovery again, or — when the CRD is no longer in use — back up and delete it together with any orphan owner references that reach it. Once the offending resource is reachable through discovery again, the dependency-graph builder finishes syncing and the garbage-collector resumes work; because the `kube-controller-manager` pod stays healthy through the failure (`phase=Running ready=true`), no static-pod restart is required after the CRD is remediated:

```bash
kubectl get crd <name>.<group> -o yaml > <name>.<group>.yaml
kubectl delete crd <name>.<group>
```

## Diagnostic Steps

Read the `kube-controller-manager` static-pod log in `kube-system` and filter for the garbage-collector emitter so the dependency-graph timeout and the failed-discovery payload are co-located:

```bash
kubectl logs kube-controller-manager-<node> -n kube-system \
  | grep -E 'garbagecollector\.go|graph_builder\.go'
```

The signal sequence to look for, all logged by `logger="garbage-collector-controller"`:

```text
garbagecollector.go:144  "Starting controller"
garbagecollector.go:152  "Garbage collector: not all resource monitors could be synced, proceeding anyways"
garbagecollector.go:157  "Proceeding to collect garbage"
garbagecollector.go:237  "Unhandled Error" err="timed out waiting for dependency graph builder sync during GC sync"
garbagecollector.go:787  "failed to discover some groups" groups="map[\"<group>/<version>\":\"stale GroupVersion discovery: <group>/<version>\"]"
garbagecollector.go:358  "error syncing item" err="unable to get REST mapping for <group>/<version>/<kind>." item="[<gvk>, namespace: <ns>, name: <name>, uid: <uid>]"
```

Use the `groups=` map and the `item=` field together to name both the GroupVersion whose discovery failed and the orphan object whose owner reference points at a deleted CRD GVK; these are the two facets of the failing-API-discovery cause family the remediation needs to address. Confirm the controller pod itself is still healthy while the sync error is firing — the static pod in `kube-system` should report `phase=Running` and `ready=true`, which keeps the remediation focused on the offending CRD rather than the `kube-controller-manager` binary:

```bash
kubectl get pod -n kube-system -l component=kube-controller-manager \
  -o jsonpath='{range .items[*]}phase={.status.phase} restarts={.status.containerStatuses[0].restartCount} ready={.status.containerStatuses[0].ready}{"\n"}{end}'
```
