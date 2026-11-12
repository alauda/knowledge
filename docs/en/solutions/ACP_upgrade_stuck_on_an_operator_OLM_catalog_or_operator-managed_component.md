---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# ACP upgrade stuck on an operator, OLM catalog, or operator-managed component

## Issue

The platform upgrade waits on an operator-managed component and does not progress. One of the following is visible:

- `olm-registry-custom`, `olm-registry-platform`, or `olm-registry-system` is in `CrashLoopBackOff` with `unable to load in-cluster config`.
- The ARS (AppRelease) stays unready after an operator upgrade, and the `sentry` log shows a version-check Job that still checks the previous operator version.
- Argo CD `minfo` (ModuleInfo) is Failed during the upgrade to 4.0.9 and the Argo CD wait Job has no logs.
- The upgrade page stays in the Katanomi phase.
- The ASM (service mesh) upgrade fails with `bundles outdated`.
- The platform upgrade is stuck at the Tekton component.
- `redis-operator` stays in processing on the upgrade page.
- `rds-operator-updater` is stuck, or several components wait for the `rds-operator` upgrade.
- Argo CD is not ready after `bash upgrade.sh` has completed.

## Root Cause

### Cause 1: olm-registry Pods crash with unable to load in-cluster config

The three `olm-registry-*` Pods crash with `unable to load in-cluster config`, and `kubectl get rpch` shows a ResourcePatch (`rpch`) that targets ConfigMap `olm-registry-config` in `cpaas-system`. The local override of that ConfigMap breaks the registry Pods.

### Cause 2: The version-check Job still validates the previous operator version

After an operator upgrade the ARS stays unready, and the `sentry` log shows the Job that checks the operator version and status still pinned to the previous version (for example the Job checks `v4.2.0` while `argocd-operator` is already `v4.2.1`). Editing the Job in place does not change what its Pod runs.

### Cause 3: Argo CD minfo is Failed because the installed operator package is the wrong build

During the upgrade to 4.0.9, the Argo CD `minfo` is Failed, the ARS error names GitOps Operator `v4.1.8`, and the Argo CD wait Job has no logs. The cluster has Argo CD Operator `4.2.1` loaded, while that upgrade requires package `4.2.0`. The version pair is specific to the 4.0.9 upgrade; for another target, compare the version named in the ARS error with the version shipped in the upgrade package.

### Cause 4: Katanomi update is stuck on a historical Helm release

The upgrade remains in the Katanomi phase. `helm ls -A` lists release `katanomi-global` in `cpaas-system` from the previous product generation, and the `katanomis.operators.katanomi.dev` object still points to a CatalogSource named `stable` that `kubectl get catalogsource -A` does not show.

### Cause 5: The mesh upgrade reports bundles outdated

The ASM upgrade fails with `bundles outdated`, although the mesh images are present on both the `global` cluster and the business cluster. Restarting `catalog-operator`, `packageserver`, `olm-operator`, and `olm-registry-system` unblocks OLM. Which of the four processes held stale data is not known.

### Cause 6: The v3 tekton-operator and the v4 Pipeline operator both manage the same Tekton instance

On a 4.1.2 to 4.2.1 platform upgrade the upgrade stays on the Tekton component. Both the v3 Tekton operator (`tekton-operator`) and the v4 Pipeline operator are installed and reconcile the same Tekton instance. v3 Tekton and v4 Pipeline cannot coexist; uninstalling the v3 `tekton-operator`, without changing the instance itself, clears the block.

### Cause 7: redis-operator stays processing because its Subscription requires manual approval

During a 4.1.3 to 4.2.1 upgrade, after the plugin packages were uploaded and `upgrade.sh` was run, `redis-operator` stays in processing. Its OperatorHub details page (Alauda Cache Service for Redis OSS) shows the old installed CSV (for example `redis-operator.v4.1.1` in `redis-system`, status `Succeeded`, channel `alpha`) and a banner that a new version is detected. The Subscription's upgrade strategy is manual, so the platform upgrade does not upgrade the operator; the new version waits for confirmation.

### Cause 8: rds-operator or rds-operator-updater blocks the operators that follow it

