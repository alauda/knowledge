---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Granting a non-admin user pod log access in a namespace with RBAC

## Issue

On Alauda Container Platform (kube-apiserver v1.34.5), a non-admin user who needs to read container logs in a namespace cannot do so until their identity is granted the right Kubernetes RBAC permission. Reading container logs is gated by the `get` verb on the `pods/log` subresource of the core API group (`pods` is the namespaced `v1` resource), so an identity without that verb on `pods/log` is not authorized to fetch logs.

## Root Cause

Log reads are a distinct, subresource-scoped permission rather than a side effect of being able to list pods. The action that retrieves container output is `get` on `pods/log` in the core API group. Under the RBAC model, access is deny-by-default and additive: a subject is granted log access only by a binding that confers `get` on `pods/log`, so an identity that holds no such grant is not granted log access.

## Resolution

There are two practical paths, trading convenience against least privilege. **Quick option — bind the built-in `view` ClusterRole.** The bootstrap-default `view` ClusterRole already carries the relevant permission: it grants `get`, `list`, and `watch` on the `pods/log` subresource of the core API group, alongside its other read verbs (the role is labeled as a Kubernetes RBAC bootstrap default). Granting a non-admin user log access therefore reduces to binding this existing ClusterRole to that user within the target namespace. Note, however, that `view` confers broad namespaced read access — `get`/`list`/`watch` across a wide set of core read resources (events, limit ranges, pods/status, resource quotas, and more), not log access alone. Binding `view` to read logs over-grants read on nearly every namespaced resource in that namespace.

**Least-privilege alternative — a minimal custom Role.** When log-viewing is the only intent, define a namespaced Role that grants exactly `get`/`list` on `pods` and `get` on the verified `pods/log` subresource, then bind it. This keeps the grant to what log viewing actually requires instead of the broad read surface that `view` exposes. The remainder of this section uses the `view` binding for brevity; substitute a `roleRef` of kind `Role` pointing at the minimal Role to apply the least-privilege form.

A RoleBinding confers the permissions of a referenced ClusterRole on its subject, scoped to the RoleBinding's own namespace — the ClusterRole supplies the permission set, while the RoleBinding limits where it applies. The manifest follows the standard RBAC shape: `apiVersion: rbac.authorization.k8s.io/v1`, `kind: RoleBinding`, a `roleRef` of kind `ClusterRole` referencing the global role by name, and a `subjects` entry of kind `User` (the `name` is required, and the `apiGroup` for a User is `rbac.authorization.k8s.io`).

Create the RoleBinding in the namespace where log access is needed, referencing the `view` ClusterRole and the target user:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: log-viewer
  namespace: team-a
subjects:
- kind: User
  name: jane
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: view
  apiGroup: rbac.authorization.k8s.io
```

Apply it with kubectl:

```bash
kubectl apply -f log-viewer-rolebinding.yaml
```

Because a RoleBinding's grant is namespace-scoped, this binding authorizes the user to read pod logs only in the namespace it lives in; a user who needs log access across several namespaces requires a separate RoleBinding in each of those namespaces. The same RoleBinding-to-ClusterRole pattern is how an in-cluster RoleBinding scopes a global ClusterRole down to a single namespace.

## Diagnostic Steps

Confirm the binding exists and references the intended ClusterRole and subject in the target namespace:

```bash
kubectl get rolebinding -n team-a log-viewer -o yaml
```

The output should show `roleRef.kind: ClusterRole` with `name: view` and the expected `subjects` entry of kind `User`, all within the namespace the binding was created in. To extend the grant to additional namespaces, repeat the RoleBinding in each one, since the authorization does not span namespaces from a single binding.
