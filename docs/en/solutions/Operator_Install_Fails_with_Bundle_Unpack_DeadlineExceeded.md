---
title: Operator install or upgrade fails with bundle unpacking DeadlineExceeded on ACP
component: extend
scenario: troubleshooting
tags: [olm, operatorbundle, marketplace, cpaas-system, installplan, bundle-unpack]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Operator install or upgrade fails with bundle unpacking DeadlineExceeded on ACP

## Issue

On Alauda Container Platform 4.3 (`registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.2`, upstream OLM v0.19.0, git `0c14b4e`; marketplace chart-version `v4.3.13`; Kubernetes `v1.34.5-1`), an `OperatorBundle` install or upgrade can stall with the upstream OLM message `bundle unpacking failed. Reason: DeadlineExceeded, and Message: Job was active longer than specified deadline`. The condition surfaces on the failing `Subscription` in the per-operator target namespace via a standard `operators.coreos.com/v1` `Subscription.status.conditions[type=InstallPlanFailed]` entry — the same condition shape and message string the upstream OLM emits, since ACP ships unmodified `subscriptions.operators.coreos.com`, `installplans.operators.coreos.com`, `clusterserviceversions.operators.coreos.com`, `operatorgroups.operators.coreos.com`, and `catalogsources.operators.coreos.com` CRDs [ev:c1].

## Root Cause

When OLM materializes an `InstallPlan` for an `OperatorBundle` `Subscription`, the `catalog-operator` Deployment in the `cpaas-system` namespace creates a short-lived Kubernetes `Job` (and a matching `ConfigMap`) in the same namespace as the `CatalogSource` that serves the bundle — on ACP that namespace is `cpaas-system`, which hosts the three platform `CatalogSource` instances `platform`, `system`, and `custom` (all `grpc` type, publisher `harbor.alauda.cn`), each fronted by an `olm-registry-<source>` Deployment. The Job runs `opm` against the bundle image referenced by the catalog entry to extract its manifests into the ConfigMap so OLM can render the CSV [ev:c2].

The bundle-unpack Job that the `catalog-operator` generates is bounded by an `activeDeadlineSeconds` derived from the `--bundle-unpack-timeout` flag whose default is `10m0s` on the ACP-vendored OLM build — so any extract whose underlying pull or `opm` execution takes more than ten minutes causes the Job to exceed its deadline, mark itself `DeadlineExceeded`, and surface the failure up the `InstallPlan` → `Subscription.status.conditions[InstallPlanFailed]` chain. The defaults are the upstream OLM defaults; nothing about the ACP packaging shortens or lengthens the window [ev:c3].

## Resolution

Recover an install-side failure (no prior healthy `ClusterServiceVersion` for this operator) by clearing the stuck OLM state in the per-operator target namespace and the stale unpack artifacts in `cpaas-system`, then re-creating the `Subscription`. First locate the unpack Job and matching ConfigMap in `cpaas-system` by filtering Jobs whose pod-template environment contains the operator package name [ev:c8]:

```bash
kubectl get job -n cpaas-system -o json | jq -r \
  '.items[] | select(.spec.template.spec.containers[].env[].value | contains ("<operator-package-name>")) | .metadata.name'
```

Delete the matching ConfigMap and Job in `cpaas-system`; the `catalog-operator` will re-create them on the next reconcile when the Subscription is re-attempted [ev:c9]:

```bash
JOBS=$(kubectl get job -n cpaas-system -o json | jq -r \
  '.items[] | select(.spec.template.spec.containers[].env[].value | contains ("<operator-package-name>")) | .metadata.name')

kubectl delete configmap -n cpaas-system $JOBS
kubectl delete job       -n cpaas-system $JOBS
```

Then, in the per-operator target namespace (Subscriptions, InstallPlans, and CSVs live alongside the operator workload — e.g. `argocd`, `kubevirt`, `nativestor-system` — not in the catalog namespace), inspect the `InstallPlan` before deleting it. An `InstallPlan` can carry CSVs for more than one operator at once; deleting it affects every operator listed in its `.spec.clusterServiceVersionNames`, so confirm the InstallPlan references only the operator being recovered before removing it [ev:c11]:

```bash
kubectl get installplan -n <target-namespace>
kubectl get installplan -n <target-namespace> <install-plan-name> \
  -o jsonpath='{.spec.clusterServiceVersionNames}'
```

When the scope check is satisfied, remove the failed `InstallPlan`, the `Subscription`, and the failed `ClusterServiceVersion` from the target namespace, then re-create the `Subscription` to re-trigger the install with fresh unpack artifacts [ev:c10]:

```bash
kubectl delete installplan -n <target-namespace> <install-plan-name>
kubectl delete subscription -n <target-namespace> <subscription-name>
kubectl delete csv          -n <target-namespace> <csv-name>
```

For an upgrade-side failure where a previous `ClusterServiceVersion` is still serving, the ConfigMap + Job refresh in `cpaas-system` is sufficient on its own — do not delete the running `Subscription` or `CSV`, since the previous version is the rollback target and the install chain will reuse it [ev:c9].

## Diagnostic Steps

Confirm the failing `Subscription`'s diagnostic by reading its `status.conditions` directly; the upstream-format condition object — `{type, status, reason, message, lastTransitionTime}` — appears unchanged on ACP, so the `InstallPlanFailed` line carries the original OLM `bundle unpacking failed. Reason: DeadlineExceeded …` text verbatim and is the load-bearing signal that the install is stuck on the unpack step rather than on, for example, dependency resolution or RBAC [ev:c1]:

```bash
kubectl get subscription -n <target-namespace> <subscription-name> \
  -o jsonpath='{.status.conditions[?(@.type=="InstallPlanFailed")].message}{"\n"}'
```

Enumerate `CatalogSource` and current `Subscription` / `InstallPlan` state to confirm the catalog namespace and verify the install routing — Subscriptions point at one of the three CatalogSources (`platform` / `system` / `custom`) in `cpaas-system`, and each Subscription's corresponding `InstallPlan` lives next to it in the per-operator target namespace with the name shape `install-<5char>` [ev:c10][ev:c11]:

```bash
kubectl get catalogsource -A
kubectl get subscription -A
kubectl get installplan -A
```

Inspect the unpack Job's pod (when it is still present) for the underlying failure that caused the deadline to be exceeded. The `Job` shape that the `catalog-operator` produces in `cpaas-system` is a standard Kubernetes Job; events on the Pod surface the real cause — typical examples are `Pulling` → `Failed` → `ErrImagePull` → `ImagePullBackOff` when the catalog-registry pod cannot reach the bundle image, or a wedged `opm` extract when the bundle is large or the registry is slow [ev:c8][ev:c9]:

```bash
kubectl get pod -n cpaas-system -l job-name=<unpack-job-name>
kubectl describe pod -n cpaas-system <unpack-pod-name>
kubectl logs -n cpaas-system <unpack-pod-name>
kubectl get events -n cpaas-system --field-selector involvedObject.name=<unpack-pod-name>
```