- `rds-operator-updater` is stuck (for example on a 4.1.3 to 4.1.4 upgrade). Deleting its Subscription lets the upgrade continue.
- On a workload-cluster upgrade, several components wait for the `rds-operator` upgrade. Uninstalling `rds-operator` and deleting its `minfo` and Subscription lets the upgrade continue. Why the `rds-operator` upgrade blocks the others is not known.

If the next operators then stall because their Pods cannot be created on a node, that is a separate node-level problem.

### Cause 9: Argo CD is not ready after upgrade.sh completes

`bash upgrade.sh` finished, but Argo CD is not ready. This state can be ignored at this point; start the `global` cluster upgrade directly. The cause of the not-ready state has not been determined, so check Argo CD again after the global upgrade.

## Resolution

Match one signature before changing the cluster, and save every object before deleting it.

### Cause 1: olm-registry Pods crash with unable to load in-cluster config

> **Warning:** Deleting this `rpch` removes the local override of ConfigMap `olm-registry-config`; images or endpoints that the override forced fall back to the chart defaults. Precondition: only when the CrashLoop log is `unable to load in-cluster config` and the `rpch` targets `cpaas-system/olm-registry-config`. Rollback: `kubectl apply -f /tmp/rpch-olm.bak.yaml`.

```bash
kubectl get rpch -o yaml > /tmp/rpch-olm.bak.yaml
kubectl get rpch | grep olm
kubectl delete rpch <rpch-name>
kubectl get pods -n cpaas-system | grep olm-registry
kubectl delete pod -n cpaas-system <olm-registry-custom-pod> <olm-registry-platform-pod> <olm-registry-system-pod>
```

The replacement Pods should load the in-cluster config.

### Cause 2: The version-check Job still validates the previous operator version

> **Warning:** Deleting the version-check Job stops its Pod. Precondition: only when the `sentry` log quotes the old version inside that Job and an in-place edit of the Job did not change the check. Rollback: the controller recreates the Job. If the new Job still pins the old version, the installed package is wrong; use Cause 3.

```bash
kubectl get jobs -A
kubectl delete job -n <namespace> <version-check-job>
```

Watch the ARS. Ready means this Job was the blocker.

### Cause 3: Argo CD minfo is Failed because the installed operator package is the wrong build

For the 4.0.9 upgrade, upload Argo CD Operator package `4.2.0` with `violet`, remove package `4.2.1`, and let the Argo CD `minfo` reconcile. For another target version, upload the operator package version that the upgrade bundle requires and remove the other build that the ARS error shows being installed.

### Cause 4: Katanomi update is stuck on a historical Helm release

> **Warning:** This deletes Helm release `katanomi-global` and its objects and removes the CatalogSource `stable` reference from the Katanomi object. Precondition: only when the upgrade is stuck in the Katanomi phase, `helm ls -n cpaas-system` shows `katanomi-global`, and no CatalogSource named `stable` exists. Save the Helm manifest first; the historical release is not reinstalled afterwards. Rollback of the Katanomi object: `kubectl apply -f /tmp/katanomi.bak.yaml`.

```bash
helm get all -n cpaas-system katanomi-global > /tmp/katanomi-global.helm.txt
kubectl get katanomis.operators.katanomi.dev -A -o yaml > /tmp/katanomi.bak.yaml
helm delete -n cpaas-system katanomi-global
```

Edit the `katanomis.operators.katanomi.dev` object: remove the spec fields that name CatalogSource `stable`, and set an annotation so the object changes (for example `cpaas.io/reconcile-at` with the current UTC time). Then restart the catalog Pods:

```bash
kubectl get pods -n cpaas-system | grep -E 'packageserver|catalog'
kubectl delete pod -n cpaas-system <packageserver-pod> <catalog-pod>
```

Katanomi enqueues its own upgrade after those Pods are Ready.

### Cause 5: The mesh upgrade reports bundles outdated

Confirm that the mesh images are on the `global` cluster and the business cluster, then restart the four OLM processes.

> **Warning:** Catalog resolution pauses until the replacement Pods are Ready, and in-flight InstallPlans retry. Precondition: only when the upgrade reports `bundles outdated` and the images are already present on both clusters. Rollback: none needed; the controllers recreate the Pods.

