---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500372
---

# Flatten RoleBindings into a User-to-Role Report Using the Kubernetes API and jq on ACP

## Issue

On Alauda Container Platform (kube-apiserver `v1.34.5`, ACP v4.3.x), auditors and platform administrators frequently need a flat per-subject report that pairs every User, Group, or ServiceAccount with the Role or ClusterRole it is bound to. The native `kubectl get rolebindings` listing does not produce that join: it prints one row per RoleBinding and aggregates all subjects of a binding into shared `USERS` / `GROUPS` / `SERVICEACCOUNTS` columns, so it cannot answer "what roles does this subject hold across all namespaces" in a single pass.

The fix is to read the RBAC objects directly from the Kubernetes API on ACP and flatten the `.subjects[]` array with `jq`, taking advantage of the fact that the RBAC API (`rbac.authorization.k8s.io/v1`) is served unchanged on ACP.

## Root Cause

The shape that makes a flat report awkward to obtain from `kubectl get` is intrinsic to the RoleBinding object itself: every RoleBinding carries a `.subjects[]` array, where each element is `{kind, name}` (with an additional `namespace` for `kind: ServiceAccount`), alongside a sibling `.roleRef.name` naming the single bound Role or ClusterRole. A binding with three subjects therefore represents three (subject, role) pairs collapsed into one object, and any per-subject view must expand the array client-side.

## Resolution

Query the RBAC v1 API on ACP — the same `rbac.authorization.k8s.io/v1` group/version Kubernetes serves upstream — and post-process the JSON with `jq` and `column`.

The Bearer token is supplied in the HTTP `Authorization` header in the form `Authorization: Bearer <token>`. Obtain the API server URL from the active kubeconfig and mint a ServiceAccount token for the audit identity:

```bash
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
TOKEN=$(kubectl create token <service-account> -n <sa-namespace>)
```

The audit ServiceAccount must hold a ClusterRoleBinding that grants cluster-scope `get,list` on `namespaces` and on `rolebindings`/`clusterrolebindings` in `rbac.authorization.k8s.io`; without that RBAC the API calls below return an HTTP 403 `Status` object rather than the expected list kind. On a representative ACP cluster the example server resolves to a URL of the form `https://192.168.135.152/kubernetes/global`, and the same Bearer header pattern is accepted against that endpoint.

For a single namespace, the namespace-scoped list endpoint returns a `RoleBindingList` with an `.items[]` array:

```bash
curl -sk -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER}/apis/rbac.authorization.k8s.io/v1/namespaces/kube-system/rolebindings"
```

For a cluster-wide view, drop the namespace segment; the same kind (`RoleBindingList`) is returned, with `.items[]` carrying RoleBindings from every namespace in one response:

```bash
curl -sk -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER}/apis/rbac.authorization.k8s.io/v1/rolebindings"
```

Flatten the result into one row per (subject, role) pair with `jq`. The expression projects each subject together with its binding's `roleRef.name` and the binding's namespace, falling back to the literal string `cluster-scope` when `.metadata.namespace` is absent (as it is for ClusterRoleBindings returned by the cluster-scoped endpoint):

```bash
curl -sk -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER}/apis/rbac.authorization.k8s.io/v1/rolebindings" \
| jq -r '.items[] as $rb
         | $rb.subjects[]?
         | "\(.kind)\t\(.name)\t\($rb.roleRef.name)\t\($rb.metadata.namespace // "cluster-scope")"' \
| column -t -s $'\t'
```

The `jq` output is tab-separated, one row per (subject, role) pair, with columns `Kind`, `Name`, `roleRef.name`, and the binding's namespace. Piping through `column -t -s $'\t'` aligns the rows into a header-less, column-aligned table that is comfortable to scan in a terminal.

Subject `kind` values appearing in the flattened report are drawn from the three kinds the upstream Kubernetes RBAC schema defines — `User`, `Group`, and `ServiceAccount` — so the same projection works whether the binding targets a human identity, a group, or a workload identity.

## Diagnostic Steps

Before running the full flatten, issue a lightweight probe against `/api/v1/namespaces` to confirm that the Bearer token, the server URL, and the audit identity's RBAC are correctly wired:

```bash
curl -sk -H "Authorization: Bearer ${TOKEN}" \
  "${SERVER}/api/v1/namespaces" \
| jq '.kind, (.items | length)'
```

Interpret the response by `.kind`. For a token whose ServiceAccount is bound to a ClusterRole granting `list` on namespaces, the response is a `NamespaceList` with a positive `.items[]` length and the same `Authorization: Bearer` header pattern will succeed against the `/apis/rbac.authorization.k8s.io/v1/...` endpoints used above. A response of `kind: Status` with `code: 403` and `reason: Forbidden` instead means the token is well-formed and reaches the API server but the audit ServiceAccount lacks the required cluster-scope `list` permission — attach the prerequisite ClusterRoleBinding described in the Resolution and retry.

If the rolebindings endpoint returns an empty `.items[]` for a namespace that should contain bindings, repeat the call without the namespace segment to retrieve the cluster-wide list and verify that the expected bindings exist somewhere in the cluster. If the same endpoint instead returns a `Status` object with `code: 403`, the token lacks the cluster-scope `list` permission on `rolebindings.rbac.authorization.k8s.io`; grant it to the audit ServiceAccount before re-running the flatten.
