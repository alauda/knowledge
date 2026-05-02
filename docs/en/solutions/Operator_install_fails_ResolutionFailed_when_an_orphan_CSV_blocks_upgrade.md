---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Operator install fails ResolutionFailed when an orphan CSV blocks upgrade
## Issue

Installing or upgrading an operator through the marketplace fails. The Subscription event log carries a `ResolutionFailed` warning whose body contains the phrase `clusterserviceversion <name> exists and is not referenced by a subscription`. A representative warning:

```text
Event(v1.ObjectReference{Kind:"Namespace", Name:"operators", ...}):
  type: 'Warning' reason: 'ResolutionFailed'
  constraints not satisfiable:
    subscription example-operator exists,
    subscription example-operator requires
      community-catalog/cpaas-marketplace/stable/example-operator.v1.5.8,
    community-catalog/cpaas-marketplace/stable/example-operator.v1.5.8
      and @existing/operators//example-operator.v1.5.6-0.1664915551.p
      originate from package example-operator,
    clusterserviceversion example-operator.v1.5.6-0.1664915551.p exists
      and is not referenced by a subscription
```

The Subscription is asking for one CSV version (`v1.5.8`) but a different CSV (`v1.5.6-0.<timestamp>.p`) is already on the cluster, owned by nothing — the constraint resolver finds two manifests for the same package that did not come from the same Subscription, and refuses to pick one.

The same shape can repeat after a partial uninstall, after a restored backup, or after an interrupted upgrade left the previous CSV in place when the Subscription was already pointing at the new channel.

## Root Cause

The OLM constraint resolver re-runs every Subscription resolution from a fresh view of the cluster. For each operator package it considers two sources:

1. **The Subscription's preferred channel** — what the user says they want (`stable/example-operator.v1.5.8`).
2. **`@existing/<namespace>//<csv-name>`** — every CSV the resolver discovers in the install namespace, regardless of who created it.

If the `@existing` set contains a CSV from the same package but **with no owning Subscription**, the resolver flags it as ambiguous: two packaged versions of the same operator can't coexist in the install namespace, and there is no Subscription that the resolver can roll forward to clean up the orphan.

Common ways to end up with such an orphan CSV:

