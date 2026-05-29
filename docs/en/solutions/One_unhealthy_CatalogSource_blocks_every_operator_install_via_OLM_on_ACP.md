---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500472
---

# One unhealthy CatalogSource blocks every operator install via OLM on ACP

## Issue

On Alauda Container Platform (`marketplace` chart `v4.3.7`, `catalog-operator` image `registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.1`), the OLM control plane runs in the `cpaas-system` namespace and the `catalog-operator` reconciles `CatalogSource` objects there. When any single `CatalogSource` visible to the resolver becomes unhealthy, every pending `Subscription` whose resolution touches that namespace stops progressing to install even when the package it requests lives in an unrelated, healthy catalog.

When the `catalog-operator` cannot reach a `CatalogSource`'s gRPC registry endpoint, its log may emit a line of the form `failed to populate resolver cache from source <name>/<namespace>: ...` followed by an `rpc error` variant; on this build (`registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.1`) the underlying emitter is the upstream `operator-framework/olm` binary, which surfaces either `code = Unavailable desc = connection error: ... connect: connection refused` (when the dial is rejected) or `code = DeadlineExceeded desc = context deadline exceeded` (when the dial times out) depending on the failure mode of the unhealthy source. While this condition persists, the affected `Subscription` resources record a `status.conditions` entry of `type=CatalogSourcesUnhealthy` and the per-source `status.catalogHealth[]` array carries a `healthy: false` entry for the failing catalog; OLM will not commit the operator install changes until the unhealthy catalog is removed or its endpoint becomes reachable again.

## Root Cause

The OLM dependency resolver consults every `CatalogSource` visible in the namespaces it considers for a given `Subscription`, independently of whether that `Subscription` declares an explicit dependency on a package in that catalog. If any one of those visible `CatalogSource` objects returns an error when the resolver lists its bundles, the resolver aborts the whole resolution for the `Subscription` rather than proceeding with the catalogs that did respond.

This abort-on-error behavior is by design: with an incomplete view of available bundles, the resolver could otherwise pick a wrong install candidate, so it stops until the catalog set is consistent again. As a result, the `status.conditions[type=CatalogSourcesUnhealthy]` entry on each affected `Subscription` stays present and no further install plan is committed until the unhealthy `CatalogSource` is removed or its registry becomes reachable again.

## Resolution

Restore catalog health so that the resolver's view becomes consistent and pending `Subscription` resolution can complete. There are two paths.

**Option A — fix the unhealthy `CatalogSource` in place.** Repair the connectivity or health issue on the failing source so its gRPC service answers on `<address>:50051` again. Once the resolver can list bundles from it, the blocked dependency resolution clears on the next reconcile and the pending `Subscription` proceeds to install:

```bash
kubectl -n cpaas-system get catalogsource
kubectl -n cpaas-system get catalogsource <name> -o yaml
```

**Option B — delete the unhealthy `CatalogSource`.** Remove the broken `CatalogSource` resource so that it is no longer visible to the resolver. Once the source is gone from the listed set, the resolver no longer aborts on its error and pending `Subscription` objects whose desired package is available from a healthy catalog complete resolution:

```bash
kubectl -n cpaas-system delete catalogsource <name>
```

The three default platform `CatalogSource` resources on ACP (`platform`, `system`, `custom` in `cpaas-system`) use `sourceType: grpc` with `spec.address=olm-registry-<lib>.cpaas-system.svc:50051`. The registry pods backing those addresses (`olm-registry-{platform,system,custom}` Deployments in `cpaas-system`) are long-running and are provisioned by the `marketplace` chart rather than bootstrapped by the `catalog-operator` from a `spec.image` on the `CatalogSource`; the failure mode in this article applies to user-created `CatalogSource` resources of `sourceType: grpc` with `spec.image` that the `catalog-operator` manages directly. No ACP-level aggregate disable toggle equivalent to an upstream `OperatorHub` reconciler exists, but deleting a default `CatalogSource` may be reconciled back on a subsequent run of the `marketplace` chart's helm reconciler — safer to scope Option B to user-created `CatalogSource` resources, and to delete them in the namespace where they were created.

## Diagnostic Steps

Tail the `catalog-operator` pod logs to surface both which `CatalogSource` is unreachable and the `failed to populate resolver cache` error string that explains why an otherwise valid `Subscription` is not progressing to install:

```bash
kubectl -n cpaas-system get pods -l app=catalog-operator
kubectl -n cpaas-system logs deploy/catalog-operator
```

Inspect the pending `Subscription` resource and read its `status.conditions` and `status.catalogHealth[]` to identify exactly which `CatalogSource` the resolver considers unhealthy; the `type=CatalogSourcesUnhealthy` condition and the per-source `healthy: false` entry in `status.catalogHealth[]` directly name the failing catalog and the time it was last evaluated:

```bash
kubectl -n <subscription-namespace> get subscription <name> -o yaml
```

A representative healthy entry looks like the following; an unhealthy catalog flips the same entry to `healthy: false` and the `CatalogSourcesUnhealthy` condition reports `status: True` with a non-`AllCatalogSourcesHealthy` reason:

```yaml
status:
  catalogHealth:
  - catalogSourceRef:
      name: <catalog-name>
      namespace: cpaas-system
    healthy: true
    lastUpdated: "2026-05-13T05:47:51Z"
  conditions:
  - type: CatalogSourcesUnhealthy
    status: "False"
    reason: AllCatalogSourcesHealthy
```

Cross-reference the catalog named by the `Subscription` condition with the entries in `kubectl -n cpaas-system get catalogsource` to locate the offending `CatalogSource`, then apply one of the Resolution options to clear the block.
