---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A non-admin user opens the ACP console, navigates to **Observe → Logs** inside a namespace they own, and sees a `Forbidden: Missing permissions to get logs` error instead of their application's logs. The user is already a namespace admin (they can see pods, apply manifests, edit their workloads) — but log retrieval from the cluster's logging stack is gated by a separate RBAC check that their namespace role does not cover.

Reading logs through the console hits the logging stack's read API, not the kubelet's `/logs` endpoint. That path requires the caller to hold a verb on a Custom Resource type owned by the logging operator, and that verb is not granted by the default namespace `edit` / `admin` roles.

## Root Cause

ACP's logging service exposes application logs through a read API that is authorized at the namespace level via a dedicated `ClusterRole` shipped by the logging operator — typically named `cluster-logging-application-view`. The role grants `get` / `list` on the virtual resource that the console queries when it renders the log panel.

Without that role bound to the subject in the target namespace, the console's API call to the logging backend returns 403, which the UI surfaces as "Missing permissions to get logs". The user's existing namespace-level bindings are irrelevant to this specific path because the underlying resource (the virtual log stream) is not a namespaced Kubernetes object — it is a backend the logging operator registers on top of namespaces.

## Resolution

Bind the `cluster-logging-application-view` ClusterRole to the user inside the namespace they need log access for. A `RoleBinding` (not a `ClusterRoleBinding`) is the right shape: it reuses the ClusterRole's rule set but scopes the grant to a single namespace.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: view-application-logs
  namespace: <target-namespace>
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-logging-application-view
subjects:
  - kind: User
    name: <username>
    apiGroup: rbac.authorization.k8s.io
```

Replace `<target-namespace>` with the namespace whose logs the user should see and `<username>` with the user's identity as it appears in the cluster's authentication layer (same identifier the console shows under the user menu).

Apply:

```bash
kubectl apply -f view-application-logs.yaml
```

The user refreshes the console; **Observe → Logs** in that namespace now loads successfully.

### Multiple namespaces

The binding is namespace-scoped. For a user who needs log access across several namespaces, create one `RoleBinding` per namespace — all referencing the same `cluster-logging-application-view` ClusterRole. Driving this through a small loop keeps the bindings consistent:

```bash
for ns in ns-a ns-b ns-c; do
  kubectl -n "$ns" apply -f - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: view-application-logs
  namespace: $ns
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-logging-application-view
subjects:
  - kind: User
    name: <username>
    apiGroup: rbac.authorization.k8s.io
EOF
done
```

### Subject variations

- **Group subjects** (common when users come from an external IdP that maps groups) replace the `kind: User` block with `kind: Group, name: <group>, apiGroup: rbac.authorization.k8s.io`. A group binding covers every user in that group for the lifetime of the group membership.
- **ServiceAccount subjects** use `kind: ServiceAccount, name: <sa>, namespace: <sa-ns>` (no `apiGroup`). Useful when the "reader" is tooling running in-cluster.

### Precondition: the ClusterRole must exist

The `cluster-logging-application-view` ClusterRole is created by the logging operator when it installs. If the operator is not installed on the cluster, the ClusterRole does not exist and the RoleBinding will fail to reconcile (the apiserver accepts the binding, but evaluating it resolves no rules):

```bash
kubectl get clusterrole cluster-logging-application-view
```

If this command returns `NotFound`, install / verify the logging service operator first; the log-viewing RBAC surface is owned by the operator, not by the cluster's core RBAC set.

## Diagnostic Steps

Confirm the RoleBinding is in effect and that the subject matches the actual caller identity:

```bash
kubectl -n <target-namespace> get rolebinding view-application-logs -o yaml
kubectl -n <target-namespace> describe rolebinding view-application-logs
```

The `subjects` list in the output is what the API server will match against the authenticated caller. A typo in the username is the most common cause of the RoleBinding looking correct on paper but not taking effect.

Resolve the caller's identity by asking the cluster what the authenticated session looks like (run from the affected user's kubectl context):

```bash
kubectl auth whoami -o json
```

Compare the `username` field with the `subjects[].name` in the binding. Group claims (if the user comes in through a group) appear in the `groups` array and require a Group-kind subject.

Test the specific permission the console exercises:

```bash
kubectl auth can-i get \
  --as=<username> --namespace=<target-namespace> \
  logs.observability.alauda.io
```

(Adjust the resource name to whatever the logging service registers on the cluster; `kubectl api-resources` will show the exact name and group.) A response of `yes` means the binding is good; the console's 403 would then be coming from elsewhere — check that the console itself is pointing at the intended logging backend and that backend is healthy.

If the response is `no` despite the RoleBinding existing, the ClusterRole probably does not grant `get` on the specific resource the console expects. Inspect the rules:

```bash
kubectl get clusterrole cluster-logging-application-view -o yaml
```

The role should include a rule with `verbs: [get, list]` against the resource name the console is querying. If the resource name has changed between logging operator versions, the binding may need to reference a different ClusterRole that matches the current API surface.
