---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500679
---

# Installing a Kubernetes operator on ACP without going through OLM

## Overview

An operator on Alauda Container Platform is structurally the same upstream-Kubernetes pattern it is anywhere else: a controller pod (typically an `apps/v1` `Deployment`) reconciling custom resources whose schema is declared by an `apiextensions.k8s.io/v1` `CustomResourceDefinition`. CRDs are cluster-scoped objects (`NAMESPACED=false`) and their `spec.scope` field — `Cluster` or `Namespaced` — governs the scope of the custom-resource instances they define, not the CRD itself. OLM (`operators.coreos.com` — `Subscription`, `OperatorGroup`, `ClusterServiceVersion`, `InstallPlan`, `CatalogSource`) is a packaging and lifecycle layer that sits on top of this pattern, not a prerequisite for it; ACP ships the OLM API group alongside its `OperatorBundle` and `ModulePlugin` distribution channels, and the bare-Kubernetes primitives the operator pattern uses are admissible to the apiserver whether OLM is the producer or `kubectl apply` is.

This article covers when and how to install an operator on ACP by applying its raw manifests directly, what that buys, and what lifecycle responsibilities the operator owner takes on by skipping OLM.

## Issue

The standard ACP install path for an operator is one of two managed channels: an `OperatorBundle` published through the cluster's `CatalogSource`, consumed via an OLM `Subscription` (the same `operators.coreos.com/v1alpha1` shape OLM uses upstream), or a `ModulePlugin` materialized as a `ClusterPluginInstance` by the cpins/cluster-transformer toolchain. Both produce a running controller `Deployment`, the CRDs it watches, and the RBAC it needs.

There are situations where neither managed channel fits — the vendor ships only raw manifests (no `ClusterServiceVersion` bundle, no `ModulePlugin` package), an operator is being tested off-catalog, or the operator's RBAC or watch namespaces need to be shaped in ways the catalog packaging does not parameterize. In those situations the operator can be installed by applying its CRDs, `ServiceAccount`, `ClusterRole`, `ClusterRoleBinding`, and `Deployment` directly with `kubectl`, with no `Subscription`, `OperatorGroup`, or `ClusterServiceVersion` created.

## Root Cause

OLM's job is to take a CSV bundle from a catalog and turn it into the same set of cluster objects the operator's controller pod needs — a `Deployment`, the CRDs, and the RBAC bindings. The kube-apiserver does not distinguish those objects by who created them: an `apps/v1` `Deployment`, an `apiextensions.k8s.io/v1` `CustomResourceDefinition`, and an `rbac.authorization.k8s.io/v1` `ClusterRole`/`ClusterRoleBinding` are first-class API resources on ACP regardless of whether an OLM CSV reconciler or `kubectl apply -f` produced them. The OLM-less direct-install path is therefore a question of whether the operator vendor publishes raw manifests; the cluster itself is agnostic.

If the vendor only ships OLM-shaped artifacts (a CSV bundle plus catalog index, with no standalone `operator.yaml` and RBAC), there is no vendor-supported OLM-less install for that operator — the user would have to extract the embedded `Deployment` and RBAC out of the CSV by hand to get equivalent raw manifests, and would be on their own for upgrades.

## Resolution

To install an operator without OLM on ACP, apply the raw artifacts the operator's controller pod needs, in the order CRDs → namespace + ServiceAccount → ClusterRole + ClusterRoleBinding (and namespaced Role/RoleBinding if the operator uses leader election or a watch-namespace lock) → Deployment. The minimum set, against the standard kube primitives:

- `apiextensions.k8s.io/v1 CustomResourceDefinition` for every API group the controller reconciles (cluster-scoped object).
- `v1 ServiceAccount` in the operator's install namespace.
- `rbac.authorization.k8s.io/v1 ClusterRole` granting the verbs the controller needs against the CRDs (and any built-in API groups it touches), plus a matching `ClusterRoleBinding` to the `ServiceAccount`.
- Optionally a namespaced `Role`/`RoleBinding` for leader-election leases or webhook-config writes scoped to the operator's namespace.
- `apps/v1 Deployment` for the controller pod, with `serviceAccountName` pointing at the SA above.

Confirm the supporting primitives are registered on the target cluster:

