---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Operator upgrade blocked by a newly required CRD field on OLM

## Issue

On Alauda Container Platform (`marketplace` chart `v4.3.7`, `catalog-operator` image `registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.1`), the OLM control plane runs in the `cpaas-system` namespace with the upstream `operators.coreos.com/v1alpha1` group registered (`CatalogSource` / `Subscription` / `InstallPlan` / `ClusterServiceVersion` / `OperatorGroup` / `OLMConfig` / `OperatorCondition` / `Operator`). When an operator upgrade is approved, the `catalog-operator` resolves a new `ClusterServiceVersion` and produces an `InstallPlan` whose steps include applying any updated `CustomResourceDefinition` shipped with the bundle.

When the new bundle ships a `CustomResourceDefinition` version whose `spec.versions[].schema.openAPIV3Schema.required` list adds a property that the previous CRD version did not require, the `CustomResource` objects already stored against the previous schema do not carry that property in their stored `spec`. The structural-schema validator in `kube-apiserver` (`v1.34.5` on this cluster) would reject those objects on any subsequent write because they fail validation against the new schema.

The visible result on the cluster is a `ClusterServiceVersion` that does not reach `Succeeded`. `kubectl get csv -n <namespace>` shows the new CSV with a non-`Succeeded` phase (typical phases include `Failed` / `Pending` / `Installing` / `Replacing`), and `kubectl describe csv <name> -n <namespace>` exposes the failure detail under `status.phase`, `status.reason` and `status.message`.

## Root Cause

OLM performs a CRD upgrade safety check before letting the bundle's new CRD version land. When the existing `CustomResource` objects of the kind being upgraded would fail structural-schema validation against the updated `openAPIV3Schema` (because the new `required:` list names a field they do not carry), OLM blocks the upgrade rather than allowing the CRD update to commit and leave the stored objects invalid.

The `default:` keyword declared on a CRD schema property does not rescue this case. `kube-apiserver` applies defaults only at write time — on the create or update request for the `CustomResource` — and never re-walks etcd to backfill defaults onto objects that were stored before the field existed. Pairing a new `required:` field with a `default:` therefore does not auto-heal existing `CustomResource` objects; they remain missing the field until a write touches them, and they continue to fail validation against the new schema.

The generic failure pattern, expressed without a specific operator, is: an operator's new version adds a property to its CRD's `required` list that existing CustomResources do not carry, and OLM blocks the upgrade until those existing objects either gain the field or are removed.

## Resolution

Coordinate with the operator vendor for the upgrade's migration guidance, then patch the existing `CustomResource` objects so they populate the newly-required field (or otherwise update / recreate them) so they satisfy the updated CRD schema. Once every existing `CustomResource` of the affected kind carries the field, re-approve the `InstallPlan` and the upgrade proceeds:

```bash
kubectl get <cr-kind> -A
kubectl -n <namespace> patch <cr-kind> <name> --type=merge -p '{"spec":{"<new-required-field>":"<value>"}}'
```

After patching, confirm the blocked `ClusterServiceVersion` advances past the previous failure. `kubectl get csv -n <namespace>` should show the new CSV moving through `Installing` / `Replacing` toward `Succeeded`, and `kubectl describe csv <name> -n <namespace>` should no longer carry the validation `status.reason` / `status.message` from the prior attempt.

## Diagnostic Steps

Read the affected CRD's current required-field list directly from the CRD object. The `required:` stanzas under each `spec.versions[].schema.openAPIV3Schema` level name the properties a `CustomResource` must carry to pass apiserver structural-schema validation:

```bash
kubectl get crd <crd-name> -o yaml | grep -n 'required:' -A5
```

List the `ClusterServiceVersion` objects in the install namespace to see the blocked upgrade's phase, then describe the failing CSV to read the `status.reason` and `status.message` that explain why the `InstallPlan` step did not commit:

```bash
kubectl get csv -n <namespace>
kubectl describe csv <name> -n <namespace>
```

List namespace-scoped events to surface Kubernetes `Warning` events that OLM emits during the failed `InstallPlan` execution. These events are tagged with `clusterserviceversion/<name>` (and related object kinds) and record the CRD-update / CSV-install failure visible to the namespace:

```bash
kubectl get events -n <namespace>
```

Cross-reference the failing CSV's reported field against the CRD's `required:` list, identify each existing `CustomResource` of that kind that is missing the field, and apply the Resolution patch before re-approving the `InstallPlan`.