```bash
kubectl get pods -n cpaas-system | grep -E 'catalog-operator|packageserver|olm-operator|olm-registry-system'
kubectl delete pod -n cpaas-system <catalog-operator-pod> <packageserver-pod> <olm-operator-pod> <olm-registry-system-pod>
```

### Cause 6: The v3 tekton-operator and the v4 Pipeline operator both manage the same Tekton instance

List both operators and the instance they share:

```bash
kubectl get csv -A | grep -Ei 'tekton|pipeline'
kubectl get subscriptions.operators.coreos.com -A | grep -Ei 'tekton|pipeline'
kubectl get deploy -A | grep -Ei 'tekton-operator|pipeline'
kubectl api-resources | grep -i tekton
```

For upstream-based Tekton operators the shared instance is the `TektonConfig` object (`operator.tekton.dev`); read it so you know what has to stay.

> **Warning:** The v3 `tekton-operator` stops reconciling Tekton and the v4 Pipeline operator becomes the only manager of the instance. Precondition: only when both operators are installed and the upgrade is stuck at the Tekton component. Keep the Tekton instance, its CRDs, and its namespaces; remove the v3 operator only. Rollback: `kubectl apply -f` the saved objects, which installs the v3 operator again and brings back the conflict.

When the v3 operator is installed through OLM (the commands above list a Subscription and CSV for it), remove those two objects:

```bash
kubectl get subscriptions.operators.coreos.com -n <tekton-operator-namespace> <tekton-operator-sub> -o yaml > /tmp/sub-tekton-operator.bak.yaml
kubectl get csv -n <tekton-operator-namespace> <tekton-operator-csv> -o yaml > /tmp/csv-tekton-operator.bak.yaml
kubectl delete subscriptions.operators.coreos.com -n <tekton-operator-namespace> <tekton-operator-sub>
kubectl delete csv -n <tekton-operator-namespace> <tekton-operator-csv>
```

Deleting a CSV leaves the CRDs and custom resources in place. When the v3 operator was not installed through OLM, uninstall it the way it was installed, again keeping the instance. The Tekton stage moves once only the v4 Pipeline operator manages the instance.

### Cause 7: redis-operator stays processing because its Subscription requires manual approval

In OperatorHub, search for `redis-operator` and click **Confirm** on the new-version banner of its details page. To upgrade every operator that waits in the same way at once, use the batch upgrade under Cluster Management > Cluster > Feature Components.

The same state from the command line:

```bash
kubectl get subscriptions.operators.coreos.com -n redis-system -o yaml | grep -n -E 'installPlanApproval|currentCSV|installedCSV|state'
kubectl get installplan -n redis-system
```

`installPlanApproval: Manual` and an InstallPlan with `APPROVED` `false` are the signature. Approving that InstallPlan performs the same upgrade:

> **Warning:** The Redis operator is upgraded to the new CSV, and the instances it manages may be reconciled by the new operator version. Precondition: only when `redis-operator` is stuck in processing, its Subscription is `Manual`, and the InstallPlan names the target version. Check the Redis instance prerequisites for the operator upgrade first. Rollback: treat this as one-way; OLM does not downgrade an approved InstallPlan.

```bash
kubectl patch installplan -n redis-system <installplan-name> --type=merge -p '{"spec":{"approved":true}}'
kubectl get csv -n redis-system
```

When the new CSV is `Succeeded`, check that the upgrade page has moved past `redis-operator`.

### Cause 8: rds-operator or rds-operator-updater blocks the operators that follow it

```bash
kubectl get subscriptions.operators.coreos.com -A | grep -i rds
kubectl get csv -A | grep -i rds
kubectl get minfo | grep -i rds
```

> **Warning:** Removing the Subscription stops OLM from managing that operator's upgrades. Uninstalling `rds-operator` stops reconciliation of the RDS-managed instances (failover, scaling, backup) until it is installed again; running database Pods are not deleted. Precondition: only when the upgrade is stuck on `rds-operator-updater` or on components that wait for `rds-operator`. Back up each object first. Rollback: `kubectl apply -f` the backups, or install `rds-operator` again from OperatorHub after the platform upgrade.