```bash
kubectl api-resources --api-group=apiextensions.k8s.io
kubectl api-resources --api-group=rbac.authorization.k8s.io
kubectl api-resources -o wide | grep -E '^(deployments|serviceaccounts)\s'
```

Apply the manifests with namespace ordering preserved (CRDs first so the apiserver can admit any `CustomResource` the operator immediately creates; RBAC before the `Deployment` so the controller pod's first reconcile loop already has permission):

```bash
kubectl apply -f crds/
kubectl create namespace <operator-ns>
kubectl apply -n <operator-ns> -f service_account.yaml
kubectl apply -f cluster_role.yaml
kubectl apply -f cluster_role_binding.yaml
kubectl apply -n <operator-ns> -f operator.yaml
```

If the controller does leader election or owns webhook configurations scoped to its install namespace, also apply the namespaced role pair:

```bash
kubectl apply -n <operator-ns> -f election_role.yaml
kubectl apply -n <operator-ns> -f election_role_binding.yaml
```

To configure the watch scope, set the operator's `WATCH_NAMESPACE` environment variable on its `Deployment` — an empty string means cluster-wide, a namespace name (or comma-separated list, where the controller supports it) restricts the reconciler:

```bash
kubectl set env -n <operator-ns> deployment/<operator-deploy> WATCH_NAMESPACE=""
```

When the vendor's installer is a shell script that wraps these same `kubectl create -f` calls, read it before running — confirm it does not also try to create `Subscription` or `OperatorGroup` resources, and adjust the namespace substitution to land in the ACP namespace chosen for the install.

### Lifecycle responsibility moves to the operator owner

Skipping OLM means none of the OLM lifecycle facets exist for this operator on the cluster — no `Subscription`, no `installPlanApproval` knob, no channel pinning, no CSV-recorded `replaces` chain, no `InstallPlan`-driven dependency resolution. The contrast is visible on any operator installed through the managed path:

```bash
kubectl -n <ns> get subscription <name> \
  -o jsonpath='{.spec.channel}{"\t"}{.spec.installPlanApproval}{"\n"}'
kubectl -n <ns> get csv \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.replaces}{"\t"}{.status.phase}{"\n"}{end}'
```

For the OLM-less install, upgrades are a re-apply of a newer set of raw manifests (CRDs and `Deployment` image at minimum, RBAC diffs where the upgrade adds verbs), version pinning is a property of whatever manifest set is checked into the cluster's source-of-truth, and there is no platform-side conflict detection against other operators that claim the same CRDs or webhook configurations.

## Diagnostic Steps

Verify the CRDs the operator owns are registered and that `spec.scope` matches what the operator expects:

```bash
kubectl get crd | grep <api-group>
kubectl get crd <crd-name> \
  -o jsonpath='{.spec.scope}{"\n"}'
```

Inspect the controller `Deployment` and confirm it is using the `ServiceAccount` the RBAC bindings refer to:

```bash
kubectl -n <operator-ns> get deploy <operator-deploy> \
  -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'
kubectl -n <operator-ns> get deploy <operator-deploy> \
  -o jsonpath='{.spec.template.spec.containers[*].env}{"\n"}'
```

Confirm RBAC bindings reach the right SA across namespaces (a common OLM-less misstep is a `ClusterRoleBinding` whose subject namespace does not match the install namespace):

```bash
kubectl get clusterrolebinding <crb-name> \
  -o jsonpath='{range .subjects[*]}{.kind}/{.namespace}/{.name}{"\n"}{end}'
```

Confirm the controller pod is reconciling — first by status, then by reading its log for permission errors that point at a missing rule in the `ClusterRole`:

```bash
kubectl -n <operator-ns> get pods -l <selector>
kubectl -n <operator-ns> logs deploy/<operator-deploy> --tail=200 \
  | grep -iE 'forbidden|cannot list|cannot watch|cannot create'
```

If a permission error names a verb/resource pair, add it to the `ClusterRole` and re-apply; the controller picks it up at the next reconcile.

For OLM-installed operators living on the same cluster, the corresponding lifecycle objects are still visible at:

```bash
kubectl api-resources --api-group=operators.coreos.com
kubectl get subscriptions -A
kubectl get csv -A
```

— useful when distinguishing which operators on a given cluster are OLM-managed and which were installed directly.