- A previous Subscription was deleted but the CSV it owned was not. (Subscription deletion doesn't cascade to the CSV by default.)
- A backup was restored that included the CSV but not the Subscription.
- An interrupted upgrade rolled the new CSV in but did not garbage-collect the previous CSV; the Subscription was then deleted before the cleanup completed.
- Two namespaces accidentally have the same package: a Subscription in `operators` and a stranded CSV from a removed namespace's OperatorGroup that targeted the same install namespace.

## Resolution

Fix the cluster state so exactly one CSV per package remains, owned by the right Subscription. The order matters — clear orphans before reinstating the Subscription.

### Step 1 — identify the orphan CSV

```bash
NS=operators
PKG=example-operator

kubectl -n "$NS" get csv \
  -o custom-columns=NAME:.metadata.name,VERSION:.spec.version,OWNER:.metadata.ownerReferences[0].name
```

Any CSV whose `OWNER` column is empty (or refers to a Subscription that no longer exists) is an orphan candidate. Cross-reference with active Subscriptions:

```bash
kubectl -n "$NS" get subscription \
  -o custom-columns=NAME:.metadata.name,PACKAGE:.spec.name,CHANNEL:.spec.channel,CURRENT_CSV:.status.currentCSV
```

The orphan is any CSV for `$PKG` that is not the `CURRENT_CSV` of any Subscription.

### Step 2 — remove the orphan CSV (only the orphan)

CSV deletion **does not** affect the operator's running pods or the CRs the operator manages — those live in their own namespaces and are owned by the CSV via OwnerReferences only when the CSV is in `Succeeded`. An orphan CSV that the resolver is rejecting is rarely also the one running pods; double-check before deleting:

```bash
ORPHAN=example-operator.v1.5.6-0.1664915551.p

# What does the orphan own? Verify nothing critical depends on it.
kubectl -n "$NS" get csv "$ORPHAN" -o yaml \
  | yq '.metadata.uid'
ORPHAN_UID=$(kubectl -n "$NS" get csv "$ORPHAN" -o jsonpath='{.metadata.uid}')

kubectl get all -A \
  -o custom-columns=NS:.metadata.namespace,KIND:.kind,NAME:.metadata.name,OWNERS:.metadata.ownerReferences[*].uid \
  | grep -F "$ORPHAN_UID" || echo "no resources currently owned by orphan CSV"
```

If the orphan owns no live resources, delete it:

```bash
kubectl -n "$NS" delete csv "$ORPHAN"
```

If the orphan does own live resources (i.e. it actually is the running operator and the active Subscription got deleted), the cleanup is the inverse: delete the Subscription pointing at the wrong version, recreate the Subscription against the channel that matches the running CSV, then upgrade.

### Step 3 — flush the OLM controller caches

The OLM controllers cache resolved bundle metadata per package. After removing the orphan, the cache may still hold the stale resolution result and re-emit `ResolutionFailed`. Restart the catalog and lifecycle controllers so they re-resolve from clean state:

```bash
OLM_NS=cpaas-system            # whichever namespace runs OLM
kubectl -n "$OLM_NS" delete pod -l app=catalog-operator
kubectl -n "$OLM_NS" delete pod -l app=olm-operator
```

The controllers come back within seconds; new pods rebuild their caches from the live cluster state.

### Step 4 — re-trigger resolution

Touch the Subscription so the controller re-evaluates it. A trivial annotation change suffices:

```bash
kubectl -n "$NS" annotate subscription "$PKG" \
  cpaas.io/force-reresolve="$(date +%s)" --overwrite
```

Watch the Subscription's `status.state` and the InstallPlan it produces:

```bash
kubectl -n "$NS" get subscription "$PKG" -o yaml \
  | yq '.status | {state, installPlanRef, currentCSV, conditions}'

kubectl -n "$NS" get installplan -w
```

A healthy resolution flips through `UpgradePending` → `Installing` → `Complete`. If `ResolutionFailed` returns with the same orphan CSV name, that CSV was recreated by another controller — find what is reapplying it (a GitOps source, a backup-restore controller, a CR with `installPlanApproval: Automatic` re-creating the wrong version) and stop it before retrying.

### Step 5 — last resort: full reinstall

If the operator is stuck and step 4 still fails, remove every OLM artefact for the package and reinstall it. The data plane (operator-managed CRs and their workloads) survives — only the controller and its bookkeeping are reset.

```bash
# Backup first
kubectl -n "$NS" get subscription "$PKG"     -o yaml > "${PKG}-sub.yaml"
kubectl -n "$NS" get csv -l operators.coreos.com/${PKG}.${NS}=        -o yaml > "${PKG}-csvs.yaml"
kubectl -n "$NS" get installplan                                       -o yaml > "${PKG}-ips.yaml"

# Delete the OLM artefacts
kubectl -n "$NS" delete subscription "$PKG"
kubectl -n "$NS" get csv -l operators.coreos.com/${PKG}.${NS}= -o name | xargs -r kubectl -n "$NS" delete

# Restart OLM controllers (Step 3)

# Reapply the Subscription pointed at the desired channel
kubectl apply -f "${PKG}-sub.yaml"
```

The operator pods come back, re-adopt the existing CRs, and the Subscription resolves cleanly because no orphan CSV remains.

## Diagnostic Steps

To confirm OLM resolution is the failure path (not a CRD conflict, not a webhook denying the install), inspect the Subscription's conditions:

```bash
kubectl -n "$NS" get subscription "$PKG" -o yaml \
  | yq '.status.conditions[] | {type,reason,message}'
```

A `ResolutionFailed` condition with `constraints not satisfiable` is the OLM resolver. Other failure modes (missing CRD, conflicting webhook) carry different reasons.

For the full trace of what the resolver considered and why:

```bash
kubectl -n "$OLM_NS" logs deploy/catalog-operator --tail=500 \
  | grep -E "$PKG|resolution|@existing"
```

The log lines `@existing/<namespace>//<csv>` enumerate every CSV the resolver pulled into its world view. Anything in that list with no matching Subscription is the orphan.

To enumerate all CSVs cluster-wide for the troublesome package and spot mis-namespaced copies:

```bash
kubectl get csv -A | grep -F "$PKG"
```

A CSV in a namespace other than `$NS` for a non-cluster-scoped operator points at a stale OperatorGroup whose `targetNamespaces` once included `$NS`. Remove the stale OperatorGroup, then return to Step 4.

If the constraint solver complains about CatalogSource-version mismatch (`requires <version> from <catalog>` but the catalog now serves a different one), confirm the catalog source is healthy and serving the expected channel:

```bash
kubectl -n cpaas-marketplace get catalogsource
kubectl -n cpaas-marketplace logs deploy/<catalog-pod> --tail=200
```

A `Pulling` or `CrashLoopBackOff` registry pod blocks every Subscription that depends on its catalog. Fix the registry first; OLM recovers automatically once the catalog is `Ready`.
