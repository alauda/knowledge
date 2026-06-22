---
title: Recover an OLM operator stuck on ResolutionFailed after a Subscription was deleted
component: extend
scenario: troubleshooting
tags: [olm, subscription, csv, catalogsource, operatorbundle, resolutionfailed]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Recover an OLM operator stuck on ResolutionFailed after a Subscription was deleted

## Issue

On Alauda Container Platform, OperatorBundles are managed by OLM (`registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.2`) running in the `cpaas-system` namespace. An operator's `Subscription` (`operators.coreos.com/v1alpha1`) produces an `InstallPlan` whose `ownerReferences[0]` points back at the Subscription, and that InstallPlan creates the `ClusterServiceVersion` (CSV) for the named operator version — so the CSV is indirectly owned by the Subscription via the InstallPlan [ev:c1]. If the Subscription is deleted (or recreated against a different operator version) without first deleting the CSV, the CSV remains in the namespace with no Subscription pointing at it and OLM marks it orphaned with the message `clusterserviceversion <name> exists and is not referenced by a subscription` [ev:c1_b].

While the CSV is orphaned, the OLM catalog-operator running in `cpaas-system` cannot resolve a fresh install path and emits repeated `Warning` events on the namespace with `reason: ResolutionFailed`, including a `constraints not satisfiable` message naming the orphaned CSV. The events are surfaced both by `kubectl describe subscription <name> -n <ns>` and in the catalog-operator log (`kubectl -n cpaas-system logs deploy/catalog-operator`); the same log line format (`level=info msg=...`) is shared with upstream OLM because ACP uses the same binary [ev:c2_a].

## Root Cause

The Subscription and the CSV are linked through an InstallPlan: the Subscription is the owner of an InstallPlan whose `spec.clusterServiceVersionNames` lists the target CSV, and OLM's reconciler treats a CSV with no owning Subscription as an orphan that blocks further upgrades on that operator [ev:c1]. Deleting only the Subscription (for example to clean up a misconfigured install or switch channels) breaks the chain — the orphaned CSV persists, OLM refuses to install a new CSV that would conflict with the orphan, and the namespace's Subscription enters a permanent `ResolutionFailed` state [ev:c1_b][ev:c2_a].

## Resolution

Recovery clears the orphan and re-establishes Subscription ownership of the CSV. Because each operator's CSV is created by an InstallPlan that lists it in `spec.clusterServiceVersionNames` and is owned by the Subscription that produced the InstallPlan, removing both the Subscription and the named CSV in the namespace puts OLM back in a state where a freshly-created Subscription generates a new InstallPlan and a new CSV ownership chain for the same operator version [ev:c1]. The recovery sequence is the same regardless of whether the operator was installed in its own namespace (`OwnNamespace` mode) or globally — on ACP the global install namespace is `operators` (with the `global-operators` OperatorGroup), and `AllNamespaces`-mode bundles keep their master CSV in the namespace where the Subscription and OperatorGroup live [ev:c5_a]. Because ACP enables OLM's `disableCopiedCSVs: true` feature (`kubectl get olmconfig cluster -o jsonpath='{.spec.features.disableCopiedCSVs}'` returns `true`), there are no `reason=Copied` CSV objects in other namespaces to chase down — the master CSV in the install namespace is the only CSV to delete [ev:c5_a].

Save the current Subscription manifest before deleting it so it can be re-applied unchanged where possible:

```bash
NS=<operator-install-namespace>
SUB=<subscription-name>
kubectl get subscription "$SUB" -n "$NS" -o yaml > /tmp/${SUB}-backup.yaml
kubectl get csv -n "$NS"
```

Delete the Subscription and the named CSV [ev:c1_b]:

```bash
kubectl delete subscription "$SUB" -n "$NS"
kubectl delete csv <csv-name> -n "$NS"
kubectl get subscription -n "$NS"
kubectl get csv -n "$NS"
```

Before re-applying the saved manifest, edit `/tmp/${SUB}-backup.yaml` to remove the `status:` section and the `metadata.creationTimestamp` field — both are populated by the API server and rejected on create [ev:c4_a]. If `spec.startingCSV` is set in the backup and the value matches the CSV named in the `ResolutionFailed` event, clear `spec.startingCSV` as well — leaving it in causes OLM to attempt to resolve the same problematic CSV again [ev:c4_b]. The Subscription CRD defines `spec.startingCSV` as a plain string field in the v1alpha1 schema, so removing or editing it is a straightforward YAML edit [ev:c7].

Re-create the Subscription:

```bash
kubectl create -f /tmp/${SUB}-backup.yaml -n "$NS"
```

When the goal is to restore the operator at the version that was previously installed (rather than to upgrade), set `spec.startingCSV` in the recreated manifest to that exact CSV name. Pinning the starting CSV avoids an unintended upgrade through a channel head that may ship CRD or CR shape changes the existing in-cluster resources cannot satisfy [ev:c7].

After the Subscription is re-created, OLM's catalog-operator and olm-operator (both Deployments in `cpaas-system` with the labels `app=catalog-operator` and `app=olm-operator`) need a short reconcile window to generate a new InstallPlan and re-bind it to the existing operator workload [ev:c6_a]. If reconciliation appears stuck, force a fresh reconcile by deleting the controller pods so their Deployments reschedule them [ev:c6_b]:

```bash
kubectl -n cpaas-system delete pod -l 'app in (catalog-operator,olm-operator)'
```

## Diagnostic Steps

Confirm the orphaned-CSV signature before applying the recovery. Listing the namespace's Subscription and CSV inventory tells whether the symptom matches: a Subscription present, a CSV present, but no recent InstallPlan tying them together is the classic shape [ev:c1].

```bash
NS=<operator-install-namespace>
kubectl get subscription -n "$NS"
kubectl get csv -n "$NS"
kubectl get installplan -n "$NS"
```

Verify the CatalogSource the Subscription points at actually exists. On ACP the standard CatalogSources are `platform`, `system`, and `custom`, all in `cpaas-system`; a Subscription targets one of them through `spec.source` and `spec.sourceNamespace: cpaas-system` (vs `spec.startingCSV` which is an optional pin on the desired CSV name) [ev:c4_a].

```bash
kubectl get subscription "$SUB" -n "$NS" -o yaml | grep -A1 'source\|sourceNamespace\|startingCSV'
kubectl get catalogsource -n cpaas-system
```

Read the `ResolutionFailed` events directly off the catalog-operator log to confirm which CSV is named as the orphan — the line referencing `clusterserviceversion <name> exists and is not referenced by a subscription` is the one to clear in the resolution above [ev:c2_a].

```bash
kubectl -n cpaas-system logs deploy/catalog-operator --tail=200 \
 | grep -E 'ResolutionFailed|constraints not satisfiable|exists and is not referenced'
kubectl get events -n "$NS" --field-selector reason=ResolutionFailed
```

For globally-scoped operators, confirm whether the install was `AllNamespaces`-mode by reading the OperatorGroup's `status.namespaces`: an entry of `[""]` indicates AllNamespaces and locates the master CSV in the same namespace as the OperatorGroup (e.g. `operators` for the global `global-operators` group). Because ACP runs OLM with `disableCopiedCSVs: true`, no copies of that CSV exist in other namespaces — only the master CSV needs to be deleted in the recovery sequence [ev:c5_a].

```bash
kubectl get operatorgroup -A \
 -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} status.namespaces={.status.namespaces}{"\n"}{end}'
kubectl get olmconfig cluster -o jsonpath='{.spec.features.disableCopiedCSVs}'
```