For a stuck `rds-operator-updater`, delete its Subscription:

```bash
kubectl get subscriptions.operators.coreos.com -n <namespace> <rds-operator-updater-sub> -o yaml > /tmp/sub-rds-operator-updater.bak.yaml
kubectl delete subscriptions.operators.coreos.com -n <namespace> <rds-operator-updater-sub>
```

When components wait for the `rds-operator` upgrade, uninstall `rds-operator` (from OperatorHub, or by deleting its Subscription and CSV), then delete its `minfo` on the `global` cluster:

```bash
kubectl get subscriptions.operators.coreos.com -n <namespace> <rds-operator-sub> -o yaml > /tmp/sub-rds-operator.bak.yaml
kubectl get csv -n <namespace> <rds-operator-csv> -o yaml > /tmp/csv-rds-operator.bak.yaml
kubectl delete subscriptions.operators.coreos.com -n <namespace> <rds-operator-sub>
kubectl delete csv -n <namespace> <rds-operator-csv>
kubectl get minfo <rds-minfo> -o yaml > /tmp/minfo-rds-operator.bak.yaml
kubectl delete minfo <rds-minfo>
```

If RDS-managed instances run on the cluster, install the `rds-operator` version that matches the new platform version once the upgrade is complete.

### Cause 9: Argo CD is not ready after upgrade.sh completes

No change is needed at this point. Start the `global` cluster upgrade from the upgrade page, then check Argo CD again:

```bash
kubectl get minfo | grep -i argo
kubectl get pods -A | grep -i argocd | grep -Ev 'Running|Completed'
```

If the Argo CD `minfo` is Failed after the global upgrade and the ARS error names an operator build other than the one in the upgrade package, use Cause 3.

## Diagnostic Steps

1. Note the component the upgrade page waits on, and whether it is installed through OLM (a CatalogSource, an operator package, or a CSV).
2. Read the OLM and operator objects on the stuck cluster:

   ```bash
   kubectl get pods -n cpaas-system | grep -E 'olm-registry|olm-operator|catalog-operator|packageserver'
   kubectl get catalogsource -A
   kubectl get csv -A | grep -Ev 'Succeeded'
   kubectl get rpch | grep -i olm
   kubectl get jobs -A | grep -Ei 'check|wait'
   helm ls -A | grep -i katanomi
   ```

3. Match the first finding:

| What you see | Cause |
| --- | --- |
| `unable to load in-cluster config` in an olm-registry Pod, and an `rpch` targets `olm-registry-config` | 1 |
| ARS unready after an operator upgrade; the version-check Job still quotes the previous version | 2 |
| Argo CD `minfo` Failed, empty wait Job, an operator build other than the one in the upgrade package is loaded | 3 |
| Katanomi phase, Helm release `katanomi-global`, CatalogSource `stable` missing | 4 |
| `bundles outdated` with the mesh images already present | 5 |
| Stuck at Tekton, both the v3 `tekton-operator` and the v4 Pipeline operator installed | 6 |
| `redis-operator` processing, new-version banner in OperatorHub, Subscription `installPlanApproval: Manual` | 7 |
| `rds-operator-updater` stuck, or several components waiting for `rds-operator` | 8 |
| Argo CD not ready right after `bash upgrade.sh`, before the global upgrade | 9 |

4. After the change, the operator's CSV should reach `Succeeded`, the ARS should become Ready, and the upgrade page should move to the next stage.

A message such as `redis-operator is not ready for version <version>` while another component (for example CoreDNS) is being upgraded, with the installed Redis operator already on a newer version, is not Cause 7. Compare the installed CSVs, the `minfo` versions, and `installedCSV` against `currentCSV` on the Subscription before acting:

```bash
kubectl get csv -A | grep -i redis-operator
kubectl get minfo -A | grep -iE 'coredns|redis-operator'
kubectl get subscriptions.operators.coreos.com -A -o yaml | grep -n -E 'name:|installPlanApproval|currentCSV|installedCSV|state'
```
