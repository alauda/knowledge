---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Keep TokenReview and SubjectAccessReview Out of Broad Roles
## Issue

Cluster operators sometimes consider granting `create` on `TokenReview`, `SubjectAccessReview` (SAR), or `LocalSubjectAccessReview` (LSAR) to the `system:authenticated` group, or folding those verbs into the built-in `admin` aggregated ClusterRole, so that applications and tenants can self-check their own permissions. The request looks innocuous because the three APIs return "yes/no" answers, not data. They are not innocuous. Broad access to these verbs hands every authenticated identity a cluster-wide introspection surface against the authentication and authorization subsystems.

## Root Cause

`TokenReview`, `SubjectAccessReview`, and `LocalSubjectAccessReview` are the same building blocks the control plane itself uses to decide whether a request should proceed. They were designed for a small population of trusted callers (the aggregation API, webhook integrations, controllers that need to evaluate permissions on behalf of a user). Their inputs and outputs deliberately reveal details about the security posture of the cluster:

- `TokenReview` accepts an arbitrary bearer token and returns whether it authenticates, along with the username and group set the token resolves to. Any identity that can `create` TokenReviews can validate tokens it has obtained through other channels (leaked logs, captured headers, test fixtures) and discover the identities those tokens represent.
- `SubjectAccessReview` and its namespaced cousin accept a `(user, verb, resource)` triple and return whether the cluster's RBAC graph grants that action. A caller with `create` permission can enumerate the permission surface of any user or ServiceAccount — asking "can `system:serviceaccount:kube-system:attacker` `delete pods` in namespace `X`?" without actually attempting the action.

Taken together, these three verbs are a privilege-enumeration primitive. The built-in `admin` aggregated ClusterRole is namespace-scoped by design and must not confer cluster-wide security introspection either; aggregating review verbs into `admin` effectively promotes every project admin into a limited auditor of the control plane's auth state.

The `system:authenticated` group is similarly the wrong target: it contains every authenticated identity in the cluster — every human user, every ServiceAccount, every workload pod's token. Granting anything to this group is equivalent to granting it to an anonymous attacker who has managed to authenticate at all, which in most cluster environments is not a high bar.

## Resolution

Keep the review APIs restricted to the small set of components that legitimately need them, and use narrower RBAC for everything else.

1. **Do not bind review verbs to `system:authenticated`.** If a workload needs to self-check one specific permission, grant that workload a narrow Role covering only the verb and resource it actually needs. The review APIs are not the tool for "can this app reach its own DB ConfigMap".

2. **Do not aggregate review verbs into the default `admin` / `edit` ClusterRoles.** The aggregation labels (`rbac.authorization.k8s.io/aggregate-to-admin`) were chosen per resource intentionally; adding `tokenreviews` or `subjectaccessreviews` to that set is a platform-wide change with no namespace-scoping escape hatch.

3. **When a workload must issue reviews, give it a dedicated ServiceAccount and a purpose-built Role.** Example: a controller that reconciles per-tenant RBAC and needs to check whether a principal already has a permission before adding a binding.

   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRole
   metadata:
     name: tenant-rbac-reconciler
   rules:
     - apiGroups: ["authorization.k8s.io"]
       resources: ["subjectaccessreviews"]
       verbs: ["create"]
     - apiGroups: ["authorization.k8s.io"]
       resources: ["localsubjectaccessreviews"]
       verbs: ["create"]
   ---
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRoleBinding
   metadata:
     name: tenant-rbac-reconciler
   subjects:
     - kind: ServiceAccount
       name: tenant-rbac-reconciler
       namespace: platform-rbac
   roleRef:
     apiGroup: rbac.authorization.k8s.io
     kind: ClusterRole
     name: tenant-rbac-reconciler
   ```

   Critically, `tokenreviews.create` is *not* in this example. Most controllers should never need to validate a bearer token out-of-band; that is the job of the API server itself and of authentication webhooks that are configured through the cluster authentication layer.

4. **Keep `tokenreviews.create` to authentication-webhook components only.** If a custom authenticator needs this verb, bind it to that component's ServiceAccount and only to that ServiceAccount. Never to a group.

5. **Prefer `SelfSubjectAccessReview` / `SelfSubjectRulesReview` for the "can I do X myself" case.** These self-scoped variants are intentionally openable to `system:authenticated` and answer the common "can the current caller do X in this namespace" question without exposing anything about other identities. The `kubectl auth can-i` command uses exactly these APIs.

## Diagnostic Steps

Audit who currently holds create-level access to the review APIs. The three commands below cover the common misconfigurations:

```bash
# Bindings that land on system:authenticated — any match here on a
# ClusterRole that includes review verbs is a finding to fix.
kubectl get clusterrolebinding -o json \
  | jq -r '.items[] | select(.subjects[]? | select(.name=="system:authenticated")) | .metadata.name'

# ClusterRoles that grant create on any of the three review APIs.
kubectl get clusterrole -o json \
  | jq -r '
      .items[] | . as $cr |
      ($cr.rules // []) |
      map(select(.verbs | index("create")) |
          select(.resources[]? | test("^(tokenreviews|subjectaccessreviews|localsubjectaccessreviews)$"))) |
      select(length > 0) |
      ($cr.metadata.name)'

# Whether review verbs have been aggregated into the built-in admin role.
kubectl get clusterrole admin -o yaml \
  | grep -E 'tokenreviews|subjectaccessreviews|localsubjectaccessreviews' || echo "admin does not aggregate review verbs — good"
```

Each match produced by the first two commands should be justified against the owning component. Any hit from the third command — `admin` aggregating review verbs — should be reverted immediately; the built-in roles are meant to be treated as immutable policy.
