---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A non-admin user runs `kubectl top node` (or `kubectl top pod -A`) and receives a `Forbidden` response:

```text
Error from server (Forbidden):
  nodes.metrics.k8s.io is forbidden:
  User "alice@example.com" cannot list resource "nodes" in API group "metrics.k8s.io"
  at the cluster scope
```

The user has namespace-level permissions (they can list their own workloads, edit their own objects), but cluster-wide metrics live outside any single namespace — reading them requires a cluster-scoped read verb that the standard user role does not include. The fix is not to grant the user broad privileges; it is to grant the narrow `cluster-reader` role, which is exactly sized for this kind of read-only cluster-wide visibility.

## Root Cause

`kubectl top` reads from the `metrics.k8s.io` API group, served by metrics-server (or an equivalent aggregated API). The API is **cluster-scoped** — nodes and pod metrics live at the cluster level, not the namespace level, so listing them requires `get`/`list` permission on the respective resources at cluster scope:

- `nodes.metrics.k8s.io` — cluster-scoped; `kubectl top node` reads this.
- `pods.metrics.k8s.io` — namespaced, but `kubectl top pod -A` expects the caller to have a cluster-wide binding to list across all namespaces.

The default "namespace admin" role set grants these verbs inside a single namespace. Listing them cluster-wide — which is what `kubectl top` does by default — needs a binding that spans every namespace. `ClusterRoleBinding` with `cluster-reader` is the conventional way to express that grant without handing out edit/admin authority.

## Resolution

Bind `cluster-reader` to the user (or group) that needs cluster-wide read visibility:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cluster-reader-for-alice
subjects:
  - kind: User
    name: alice@example.com
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: cluster-reader
  apiGroup: rbac.authorization.k8s.io
```

Apply:

```bash
kubectl apply -f cluster-reader-binding.yaml
```

After the binding is in effect, the user's `kubectl top node` succeeds. The binding also grants read on most cluster-scoped objects (nodes, PersistentVolumes, CustomResourceDefinitions, etc.) — which is usually what the requesting user wants anyway for general cluster visibility.

### Group subjects for teams

If the user belongs to an identity-provider group that is mirrored into the cluster, bind to the group instead of the individual — the grant then applies automatically to every team member:

```yaml
subjects:
  - kind: Group
    name: sre-team
    apiGroup: rbac.authorization.k8s.io
```

Group bindings are also easier to audit (`kubectl get clusterrolebinding -o wide` shows the group name, not every user individually).

### ServiceAccount subjects for tooling

For a dashboard or automation component that runs inside the cluster and needs cluster-wide read:

```yaml
subjects:
  - kind: ServiceAccount
    name: dashboard-reader
    namespace: observability
```

Bind once and the service account's token carries the cluster-wide read authority for all of its API calls.

### Narrower alternative — metrics only

If the requirement is specifically `kubectl top` and not broader cluster visibility, a narrower ClusterRole granting just the metrics resources is possible:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: metrics-reader
rules:
  - apiGroups: [metrics.k8s.io]
    resources: [nodes, pods]
    verbs: [get, list]
```

Bind that ClusterRole instead of `cluster-reader`. The user can run `kubectl top` but sees no other cluster-scoped object.

Pick the narrower role when least-privilege matters and the user really does only need metrics. Otherwise `cluster-reader` is conventionally easier to reason about (it is a shipped, documented role rather than a bespoke one you need to maintain).

## Diagnostic Steps

Confirm the specific permission the caller is missing. Using `--as=<user>` probes as that user without switching contexts:

```bash
# Before the binding.
kubectl auth can-i list nodes --subresource=metrics --as=alice@example.com
kubectl auth can-i list nodes.metrics.k8s.io --as=alice@example.com
```

`no` in the output confirms the user lacks cluster-wide `list` on the metrics resource. After applying the binding:

```bash
kubectl auth can-i list nodes.metrics.k8s.io --as=alice@example.com
# yes
```

Read the effective bindings for the user to spot any other bindings that might interfere:

```bash
kubectl get clusterrolebinding -o json | \
  jq -r '.items[] | select(.subjects[]?.name == "alice@example.com") |
         "\(.metadata.name)\t\(.roleRef.kind)/\(.roleRef.name)"'
```

The new `cluster-reader-for-alice` binding should appear here, along with any other bindings that subject the same user. If an existing binding already grants broader privileges, the new binding is redundant (and you may want to narrow the existing one instead).

Verify the outcome from the user's own kubectl context (not just via `--as=`):

```bash
# As the user, in their own context.
kubectl top node
kubectl top pod -A | head
```

Both should return data within a few seconds. If metrics-server is not running or not registered as an APIService, `top` fails with a different error (`the server is currently unable to handle the request` against the metrics API) — that is an infrastructure issue, not a permissions issue, and the `cluster-reader` binding alone won't fix it.

## Note on Platform-Specific Default Bindings

Some platforms ship default ClusterRoleBindings that grant read verbs broadly to `system:authenticated`. On such clusters, `kubectl auth can-i list nodes.metrics.k8s.io --as=<any-user>` may return `yes` even before a narrow binding is applied — because the default binding already covered it. Inspect existing bindings before concluding a specific user needs a new grant:

```bash
kubectl get clusterrolebinding -o json | \
  jq -r '.items[] |
         select(.subjects[]? | .name == "system:authenticated" or .name == "system:authenticated:oauth") |
         "\(.metadata.name) -> \(.roleRef.name)"'
```

If such a binding exists and covers the metrics resources, no additional binding is needed; the user should be able to run `kubectl top` already. If they still cannot, the failure is elsewhere — inspect the metrics-server's availability as the likely culprit.
