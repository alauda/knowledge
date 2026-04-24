---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The extend / installed-operators surface shows an operator with `Cannot update` and `CatalogSource was removed` (or `CatalogSource not found`), even though the named `CatalogSource` is present and serving fine. The catalog-operator pod logs in the OLM namespace report repeated `ResolutionFailed` warnings of the form:

```text
constraints not satisfiable: subscription <name> exists,
subscription <name> requires <catalog>/<catalog-ns>/<channel>/<csv-name>,
clusterserviceversion <csv-name> exists and is not referenced by a subscription,
... and @existing/<install-ns>//<csv-name> provide <CRD>
```

Other phrasings of the same root pattern appear with multi-version conflicts such as `@existing/<install-ns>//<csv>.v1.4.2 and ...//.v1.4.3 provide <Service> ...`. The Subscription, CSV, and CatalogSource are all present individually, yet the resolver cannot pick a satisfying solution and refuses to upgrade.

A separate but related question that comes up at the same time: when the operator was installed in **All Namespaces** mode, OLM creates a *master* CSV in the install namespace plus *copied* CSVs in every watched namespace. Which set should be deleted to recover?

## Root Cause

OLM treats the cluster's existing CSVs as part of the input set the resolver must satisfy. When a Subscription disappears (deletion, namespace recreation, GitOps reconcile, etc.) but the CSV it was managing remains, the CSV is *orphaned*: still in the cluster, no longer owned by any Subscription. Re-creating the Subscription a moment later does not re-bind it; the resolver now sees both:

- the new Subscription, asking for the CSV from a catalog channel; and
- the orphaned CSV, sitting in the namespace under `@existing/...`, providing the same CRD/API.

Two independent supplies of the same API satisfy nothing — the resolver flags the result as `constraints not satisfiable` and reports it as `CatalogSource was removed`, which is misleading. The catalog is fine; the in-cluster state has two providers for the same API and OLM cannot choose.

The same situation arises when the user pinned a `startingCSV` in the recreated Subscription that also matches the orphaned CSV; the resolver still cannot reconcile two providers.

## Resolution

The repair is mechanically simple: drop the orphaned CSV *and* the (recreated) Subscription, wait for OLM to garbage-collect, then re-create the Subscription cleanly. The order matters — leaving either side behind reproduces the same wedge.

### 1. Back up the Subscription before deleting

The Subscription holds the channel, install-plan policy, and any `startingCSV` that need to be preserved. Save it to disk so the recreate step is mechanical.

```bash
NS=<operator-ns>
SUB=<subscription-name>
kubectl -n $NS get subscription $SUB -o yaml > subscription_backup.yaml
```

Edit the backup before re-applying:

- Remove the entire `status` block.
- Remove `metadata.creationTimestamp`, `metadata.uid`, `metadata.resourceVersion`, and `metadata.generation`.
- If `spec.startingCSV` is set and its value is the same CSV that the resolver is complaining about, **delete `spec.startingCSV` from the backup**. Pinning the orphaned version reproduces the conflict on the next reconcile.

### 2. Delete the Subscription and the orphaned CSV

Delete both objects, in either order, and wait for both to disappear before recreating anything.

```bash
NS=<operator-ns>
SUB=<subscription-name>
CSV=<csv-name>          # e.g. jaeger-operator.v1.28.0

kubectl -n $NS delete subscription $SUB
kubectl -n $NS delete csv $CSV

# wait for both to be gone
kubectl -n $NS get subscription
kubectl -n $NS get csv
```

For an **All-Namespaces** install, only the *master* CSV (in the namespace where the operator was actually installed) needs to be deleted. The copied CSVs in tenant namespaces are managed by OLM and will be cleaned up automatically once the master is removed.

```bash
# The "master" CSV always lives in the install namespace.
# Copied CSVs in other namespaces are owned by OLM and will follow.
kubectl get csv -A | grep $CSV
```

### 3. Re-create the Subscription at the desired version

Apply the cleaned backup. Pin `startingCSV` to the exact version that was running before so an automatic upgrade does not silently jump to a newer CRD schema mid-recovery.

```bash
kubectl apply -f subscription_backup.yaml -n $NS
```

OLM resolves the new Subscription, generates a fresh InstallPlan, and re-creates the CSV. Confirm the resolution succeeded:

```bash
kubectl -n $NS get sub $SUB \
  -o jsonpath='{.status.conditions}' | jq .
kubectl -n $NS get csv
```

### 4. Recycle the OLM pods if reconciliation is sluggish

OLM caches the resolver state in-memory; after a recovery, deleting the catalog-operator and olm-operator pods forces a clean read. Do this only when the recreated Subscription is sitting in `UpgradePending` for more than a few minutes.

```bash
LM_NS=<olm-namespace>          # platform OLM namespace
kubectl -n $LM_NS delete pods -l 'app in (catalog-operator, olm-operator)'
```

### 5. Avoid recreating the wedge

Two operational habits keep this from recurring:

- When deleting a Subscription as part of a clean-up, delete the matching CSV in the same step. Never leave the CSV behind under the assumption that the next Subscription will adopt it — it will not.
- When recreating a Subscription via GitOps, declare the CSV as a managed resource as well, so a Subscription resync also resyncs the CSV side.

## Diagnostic Steps

Confirm the Subscription, CSV, and CatalogSource all exist before assuming the catalog is missing:

```bash
NS=<operator-ns>
kubectl -n $NS get sub
kubectl -n $NS get csv
kubectl -n $NS get sub <name> \
  -o jsonpath='{.spec.source}{" "}{.spec.sourceNamespace}{"\n"}'

# Then check the catalog actually exists where the Subscription points:
kubectl -n <catalog-ns> get catalogsource
```

Pull the resolver decision out of the catalog-operator log — it prints a precise reason for each `ResolutionFailed`:

```bash
LM_NS=<olm-namespace>
kubectl -n $LM_NS get pods
kubectl -n $LM_NS logs deploy/catalog-operator --tail=300 \
  | grep -E 'ResolutionFailed|constraints not satisfiable'
```

Look for the giveaway in the message:

```text
... clusterserviceversion <name>.v<x.y.z> exists and is not referenced by a subscription
```

That phrase confirms the CSV is orphaned; once cleaned up, the Subscription resolves on the next reconcile.

If multiple operators show the same condition simultaneously, check whether something cluster-wide deleted the Subscriptions (e.g. a GitOps prune that did not also prune CSVs). The fix is identical per-operator, but the *cause* should be addressed at the GitOps source.
