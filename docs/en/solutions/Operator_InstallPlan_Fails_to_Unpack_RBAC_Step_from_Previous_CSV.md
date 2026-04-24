---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

An OLM-managed operator — in this case the local-storage provider that backs the TopoLVM storage system on ACP — is being upgraded to a new catalog revision. The `Subscription` produces an `InstallPlan` as expected, but the plan stalls with condition `Installed=False` and a message of the form:

```text
couldn't find unpacked step for local-storage-operator.v4.14.0-XXXXXXXXXXXX:
local-storage-operator.v4.14.0-XXXXXXXXXXXX-local-st-<hash>
[rbac.authorization.k8s.io/v1/Role (<catalog-ns>/<marketplace-ns>)] (Unknown)
```

The cluster-service version (CSV) for the new revision stays in `Pending`, the in-flight `InstallPlan` is `Failed`, and no pods ever roll over to the new image. User-facing symptom: the operator keeps running on the previous revision and never advances.

## Root Cause

OLM's catalog operator produces an `InstallPlan` as a DAG of "steps" — one step per resource that needs to be created or updated as part of the upgrade, with dependencies between them. When the plan is executed, each step's declared resource is "unpacked" from the bundle image into a cached per-step record. The plan watches for those cached records and refuses to proceed until every step reports `Created` or `Present`.

The message `couldn't find unpacked step for ... [rbac.authorization.k8s.io/v1/Role (...)]` means the catalog operator could not reconcile the RBAC step — typically a `Role` or `ClusterRole` that the new bundle declares — against the cluster state. The usual cause is a lingering `Role`/`ClusterRole` from the **previous** revision whose metadata or owner references no longer match what the new bundle expects; the unpacker sees an object at that name but cannot reconcile it to the new step, so it marks the step `Unknown` and the plan stalls indefinitely.

Other contributing factors that produce the same surface error:

- The `Role` step is generated correctly by the bundle, but the catalog cache has gone stale and the bundle image re-pull did not refresh the unpacked step record for that particular resource.
- The previous CSV was force-deleted leaving orphaned RBAC behind (without OLM getting to reconcile the owner references), and the new CSV cannot adopt those objects.

The common thread: old RBAC from the replaced CSV is blocking the unpack step of the new RBAC, and the `InstallPlan` needs those stale objects cleared before it can make progress.

## Resolution

### Preferred: clean up stale RBAC and let the extend-managed subscription regenerate the plan

Operator lifecycle on ACP is handled by the `extend` capability (the in-core OLM-based machinery for installing and upgrading extension operators). The correct recovery is to identify the specific stale RBAC objects that the new bundle cannot reconcile, remove them, and let the `Subscription` generate a fresh `InstallPlan` that can unpack cleanly.

1. Find the leftover `Role`/`ClusterRole` objects from the previous revision. Match by the name fragment that appeared in the failure message — typically the operator name prefix — or by labels the old CSV stamped on them:

   ```bash
   kubectl get clusterrole | grep <operator-name-prefix>
   kubectl get role -n <operator-namespace> | grep <operator-name-prefix>
   ```

2. Delete **only** the objects that are no longer referenced by any live CSV. Objects owned by a `Succeeded` CSV should be left alone:

   ```bash
   kubectl delete clusterrole <stale-name>
   kubectl delete role -n <operator-namespace> <stale-name>
   ```

3. Verify the target CSV exists in the catalog at the version the `Subscription` is asking for:

   ```bash
   kubectl get packagemanifest <operator-package> \
     -n <marketplace-namespace> -o yaml | \
     grep -E 'currentCSV|name:' -A1
   ```

4. If the current CSV and the failing `InstallPlan` need to be rebuilt from scratch (because partial state has accumulated through repeated failed attempts), delete the stuck lifecycle objects and let the `Subscription` regenerate a clean set:

   ```bash
   kubectl delete csv <pending-csv-name> -n <operator-namespace>
   kubectl delete subscription <subscription-name> -n <operator-namespace>
   kubectl delete installplan <failed-installplan-name> -n <operator-namespace>
   ```

5. Recreate the `Subscription` targeting the desired channel/version. OLM will generate a fresh `InstallPlan`; with the conflicting RBAC cleared, the unpack step succeeds and the CSV progresses to `Succeeded`.

6. Confirm end-state: the new CSV is `Succeeded`, the associated operator `Deployment` is at the new image, and for TopoLVM specifically, the topology-aware volume provisioner Pods are all running on the new revision:

   ```bash
   kubectl get csv -n <operator-namespace>
   kubectl get deploy -n <operator-namespace>
   kubectl get pods -n <operator-namespace> -o wide
   ```

The storage system backed by this operator — `storage/storagesystem_topolvm` in ACP — keeps serving existing `PersistentVolumes` throughout this procedure. Only the operator-level control plane pauses while the `InstallPlan` is being rebuilt; data-path CSI pods keep running.

### Fallback: self-assembled OLM deployment (not via ACP's extend surface)

If the cluster uses a raw upstream OLM installation (for example a direct `olm.yaml` deployment outside the ACP `extend` surface), the same failure mode can appear for any OLM-managed operator whose bundle RBAC conflicts with leftover RBAC from a previous version. The cleanup sequence is identical: delete the stale `Role`/`ClusterRole`, delete the stuck `InstallPlan` and CSV, recreate the `Subscription`. The relevant OLM CRDs (`Subscription`, `InstallPlan`, `ClusterServiceVersion`) are the same.

## Diagnostic Steps

Inspect the failing `InstallPlan` to see which exact step is stuck and what resource it refers to:

```bash
kubectl get installplan -n <operator-namespace> \
  <installplan-name> -o yaml | \
  yq '.status.conditions, .status.plan'
```

The relevant pieces are:

- A condition `type: Installed, status: "False", reason: InstallComponentFailed` with the `couldn't find unpacked step for ...` message.
- A plan entry whose `resource.kind` is `Role` or `ClusterRole` and whose `status` is `Unknown` — that is the step the unpacker could not reconcile.

Compare that RBAC name to the objects currently on the cluster:

```bash
kubectl get clusterrole,role -A | grep <name-from-installplan>
```

If an object exists but its `ownerReferences` point at the previous CSV (or no CSV at all), it is the stale object blocking the unpack step.

Check the catalog operator's own logs for the rebuild of the unpacked cache; repeated errors about the same step name confirm the stall is not transient:

```bash
kubectl -n <olm-namespace> logs deploy/catalog-operator | \
  grep -E 'unpacked|<installplan-name>'
```

After the cleanup and `Subscription` recreate, watch the new `InstallPlan` walk through its steps:

```bash
kubectl -n <operator-namespace> get installplan -w
```

The healthy sequence is `Phase: Planning` → `Phase: RequiresApproval` (if manual approval is enabled) → `Phase: Installing` → `Phase: Complete`. The CSV then advances `Pending` → `Installing` → `Succeeded` over roughly the same window.
