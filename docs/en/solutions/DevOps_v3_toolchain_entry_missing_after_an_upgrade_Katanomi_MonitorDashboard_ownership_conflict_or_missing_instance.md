---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.1"
  - "4.2"
---

# DevOps v3 toolchain entry missing after an upgrade: Katanomi MonitorDashboard ownership conflict or missing instance

## Issue

- After a platform upgrade (for example 3.18.2 to 4.1.7) the DevOps pages are gone from the platform menu, `katanomi-operator` is already upgraded (for example v3.20), and the `katanomi-global` instance shows an error.
- Clicking Toolchain (Chinese UI: `工具链`) in the console redirects to a different page, and no toolchain operation can be performed.
- DevOps v3 is installed and there is no access entry for the toolchain.
- The `Alauda DevOps v3` operator is available on ACP 4.2 and the DevOps tool feature still has to be turned on.
- DevOps v3 is being retired in favor of DevOps v4, and the DevOps v3 user view has to be removed from the console, not only hidden as a product entry.

DevOps v3 consists of the `Alauda DevOps v3` operator (`katanomi-operator`, Katanomi, the DevOps core component built on Tekton) and a `Katanomi` instance, both on the `global` cluster.

## Root Cause

### Cause 1: UpgradeError, MonitorDashboard "devops-api" exists and cannot be imported into the current release

The `katanomi-global` instance of `katanomi-operator` in OperatorHub on `global` carries a condition with `reason: UpgradeError`:

```text
failed to upgrade release: rendered manifests contain a resource that already exists. Unable to continue with update: MonitorDashboard "devops-api" in namespace "cpaas-system" exists and cannot be imported into the current release: invalid ownership metadata; label validation error: missing key "app.kubernetes.io/managed-by": must be set to "Helm"; annotation validation error: missing key "meta.helm.sh/release-name": must be set to "katanomi-global"; annotation validation error: missing key "meta.helm.sh/release-namespace": must be set to "cpaas-system"
```

The DevOps v3 Helm release renders three `MonitorDashboard` (`v1alpha1`) objects in `cpaas-system`: `devops-api`, `devops-apiserver`, and `devops-controller`, each labeled `cpaas.io/dashboard.folder: devops`. Objects with those names already exist without the Helm ownership label `app.kubernetes.io/managed-by: Helm` and the annotations `meta.helm.sh/release-name` / `meta.helm.sh/release-namespace`. Helm refuses to take over an object that another owner created, so the release upgrade fails, the instance stays abnormal, and Toolchain redirects elsewhere. This is a product defect.

The instance can show `Deployed` (`UpgradeSuccessful`) and `Running` (`RunningSuccessful`) conditions next to the `ReleaseFailed` condition with reason `UpgradeError`; the `ReleaseFailed` condition is the one that matters. Deleting the dashboard named in the message (`devops-api`) lets the operator recreate it with Helm ownership, and the DevOps pages return.

The same conflict can block a fresh install: the `Katanomi` instance is not installed because of a duplicate `MonitorDashboard`, and the toolchain entry is missing. Deleting the pre-existing `MonitorDashboard` lets the installation recover.

### Cause 2: The DevOps v3 operator is installed but no Katanomi instance exists

The `Alauda DevOps v3` operator is deployed on `global` and the DevOps tool feature is still absent. The toolchain comes from a `Katanomi` instance, not from the operator alone. The Create Katanomi form proposes name `katanomi-sample` and namespace `katanomi-operator`, and has a required `External URL` field (its hint calls it the plugin webhook address) and a `Service` section with `API Port` (default `32000`), `Plugin Port` (default `32001`), and `Type` (default `NodePort`). `External URL` is the `global` cluster access address (the platform address).

### Cause 3: The DevOps feature card stays because the Katanomi instance and the DevOps v3 operator are still installed

Hiding the DevOps product entry leaves the DevOps v3 user view in place, because the view is provided by `katanomi-operator` and its `katanomi-sample` instance. Deleting the instance and then uninstalling DevOps v3 from OperatorHub removes the DevOps feature card. Leftover objects of the katanomi CRDs can then be cleaned up from the command line; the katanomi CRDs themselves can stay.

## Resolution

### Cause 1: UpgradeError, MonitorDashboard "devops-api" exists and cannot be imported into the current release

On `global`, read the condition and inspect the dashboards named in it:

```bash
kubectl api-resources | grep -i monitordashboard
kubectl get katanomi -A -o yaml | grep -n -B2 -A4 UpgradeError
kubectl -n cpaas-system get monitordashboard -l cpaas.io/dashboard.folder=devops
kubectl -n cpaas-system get monitordashboard devops-api devops-apiserver devops-controller -o yaml | grep -n -E '^  name:|managed-by|meta.helm.sh'
```

A dashboard named in the `invalid ownership metadata` message, without `app.kubernetes.io/managed-by: Helm` and the `meta.helm.sh/release-*` annotations, is this cause. Back up the dashboards:

```bash
mkdir -p "$HOME/devops-monitordashboard-backup"
for d in devops-api devops-apiserver devops-controller; do
  kubectl -n cpaas-system get monitordashboard "$d" -o yaml > "$HOME/devops-monitordashboard-backup/$d.yaml"
done
```

