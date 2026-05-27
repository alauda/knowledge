---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500182
---

# Recovering an OLM Subscription stuck on listing bundles on ACP

## Issue

On Alauda Container Platform (Kubernetes server `v1.34.5`, OLM image `registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.1` in the `cpaas-system` namespace), an operator install driven by a `Subscription` (`subscriptions.operators.coreos.com`) can become visibly stuck because the OLM `catalog-operator` was unable to enumerate bundles from the backing `CatalogSource` within the gRPC deadline. When that happens, the catalog-operator records the failure on the affected Subscription's `.status.conditions[]`, with a message of the form `error using catalogsource <ns>/<name>: error encountered while listing bundles: rpc error: code = DeadlineExceeded desc = context deadline exceeded`.

## Diagnostic Steps

The primary signal lives on the Subscription itself. Read its conditions array directly with `kubectl` — each entry is an upstream-OLM `SubscriptionCondition` (`lastTransitionTime`, `message`, `reason`, `status`, `type`) and carries the catalog-listing or resolution error verbatim:

```bash
kubectl get sub <name> -n <ns> -o jsonpath='{.status.conditions}'
# or, for easier reading:
kubectl get sub <name> -n <ns> -o json | jq .status.conditions
```

Corroborate the Subscription condition with the controller-side view by tailing the `catalog-operator` Pod logs in `cpaas-system`. The pod is a single-replica Deployment selected by `app=catalog-operator` and ships the upstream operator-framework logger, so the same `DeadlineExceeded` line surfaces there together with the `catalogsource.name` / `catalogsource.namespace` it was dialing:

```bash
kubectl get pod -n cpaas-system -l app=catalog-operator
kubectl logs -n cpaas-system -l app=catalog-operator --tail=200
```

## Resolution

Pick the least invasive remediation that clears the stuck state and re-runs Subscription resolution. The four options below are ordered from rotating just the catalog registry-server through rotating the controller, patching the Subscription status, and re-creating the Subscription; stop as soon as the Subscription's `.status.conditions[]` reflects a fresh, healthy resolution.

First, restart the registry-server backing the affected `CatalogSource`. On ACP each CatalogSource is `sourceType: grpc` with a `.spec.address` of `olm-registry-<lib>.cpaas-system.svc:50051`, served by a Deployment named `olm-registry-<lib>` in `cpaas-system`; rolling that Deployment brings up a fresh registry pod so the next `ListBundles` call from the catalog-operator is served cleanly:

```bash
kubectl rollout restart deploy/olm-registry-<lib> -n cpaas-system
kubectl rollout status  deploy/olm-registry-<lib> -n cpaas-system
```

If the stuck condition persists after the registry-server is healthy, restart the OLM controller itself so it re-dials every CatalogSource and re-evaluates Subscription resolution from scratch:

```bash
kubectl delete pod -l app=catalog-operator -n cpaas-system
kubectl get pod -n cpaas-system -l app=catalog-operator -w
```

When the catalog-operator is healthy but the Subscription still carries a stale `.status.conditions[]` entry, patch the conditions array off the status subresource directly. The kube-apiserver routes the JSON-patch through to the `/status` subresource so OLM writes a fresh resolution outcome on its next reconcile:

```bash
kubectl patch sub <name> -n <ns> \
  --subresource=status \
  --type json \
  -p '[{"op":"remove","path":"/status/conditions"}]'
```

As a last resort, uninstall and re-install the operator: delete the failed `Subscription` and its `ClusterServiceVersion`, then re-create the Subscription with `kubectl apply` against the now-healthy `CatalogSource`. The fresh Subscription resolves with an empty `.status.conditions` and progresses normally:

```bash
kubectl delete subscription <name> -n <ns>
kubectl delete csv <csv-name> -n <ns>
kubectl apply -f subscription.yaml
kubectl get sub <name> -n <ns> -o jsonpath='{.status.conditions}'
```
