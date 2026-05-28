---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# OLM InstallPlan fails with "couldn't find unpacked step" during an operator upgrade on ACP

## Issue

On Alauda Container Platform, operators delivered as OperatorBundles are reconciled by the upstream OLM control plane running in the `cpaas-system` namespace (OLM image `registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.1`). During an operator upgrade, the catalog-operator unpacks the resolved bundle into an `InstallPlan` whose `status.plan[]` carries one typed step per resource, each element shaped as `{resolving, resource, status}`. When the catalog-operator cannot unpack or reconcile one of those per-resource steps — for example an RBAC `Role` or `ClusterRole` step — that step's `status` is left in the `Unknown` state rather than reaching the healthy `Present` value.

When a plan step is stuck this way, the `InstallPlan` does not complete: its `status.phase` moves to the `Failed` value instead of the healthy `Complete` value, and the stuck CSV surfaces the failure through its own `status.phase` carrying a `Failed` value with a camelcased reason and a human-readable message. The `InstallPlan` records the outcome in `status.conditions[]`, where each condition carries the standard upstream field shape — `type`, `status`, `reason`, `message`, `lastTransitionTime`, and `lastUpdateTime` — and the `reason` is the camelcased identifier for the state transition.

The condition `message` follows the upstream OLM template `couldn't find unpacked step for <csv-name>: <csv-name>-<short-hash>[<gvr> (<source-name>/<source-namespace>)] (Unknown)`, naming the CSV the step belongs to and the failing step's identifier; on ACP the bracketed source identity resolves to the active catalog source, for example `(platform/cpaas-system)`.

## Root Cause

The bracketed segment in the failure message — `<csv-name>-<hash>[<group>/<version>/<kind> (<source-name>/<source-namespace>)] (Unknown)` — identifies the GVK of the failing bundle step together with the catalog source name and namespace it was resolved from. For an RBAC step, a segment such as `rbac.authorization.k8s.io/v1/Role` means the failing step is a `Role` under the `v1` API of the `rbac.authorization.k8s.io` group; on ACP the trailing source identity reflects the resolved catalog source, for example `platform/cpaas-system`.

The failure surfaces during the CSV replacement that an upgrade triggers. While the new InstallPlan is unresolved, the prior CSV holds the `Replacing` value in its `status.phase` and the incoming CSV holds the `Pending` value; the `csv.spec.replaces` field is the string link from the new CSV back to the name of the CSV it replaces, which is the upgrade replacement edge that the catalog-operator must satisfy before the incoming CSV can progress.

## Resolution

Confirm the replacement relationship between the two CSVs in the operator's namespace. Listing the CSVs shows both rows, with the `REPLACES` column linking the new CSV back to the prior one:

```bash
kubectl get csv -n <operator-ns>
```

Inspect the cluster-scoped and namespace-scoped RBAC that carries the operator's name prefix, so that leftover roles from the prior operator version can be identified against the step the message names:

```bash
kubectl get clusterrole | grep <operator-name>
kubectl get role -n <operator-ns> | grep <operator-name>
```

Before driving a fresh resolution, confirm that the intended target version is actually available in the resolved catalog by reading the PackageManifest's `status.channels[].currentCSV`. On ACP this is read from the PackageManifest itself — including the catalog source identity, `catalogSource=platform` in `catalogSourceNamespace=cpaas-system` — rather than assumed:

```bash
kubectl get packagemanifest <operator> -n cpaas-system -o yaml | grep currentCSV -A3
```

Recovery is confirmed when the new CSV reaches the `Succeeded` value in its `status.phase`, observable by listing the CSVs in the operator's namespace:

```bash
kubectl get csv -n <operator-ns>
```

## Diagnostic Steps

When the upgrade is stalled, listing the CSVs in the operator's namespace shows both the prior CSV in the `Replacing` value and the incoming CSV in the `Pending` value, with the `REPLACES` column linking the new CSV to the one it supersedes — confirming the InstallPlan for the incoming CSV has not yet resolved. Cross-reference the failing GVR named in the InstallPlan condition message (for example `rbac.authorization.k8s.io/v1/Role`) against the roles that carry the operator's name prefix to locate the specific RBAC object involved. Once the incoming CSV advances to the `Succeeded` value, the replacement has completed cleanly.