> **Warning:** Deleting a `MonitorDashboard` removes that DevOps monitoring dashboard until the DevOps v3 release creates it again. Precondition: only when the DevOps v3 instance shows `UpgradeError` (or fails to install) with `MonitorDashboard "<name>" in namespace "cpaas-system" exists and cannot be imported into the current release: invalid ownership metadata`, only for the dashboard that the message names, and with the backups written. Rollback: `kubectl apply -f` the backup file (remove `metadata.resourceVersion` and `metadata.uid` first) if the operator does not recreate it.

Delete the dashboard that the message names:

```bash
kubectl -n cpaas-system delete monitordashboard <dashboard-named-in-the-error>
```

Wait for the operator to retry the release, then check the instance and that the dashboards are recreated with Helm ownership metadata:

```bash
kubectl get katanomi -A
kubectl -n cpaas-system get monitordashboard -l cpaas.io/dashboard.folder=devops
kubectl -n cpaas-system get monitordashboard devops-api -o yaml | grep -n -E 'managed-by|meta.helm.sh'
```

If the retry names a different dashboard, back up and delete that one under the same Warning. Then open Toolchain again.

### Cause 2: The DevOps v3 operator is installed but no Katanomi instance exists

```bash
kubectl get csv -A | grep -i katanomi
kubectl get katanomi -A
```

No `Katanomi` object is this cause. In Platform Management > App Market Management > OperatorHub on `global`, open `Alauda DevOps v3`, go to its instances, and create a `Katanomi` instance:

1. Keep the name and namespace the form proposes (`katanomi-sample` in `katanomi-operator`). Use a different namespace, such as `cpaas-system` set in the YAML view, only when Alauda support instructs you to for your environment.
2. Set `External URL` to the `global` cluster access address (the platform address).
3. In `Service`, set `Type` to the ingress option; keep `API Port` and `Plugin Port` unless you have a reason to change them.

Check that the instance reconciles and the toolchain entry appears:

```bash
kubectl get katanomi -A
kubectl -n <katanomi-namespace> get pods | grep -i katanomi
```

### Cause 3: The DevOps feature card stays because the Katanomi instance and the DevOps v3 operator are still installed

Confirm with the owners that no DevOps v3 pipeline resource is needed; the steps below delete them. List and export what exists:

```bash
for crd in $(kubectl get crd | grep katanomi | awk '{print $1}'); do echo "=== CRD: $crd ==="; kubectl get "$crd" -A; done
mkdir -p "$HOME/katanomi-backup"
for crd in $(kubectl get crd | grep katanomi | awk '{print $1}'); do kubectl get "$crd" -A -o yaml > "$HOME/katanomi-backup/$crd.yaml"; done
```

> **Warning:** Deleting `katanomi-sample` and uninstalling DevOps v3 removes the DevOps v3 user view and stops every DevOps v3 function; the forced deletion below removes all katanomi custom resources (DevOps v3 pipeline and toolchain objects) without waiting for finalizers. Apart from re-applying the exports, which does not restore runtime state, this is irreversible. Precondition: only when DevOps v3 is being retired (for example for DevOps v4) and the owners confirmed that none of its resources are needed. Rollback: install DevOps v3 again from OperatorHub, create the instance (Cause 2), and re-apply the exported objects that are still needed.

1. In Platform Management > App Market Management > OperatorHub, open the DevOps v3 operator and delete the `katanomi-sample` instance under Instances.
2. Uninstall DevOps v3 (`katanomi-operator`) from OperatorHub. The DevOps feature card disappears.
3. Delete the remaining custom resources of every katanomi CRD:

   ```bash
   for crd in $(kubectl get crd | grep katanomi | awk '{print $1}'); do kubectl delete "$crd" --all -A --force --grace-period=0; done
   ```

Check that no katanomi objects remain (every line should print `0`):

```bash
for crd in $(kubectl get crd | grep katanomi | awk '{print $1}'); do kubectl get "$crd" -A --no-headers 2>/dev/null | wc -l; done
```

## Diagnostic Steps

```bash
kubectl get csv -A | grep -i katanomi
kubectl get katanomi -A
kubectl get katanomi -A -o yaml | grep -n -A3 'reason:'
kubectl -n cpaas-system get monitordashboard -l cpaas.io/dashboard.folder=devops
```

- `UpgradeError`, or a failed install, that names `MonitorDashboard "<name>" ... invalid ownership metadata`: Cause 1.
- A `katanomi-operator` CSV with no `Katanomi` object on `global`: Cause 2.
- A DevOps v3 view that must be removed while `katanomi-sample` and the operator are still installed: Cause 3.

If OperatorHub on `global` lists `Alauda DevOps Eventing v3` but not `Alauda DevOps v3`, the required operator package has not been uploaded. `Alauda DevOps v3` (Katanomi) is the operator required for DevOps v3 and for selecting Harbor images in ACP through the drop-down; `Alauda DevOps Eventing v3` does not need to be deployed for that. Upload the `Alauda DevOps v3` package first.
