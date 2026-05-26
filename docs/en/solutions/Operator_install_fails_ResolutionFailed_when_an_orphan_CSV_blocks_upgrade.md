---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500152
---

# OLM resolver fails to install operator due to orphan CSV in install namespace

## Issue

On Alauda Container Platform v4.3.13 (Kubernetes v1.34.5), installing or upgrading an operator backed by the OLM v0 stack can fail with the resolver emitting a `Warning` event of reason `ResolutionFailed` and a message starting `constraints not satisfiable`, naming the package, channel, catalog, and `ClusterServiceVersion` (CSV) involved. The CSV CRD `clusterserviceversions.operators.coreos.com` is shipped on this cluster with the same `status.phase` enum and `status.conditions[]` history as the upstream OLM v0 form; the `catalog-operator`, `olm-operator`, and `packageserver` Deployments that drive this reconciliation run in the `cpaas-system` namespace.

One specific shape of that resolver error appears when a CSV for the package already exists in the install namespace but no `Subscription` references it via `status.installedCSV` — an orphan CSV. The resolver then conflicts between the catalog's required CSV and the `@existing/<ns>//<csv>` entry that originates from the same package, and cannot satisfy the constraint set.

## Root Cause

The Subscription is the ownership link to the CSV through `status.installedCSV`; when that link is missing or stale, the affected CSV is treated as orphan inventory in the install namespace. On a healthy install, every namespace that runs an operator carries a matching `Subscription` whose `spec.name` is the package and whose `status.installedCSV` names the current CSV. A CSV can also sit in `status.phase=Pending` when the `olm-operator` reconciliation loop has not progressed it to `InstallReady` or `Installing`; the same value is recorded as a row in `status.conditions[]` with `phase=Pending` and a `reason` such as `NeedsReinstall`.

## Resolution

Ensure the affected operator is completely uninstalled by removing every `Subscription`, `ClusterServiceVersion`, and `InstallPlan` for the package in the install namespace before attempting a reinstall. The three resources are co-located in the install namespace on this cluster and can be removed together. The reliable form lists then deletes each resource by name:

```bash
kubectl get subscription,csv,installplan -n <install-namespace>
kubectl delete subscription <name> -n <install-namespace>
kubectl delete csv <csv-name> -n <install-namespace>
kubectl delete installplan <ip-name> -n <install-namespace>
```

When the upstream OLM installation label `operators.coreos.com/<package>.<install-namespace>=` is present on the three resources, a single label-scoped delete works as well:

```bash
kubectl delete subscription,csv,installplan -n <install-namespace> \
  -l operators.coreos.com/<package>.<install-namespace>=
```

After the install namespace is clean, reinstalling the operator via the CLI or Web Console succeeds: the new `Subscription` adopts the freshly resolved CSV, `status.installedCSV` matches `status.currentCSV`, and the Subscription's `status.conditions` report `CatalogSourcesUnhealthy=False` with reason `AllCatalogSourcesHealthy` and no `ResolutionFailed` condition.

## Diagnostic Steps

Identify whether a CSV is orphan by listing `Subscriptions` and `CSVs` in the install namespace and cross-checking the ownership link:

```bash
kubectl get subscription -n <install-namespace> \
  -o custom-columns=NAME:.metadata.name,PKG:.spec.name,INSTALLED:.status.installedCSV
kubectl get csv -n <install-namespace>
```

Any CSV present in the namespace that does not appear as `status.installedCSV` on a Subscription in the same namespace is orphan with respect to the resolver.

Inspect the CSV phase and the most recent condition entries to confirm the reconciliation has stalled:

```bash
kubectl get csv -n <install-namespace> <csv-name> \
  -o jsonpath='{.status.phase}{"\n"}'
kubectl get csv -n <install-namespace> <csv-name> \
  -o jsonpath='{range .status.conditions[*]}{.phase}{"\t"}{.reason}{"\t"}{.lastTransitionTime}{"\n"}{end}'
```

A row of `Pending NeedsReinstall` (or `Pending RequirementsUnknown`) at the latest timestamp indicates the CSV is not advancing through the `Pending` → `InstallReady` → `Installing` cycle. After the cleanup and reinstall, the Subscription's `status.installedCSV` should equal its `status.currentCSV`, and its `status.conditions` should show `CatalogSourcesUnhealthy=False` reason `AllCatalogSourcesHealthy` with no `ResolutionFailed` condition — observed on ACP v4.3.13 against `konveyor-operator.v0.6.0-beta.1` in the `konveyor-tackle` namespace.
