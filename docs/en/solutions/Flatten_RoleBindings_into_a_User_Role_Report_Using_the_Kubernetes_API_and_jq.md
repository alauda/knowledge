---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Listing "who has which role where" on a cluster is surprisingly hard through the default CLI: `kubectl get rolebindings` prints `RoleBinding` objects, but each object packs a list of subjects and a single roleRef together — so a 1-to-many binding between a single role and several users appears as one row, not the per-subject rows an audit usually wants. The same limitation applies at the cluster-scope with `kubectl get clusterrolebindings`.

The audit question operators actually want to answer is, for every user or group or service-account on the cluster: *"Which roles does this principal hold, in which scope?"* — a flattened, per-subject view that is easy to grep, paste into a ticket, or compare against a compliance baseline.

## Resolution

Query the `rbac.authorization.k8s.io/v1` API directly and flatten the `RoleBinding` / `ClusterRoleBinding` objects with `jq`. Two queries suffice — one for namespaced bindings, one for cluster-scoped.

### Capture credentials

The `kubectl` context already carries the credentials needed. Capture them for the `curl`-based queries below:

```bash
TOKEN=$(kubectl config view --raw -o jsonpath='{.users[?(@.name == "'"$(kubectl config current-context | xargs kubectl config get-contexts -o name | head -1)"'")].user.token}')
# Fallback if the context does not store a token: extract from the serviceaccount secret.
API_URL=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
```

Alternatively, if the session uses a token-based CLI (`kubectl` from a ServiceAccount context, `virtctl`, etc.), the tokens are directly exposable through the client. Use whichever path yields a valid bearer token for the API server.

### Query 1 — namespaced RoleBindings

For a single namespace:

```bash
NS=<target-namespace>
curl -sSk -H "Authorization: Bearer $TOKEN" \
          -H "Accept: application/json" \
          "$API_URL/apis/rbac.authorization.k8s.io/v1/namespaces/$NS/rolebindings" | \
  jq -r '.items[] as $rb
         | $rb.subjects[]?
         | "\(.kind)\t\(.name)\t\($rb.roleRef.name)\t\($rb.metadata.namespace // "cluster-scope")"' | \
  column -t -s $'\t' | head -30
```

Example output:

```text
Kind            Name                            RoleBinding        Namespace
User            alice                           admin              test-ns
User            bob                             admin              test-ns
User            bob                             edit               test-ns
ServiceAccount  deployer                        system:deployer    test-ns
ServiceAccount  builder                         system:image-builder test-ns
Group           system:serviceaccounts:test-ns  system:image-puller test-ns
User            alice                           view               test-ns
Group           dev-group                       view               test-ns
```

Each row is one subject × one role, which is the shape most audits expect.

### Query 2 — cluster-scoped RoleBindings

Drop the namespace path from the URL to enumerate cluster-wide:

```bash
curl -sSk -H "Authorization: Bearer $TOKEN" \
          -H "Accept: application/json" \
          "$API_URL/apis/rbac.authorization.k8s.io/v1/rolebindings" | \
  jq -r '.items[] as $rb
         | $rb.subjects[]?
         | "\(.kind)\t\(.name)\t\($rb.roleRef.name)\t\($rb.metadata.namespace // "cluster-scope")"' | \
  column -t -s $'\t'
```

The same jq expression flattens the result; the `metadata.namespace // "cluster-scope"` fallback ensures cluster-scoped bindings render as `cluster-scope` rather than blank.

### Query 3 — ClusterRoleBindings (no namespace at all)

For the cluster-scope bindings that sit entirely outside any namespace:

```bash
curl -sSk -H "Authorization: Bearer $TOKEN" \
          -H "Accept: application/json" \
          "$API_URL/apis/rbac.authorization.k8s.io/v1/clusterrolebindings" | \
  jq -r '.items[] as $rb
         | $rb.subjects[]?
         | "\(.kind)\t\(.name)\t\($rb.roleRef.name)\tcluster-scope"' | \
  column -t -s $'\t'
```

These are the most security-relevant — they grant role verbs across every namespace. Audit these first before drilling into namespaced bindings.

### Combine: one user's complete role footprint

To answer "what can Alice do anywhere on the cluster?", run both queries and filter by the user's name:

```bash
USER_NAME=alice@example.com
(
  curl -sSk -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
    "$API_URL/apis/rbac.authorization.k8s.io/v1/rolebindings" | \
    jq -r --arg u "$USER_NAME" '.items[] as $rb | $rb.subjects[]?
           | select(.kind=="User" and .name == $u)
           | "\($rb.roleRef.kind)\t\($rb.roleRef.name)\t\($rb.metadata.namespace)"'
  curl -sSk -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
    "$API_URL/apis/rbac.authorization.k8s.io/v1/clusterrolebindings" | \
    jq -r --arg u "$USER_NAME" '.items[] as $rb | $rb.subjects[]?
           | select(.kind=="User" and .name == $u)
           | "\($rb.roleRef.kind)\t\($rb.roleRef.name)\tcluster-scope"'
) | column -t -s $'\t' | sort
```

The output is every role (Role or ClusterRole) Alice holds, in every namespace where the binding applies.

### Combine: find bindings for a specific Group

Identity-provider-sourced groups often carry privileges. Filter by `Group`:

```bash
GROUP_NAME=sre-team
curl -sSk -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  "$API_URL/apis/rbac.authorization.k8s.io/v1/clusterrolebindings" | \
  jq -r --arg g "$GROUP_NAME" '.items[] as $rb | $rb.subjects[]?
         | select(.kind=="Group" and .name == $g)
         | "\($rb.roleRef.name)"' | sort -u
```

### Using `kubectl` without `curl`

If `curl` is not convenient (or an authentication helper is tricky), the same queries go through `kubectl` directly:

```bash
kubectl get rolebinding -A -o json | \
  jq -r '.items[] as $rb | $rb.subjects[]?
         | "\(.kind)\t\(.name)\t\($rb.roleRef.name)\t\($rb.metadata.namespace // "cluster-scope")"' | \
  column -t -s $'\t'

kubectl get clusterrolebinding -o json | \
  jq -r '.items[] as $rb | $rb.subjects[]?
         | "\(.kind)\t\(.name)\t\($rb.roleRef.name)\tcluster-scope"' | \
  column -t -s $'\t'
```

The output is the same. `kubectl` uses the current kubeconfig's credentials automatically.

## Diagnostic Steps

Check API-server reachability and token validity before running a long query:

```bash
kubectl get nodes
curl -sSk -H "Authorization: Bearer $TOKEN" "$API_URL/api/v1/namespaces" | jq '.kind'
# NamespaceList
```

A successful response from both confirms the environment is ready.

Confirm `jq` is available and recent:

```bash
jq --version
# jq-1.6 or later recommended
```

Run a small sanity query first to validate the jq expression works against the cluster's binding shape:

```bash
kubectl get rolebinding -A -o json | \
  jq -r '.items | length'
```

A numeric result equal to the expected number of bindings tells you the pipeline is intact. Then expand to the full flattening expressions above.

For large clusters (many thousands of bindings), consider running the query during off-hours — the full list can be substantial, and API-server load from a single `-A` call on `rolebindings` is non-trivial. Consider paginating with `limit=500&continue=...` if the response is truncated.
