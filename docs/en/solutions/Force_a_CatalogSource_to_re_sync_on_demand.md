---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Force a CatalogSource to re-sync on demand
## Issue

A `CatalogSource` is configured with a long polling interval (or no polling at all), so newly published bundles in the underlying index image do not become visible to the cluster until the next scheduled refresh. Operations needs a way to force the catalog to pick up the latest contents immediately — for example after pushing a new bundle to an in-house index, or after rotating credentials for a private registry.

## Root Cause

ACP's extension framework relies on OLM-style `CatalogSource` objects (see `extend` capability area). Each `CatalogSource` is backed by a registry pod (`grpc` server) created by the catalog operator. The pod's index image is downloaded and indexed only at startup. When `spec.updateStrategy.registryPoll.interval` is set, the catalog operator periodically restarts the pod so the new image digest is pulled. Between polls — or when polling is disabled — the in-memory index is frozen and changes pushed to the index image are invisible to the resolver.

Deleting the registry pod is therefore equivalent to triggering an immediate refresh: the catalog operator recreates it, the new pod re-pulls the index image, and `PackageManifests` are re-published.

## Resolution

Identify the namespace where the `CatalogSource` lives and delete its serving pod. The catalog operator immediately recreates a fresh pod, which re-loads the latest index image content.

```bash
# Replace <catalog-name> and <ns> with your CatalogSource name and namespace.
# In the in-core extend area the default namespace is typically `cpaas-system`
# or a tenant-specific marketplace namespace.
kubectl -n <ns> delete pod -l olm.catalogSource=<catalog-name>
```

Once the new pod reports `Ready`, confirm the refresh took effect:

```bash
kubectl -n <ns> get catalogsource <catalog-name> \
  -o jsonpath='{.status.connectionState.lastObservedState}{"\n"}'

kubectl get packagemanifests \
  --field-selector metadata.namespace=<marketplace-ns> \
  -o custom-columns=NAME:.metadata.name,CATALOG:.status.catalogSource
```

The freshly recreated pod re-publishes every package shipped by the index, so any subscription whose `installPlanApproval` is `Automatic` will pick up newer bundles on the next reconcile.

### When to use this versus shortening the poll interval

- One-off refresh after a known catalog push → delete the pod (above).
- Recurrent need for fast updates → set `spec.updateStrategy.registryPoll.interval` (for example `15m`) on the `CatalogSource`. Avoid intervals shorter than a few minutes; each tick triggers a registry pod restart and a fresh image pull.

```yaml
apiVersion: operators.coreos.com/v1alpha1
kind: CatalogSource
metadata:
  name: <catalog-name>
  namespace: <ns>
spec:
  sourceType: grpc
  image: <registry>/<index-image>:<tag>
  updateStrategy:
    registryPoll:
      interval: 15m
```

## Diagnostic Steps

If the catalog still appears stale after the pod is recreated, walk the chain end-to-end:

```bash
# 1. Confirm the registry pod was actually recreated and is Running.
kubectl -n <ns> get pod -l olm.catalogSource=<catalog-name> \
  -o wide --sort-by=.metadata.creationTimestamp

# 2. Check whether the catalog operator marked the source READY.
kubectl -n <ns> get catalogsource <catalog-name> -o yaml | \
  grep -E 'lastObservedState|message' -A1

# 3. Re-pull errors point to a registry-credential or image-digest problem.
kubectl -n <ns> describe pod -l olm.catalogSource=<catalog-name>

# 4. Inspect the served packages directly via the in-cluster gRPC endpoint
#    (only when familiar with grpcurl):
kubectl -n <ns> port-forward svc/<catalog-name> 50051:50051
grpcurl -plaintext localhost:50051 api.Registry/ListPackages | head
```

A pod stuck in `ImagePullBackOff` indicates the underlying index image cannot be resolved — verify the image tag/digest, network reachability, and any pull secrets referenced by the `CatalogSource` namespace.
