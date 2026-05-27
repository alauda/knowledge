---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500205
---

# Restricting create permissions on TokenReview and SubjectAccessReview APIs on ACP

## Issue

On Alauda Container Platform v4.3.13 (Kubernetes v1.34.5), the three Kubernetes review APIs — `tokenreviews.authentication.k8s.io`, `subjectaccessreviews.authorization.k8s.io`, and `localsubjectaccessreviews.authorization.k8s.io` — are shipped verbatim by kube-apiserver. `TokenReview` is the cluster-scoped, create-only API that validates an arbitrary bearer token against the cluster's authenticators; it is the only API in `authentication.k8s.io/v1` that performs arbitrary-token validation (the sibling `SelfSubjectReview` only reflects the caller's own identity). `SubjectAccessReview` is cluster-scoped and `LocalSubjectAccessReview` is namespaced; both let the caller ask "can subject U perform verb V on resource R?" and both ship alongside the safer `selfsubjectaccessreviews` / `selfsubjectrulesreviews` self-only variants.

The `system:authenticated` virtual group is attached by kube-apiserver to every successfully authenticated request, so every human user, every ServiceAccount, and every system component that authenticates against the cluster is a member of that group. Any ClusterRoleBinding that grants `create` on a review API to `system:authenticated` therefore grants that capability to every identity the cluster trusts at all, which is the security posture this article addresses.

## Root Cause

Granting `create` on `tokenreviews` to `system:authenticated` lets any authenticated identity validate arbitrary bearer tokens via the TokenReview API, which is the sole arbitrary-token validator in the cluster. Granting `create` on `subjectaccessreviews` to `system:authenticated` lets any authenticated identity probe authorization decisions for arbitrary subjects cluster-wide, and granting `create` on `localsubjectaccessreviews` extends the same probing into individual namespaces. Either grant exposes the cluster's authorization boundaries by letting any authenticated identity enumerate which subjects can perform which actions, and the same reconnaissance surface lets an attacker identify ServiceAccounts or users with elevated privileges and plan lateral movement or privilege escalation accordingly.

The same exposure can arrive by a second route: aggregation into the default `admin` ClusterRole. The `admin` ClusterRole is shipped by kube-apiserver bootstrap (label `kubernetes.io/bootstrapping=rbac-defaults`) and carries an `aggregationRule` whose `clusterRoleSelectors` match the label `rbac.authorization.k8s.io/aggregate-to-admin=true`; any ClusterRole that bears that label has its rules folded into `admin` automatically. The `admin` ClusterRole is designed for namespace-scoped resource management and is not intended as a cluster-wide security-introspection role, so aggregating review APIs into it would grant those capabilities to every subject holding `admin` in any namespace.

## Resolution

Restrict `create` on `tokenreviews` / `subjectaccessreviews` / `localsubjectaccessreviews` to system-level components and trusted controllers; do not bind those verbs to `system:authenticated`, and do not aggregate them into the default `admin` ClusterRole. On ACP v4.3.13 the default posture already conforms: none of the 11 ClusterRoleBindings bound to `system:authenticated` grant `create` on `tokenreviews`, `subjectaccessreviews`, or `localsubjectaccessreviews`; the only review-API verb reaching `system:authenticated` is `create` on `selfsubjectaccessreviews` and `selfsubjectrulesreviews` (via `system:basic-user`), which are self-only and reveal nothing about other subjects.

On the same cluster the default `admin` ClusterRole already aggregates `create` on `localsubjectaccessreviews` (via the bootstrap ClusterRole `system:aggregate-to-admin`, which bears the `aggregate-to-admin=true` label), while `tokenreviews` (cluster-scoped) and `subjectaccessreviews` (cluster-scoped) are not aggregated into `admin`. The LSAR aggregation matches the upstream Kubernetes default and is namespace-scoped by design — a holder of `admin` in namespace N can only ask LSAR questions whose `spec.resourceAttributes.namespace` equals N — so it does not provide cluster-wide reconnaissance the way an `admin`-aggregated SAR or TokenReview rule would.

The 28 ClusterRoles on the cluster that carry review-API rules are all either bootstrap roles (`system:*` and the aggregation-fed `admin`) or scoped operator roles (for example `capi-*`, `cdi-*`, `cert-manager-*`, `kubevirt-*`); none of them are bound to `system:authenticated`, which keeps the recommended posture in place by default. Preserve this posture by refusing to add new ClusterRoleBindings that grant `create` on the three review APIs to `system:authenticated`, and by refusing to attach the `rbac.authorization.k8s.io/aggregate-to-admin=true` label to any ClusterRole whose rules include `tokenreviews/create` or `subjectaccessreviews/create`.

## Diagnostic Steps

Enumerate which ClusterRoleBindings reference the `system:authenticated` group so an operator can see every ClusterRole bound cluster-wide to every authenticated identity:

```bash
kubectl get clusterrolebinding -o wide | grep system:authenticated
```

On ACP v4.3.13 the command returns 11 default ClusterRoleBindings — the upstream Kubernetes set (`system:basic-user`, `system:discovery`, `system:public-info-viewer`) plus ACP, KubeVirt, and CDI add-ons (`cpaas-*`, `productentry`, `cdi.kubevirt.io:config-reader`, `kubevirt.io:*`); the diagnostic is generic Kubernetes and runs against ACP unchanged.

Inspect whether the review APIs have been aggregated into the default `admin` ClusterRole:

```bash
kubectl get clusterrole admin -o yaml | grep -E 'tokenreviews|subjectaccessreviews'
```

On ACP v4.3.13 the effective rules of `admin` include `{authorization.k8s.io, [localsubjectaccessreviews], [create]}` only — `tokenreviews` and `subjectaccessreviews` are not aggregated into `admin`, which matches the recommended posture.

List every ClusterRole whose rules grant access to the review resources so any role that allows their creation surfaces in one pass:

```bash
kubectl get clusterroles -o yaml | grep -E 'TokenReview|SubjectAccessReview|LocalSubjectAccessReview'
```

On ACP v4.3.13 the enumerated form of this grep returns 28 ClusterRoles that carry review-API rules; all 28 are bootstrap roles or scoped operator roles, and none are bound to `system:authenticated`, so the diagnostic shape is portable to ACP and confirms the cluster's default conformance with the recommended posture.
