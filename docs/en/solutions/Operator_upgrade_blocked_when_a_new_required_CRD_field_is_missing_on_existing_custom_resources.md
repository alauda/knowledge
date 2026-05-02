---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Operator upgrade blocked when a new required CRD field is missing on existing custom resources
## Issue

An operator upgrade managed by the Operator Lifecycle Manager (OLM) fails to install a new `ClusterServiceVersion` (CSV). The new CSV ships an updated `CustomResourceDefinition` (CRD) that introduces a previously optional field as `required`. Existing custom resources that were created with the older CRD schema do not contain that field. OLM enforces a CRD upgrade safety check, sees that legacy resources would no longer validate against the new schema, and refuses to apply the upgrade. The CSV stays in `Pending` or `Failed`, no `InstallPlan` for the new version completes, and the operator pod continues to run on the old version.

## Root Cause

OLM runs CRD validation against every existing custom resource of the affected `Kind` before promoting a CSV. If the new CRD declares a field as `required` and that field is absent on any existing instance, validation fails for those instances and the upgrade is blocked. Default values declared in `openAPIV3Schema` are not back-filled into stored objects on a CRD update; defaults are only applied on subsequent writes through the API server. This means simply updating the CRD on the cluster is not enough — every legacy custom resource has to gain the new field by an explicit write, or the field has to remain optional in the CRD.

## Resolution

The correct fix depends on who controls the CRD:

- **The operator vendor controls the CRD**. The new release should either keep the field optional with a default, or ship a conversion webhook that materialises the field on read. Coordinate with the vendor (release notes, support channel, upstream issue tracker) to obtain a migration procedure or a hotfix CSV that does not violate upgrade safety.

- **The cluster operator controls the CRD lifecycle**. Patch every existing custom resource so that it contains the newly required field before approving the upgraded `InstallPlan`. The patch must occur while the **old** CRD is still in effect, otherwise the API server itself will reject writes that do not carry the field.

  ```bash
  kubectl get <crd-singular> -A -o name | while read cr; do
    kubectl patch "$cr" --type merge -p '{"spec":{"<new.path>":<value>}}'
  done
  ```

  Once every instance carries the new field, approve the pending `InstallPlan`:

  ```bash
  kubectl get installplan -n <ns>
  kubectl patch installplan/<name> -n <ns> --type merge -p '{"spec":{"approved":true}}'
  ```

After the upgrade completes, verify that the new CRD revision is active and that the operator's `csv` reaches `Succeeded`:

```bash
kubectl get crd <crd-name> -o jsonpath='{.spec.versions[?(@.storage==true)].name}{"\n"}'
kubectl get csv -n <ns>
```

### Avoiding the same trap downstream

When designing CRDs, treat any field promotion from optional to required as a breaking schema change. Either keep it optional with a default, or ship a conversion webhook in the same release that owns the migration. OLM's safety check exists precisely so that workloads keyed off the older shape are not silently invalidated mid-upgrade.

## Diagnostic Steps

1. Identify the blocked CSV and its message:

   ```bash
   kubectl get csv -n <ns>
   kubectl describe csv/<name> -n <ns>
   ```

   The status will reference the validation failure on the CRD upgrade.

2. Read the new CRD schema and locate the new required field:

   ```bash
   kubectl get crd <crd-name> -o yaml | yq '.spec.versions[] | select(.served) | .schema.openAPIV3Schema'
   ```

3. List existing custom resources and confirm which ones lack the new field:

   ```bash
   kubectl get <crd-singular> -A -o yaml | grep -L '<new-field>'
   ```

4. Inspect the operator catalog source to confirm the version graph and the expected target version:

   ```bash
   kubectl get subscription/<name> -n <ns> -o jsonpath='{.status}{"\n"}'
   kubectl get packagemanifest <pkg> -o jsonpath='{.status.channels[*].currentCSV}{"\n"}'
   ```
