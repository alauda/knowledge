---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Meaning of an Empty apiGroups Field in a Role or ClusterRole
## Overview

A common point of confusion when authoring RBAC for the first time is what the empty string means in an `apiGroups` rule:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: default
  name: pod-reader
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "watch", "list"]
```

The empty string is *not* a wildcard or a typo. It is the canonical way to refer to the Kubernetes **core API group** — the original, unnamed group that hosts the foundational resources Pods, Services, ConfigMaps, Secrets, Nodes, and so on. Understanding this distinction is the first step to writing RBAC that actually grants what was intended.

## Resolution

### Why the core group is named with an empty string

Kubernetes evolved from a single API surface served at `/api/v1` into a system of named API groups served at `/apis/<group>/<version>`. Resources that predate the named-group scheme stayed at the original path. To keep RBAC syntax uniform across both shapes, the RBAC schema requires every rule to declare an `apiGroups` field — and the literal `""` was reserved as the identifier for that legacy, path-`/api/v1` group.

So:

| Rule | Resolves to | API path |
|---|---|---|
| `apiGroups: [""]` + `resources: ["pods"]` | core/v1 Pod | `/api/v1/namespaces/<ns>/pods` |
| `apiGroups: ["apps"]` + `resources: ["deployments"]` | apps/v1 Deployment | `/apis/apps/v1/namespaces/<ns>/deployments` |
| `apiGroups: ["batch"]` + `resources: ["jobs"]` | batch/v1 Job | `/apis/batch/v1/namespaces/<ns>/jobs` |

A rule with `apiGroups: ["*"]` *is* a wildcard and grants every group; the empty string is much narrower and grants only the core group.

### What lives in the core group

The core group is small but contains the most-used resources on any cluster. Listing it explicitly makes the surface area obvious:

```bash
kubectl api-resources --api-group="" -o wide
```

Expected output (abbreviated):

```text
NAME                    SHORTNAMES   APIVERSION   NAMESPACED   KIND
bindings                             v1           true         Binding
configmaps              cm           v1           true         ConfigMap
endpoints               ep           v1           true         Endpoints
events                  ev           v1           true         Event
limitranges             limits       v1           true         LimitRange
namespaces              ns           v1           false        Namespace
nodes                   no           v1           false        Node
persistentvolumeclaims  pvc          v1           true         PersistentVolumeClaim
persistentvolumes       pv           v1           false        PersistentVolume
pods                    po           v1           true         Pod
podtemplates                         v1           true         PodTemplate
replicationcontrollers  rc           v1           true         ReplicationController
resourcequotas          quota        v1           true         ResourceQuota
secrets                              v1           true         Secret
serviceaccounts         sa           v1           true         ServiceAccount
services                svc          v1           true         Service
```

A Role that needs to also list, say, Deployments must add a second rule with `apiGroups: ["apps"]` — granting `["", "apps"]` resources `pods,deployments` does not work, because the rule is the cross-product of all three lists and there is no Pod in the `apps` group.

### Author rules group-by-group, not as a flat union

The trap most people fall into is collapsing several groups into one rule:

```yaml
# WRONG — claims to grant Deployments under the core group
rules:
  - apiGroups: ["", "apps"]
    resources: ["pods", "deployments"]
    verbs: ["get", "list"]
```

The schema accepts this, but at evaluation time the rule is interpreted as "any of these groups, any of these resources, any of these verbs". The above grants `pods` *and* `deployments` under both groups — but since Deployments do not exist in the core group and Pods do not exist in the `apps` group, half of each combination silently does nothing. It works only because the desired combinations *also* match. Fix by splitting:

```yaml
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list"]
```

This form makes intent explicit and reviews easier.

### Subresources still attach to the parent's group

`pods/log`, `pods/exec`, and `pods/status` are subresources of Pod and live in the **same** group as Pod itself — the core group. A rule that lets a service account read pod logs is therefore:

```yaml
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "list"]
```

The same convention applies to `deployments/scale` (apps), `jobs/status` (batch), etc.

## Diagnostic Steps

When an RBAC rule does not seem to grant what was intended, walk it back from the API path. `kubectl auth can-i` reports the effective decision and is faster than re-reading the YAML:

```bash
kubectl auth can-i list pods --as=system:serviceaccount:default:pod-reader -n default
kubectl auth can-i get deployments --as=system:serviceaccount:default:pod-reader -n default
```

In a stock Kubernetes cluster the first should return `yes` and the second `no` (Deployments are in `apps`, not in the core group). If the second returns `yes` on a stock cluster, the binding is broader than intended.

**On ACP this negative test does not narrow down a Role.** The platform ships a `cpaas-default-authz` ClusterRoleBinding that binds the `system:authenticated` group to a broad ClusterRole, so any authenticated subject — including every ServiceAccount — already passes most `can-i --as=` checks regardless of what the Role grants. To verify a Role actually narrows, read the rules directly (`kubectl describe role pod-reader -n default`) and walk through them by hand, or run the negative `can-i` test with a subject that is *not* `system:authenticated` (for example, an unauthenticated user or a user explicitly excluded from `cpaas-default-authz`).

For the inverse — discovering which group a given resource lives in — round-trip through `api-resources`:

```bash
kubectl api-resources | awk '$1=="deployments"'
# deployments    deploy   apps/v1   true   Deployment
```

The third column is `<group>/<version>`. Strip the version and that is the value to put in `apiGroups`. For a resource at `v1` with no slash, the group is empty — write `apiGroups: [""]`.
