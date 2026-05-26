---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500150
---

# Creating Roles to manage InstallPlan approvals on ACP

## Issue

On Alauda Container Platform (kube `v1.34.5`, `marketplace` chart `v4.3.7` in `cpaas-system`), Operator Lifecycle Manager v0 emits one `InstallPlan` per `Subscription` in the Subscription's own target namespace. When a Subscription is configured with `spec.installPlanApproval: Manual`, OLM creates the `InstallPlan` in a pending state and waits for an explicit approval before applying the bundled CSV. Cluster administrators commonly need to delegate this approval step to a non-cluster-admin principal, scoped to a single operator's target namespace, without granting broader RBAC across the cluster. Because `installplans.operators.coreos.com` (v1alpha1) is a namespaced resource and InstallPlans on this cluster are observed distributed across the target namespaces of the installed Subscriptions (for example `argocd`, `kubevirt`, `istio-system`, `acp-storage`, `konveyor-tackle`, `nativestor-system`), the required permission can be expressed as a namespaced `Role` rather than a `ClusterRole` [ev:c1].

## Root Cause

The OLM `InstallPlan` CRD on this platform registers the standard set of Kubernetes verbs — `get`, `list`, `watch`, `create`, `update`, `patch`, `delete`, `deletecollection` — and does not expose a separate `approve` subresource. Approval of a pending `InstallPlan` is therefore performed by mutating the object: setting `spec.approved=true` on the existing `InstallPlan` resource, which OLM then observes and uses to proceed with the CSV install. A real `InstallPlan` reconciled on this cluster (for example `install-g2nzm` in the `kubevirt` namespace) shows the resulting `approval=Manual` / `approved=true` state once a holder of the appropriate RBAC has performed that patch [ev:c2_a]. The RBAC verb that authorizes the mutation is `patch` on `installplans` in the `operators.coreos.com` API group; listing `approve` in a `Role` alongside `patch` is accepted by the API server but is not the operative verb on this CRD [ev:c2_b].

## Resolution

Create a namespaced `Role` granting the install-plan-approval permission, then bind it with a `RoleBinding` to the Group that should hold the permission, both scoped to the operator's target namespace. The Role grants the read verbs (`get`, `list`, `watch`) for visibility plus `patch` (the operative verb that gates the approval mutation); listing `approve` alongside is harmless and matches the canonical upstream recipe. Server-side dry-run of the `Role` form below is accepted by this cluster's API server [ev:c3]:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: installplan-approver
  namespace: <operator-target-namespace>
rules:
  - apiGroups: ["operators.coreos.com"]
    resources: ["installplans"]
    verbs: ["get", "list", "watch", "approve", "patch"]
```

Bind the Role to the approver Group in the same namespace with a standard `RoleBinding` whose `subjects[].kind` is `Group`; members of that Group then hold the install-plan-approval permission only within that namespace. The `RoleBinding` form below is accepted by the cluster's API server under server-side dry-run, and the membership of the Group is supplied by the cluster's identity-provider integration [ev:c4]:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: installplan-approver
  namespace: <operator-target-namespace>
subjects:
  - kind: Group
    apiGroup: rbac.authorization.k8s.io
    name: <approver-group-name>
roleRef:
  kind: Role
  apiGroup: rbac.authorization.k8s.io
  name: installplan-approver
```

Apply both manifests with `kubectl` against the target namespace [ev:c4]:

```bash
kubectl apply -f role.yaml
kubectl apply -f rolebinding.yaml
```

A member of the bound Group can then approve a pending `InstallPlan` by patching `spec.approved=true` on the `InstallPlan` object in that namespace [ev:c2_a]:

```bash
kubectl -n <operator-target-namespace> patch installplan <installplan-name> \
  --type merge \
  -p '{"spec":{"approved":true}}'
```

## Diagnostic Steps

List the pending `InstallPlan` objects in the operator's target namespace to confirm the namespaced scope of the resource before applying the Role, and to identify the object that will be approved [ev:c1]:

```bash
kubectl -n <operator-target-namespace> get installplans.operators.coreos.com
```

Inspect the registered verbs on the `installplans` resource to confirm `patch` is the verb that gates approval on this cluster, and that no separate `approve` subresource is exposed [ev:c2_b]:

```bash
kubectl api-resources --api-group=operators.coreos.com -o wide | grep installplans
```

After binding the Group and asking a member to perform the patch, read the `InstallPlan` back and confirm `spec.approval=Manual` together with `spec.approved=true`, which is the state OLM observes to proceed with the CSV install [ev:c2_a]:

```bash
kubectl -n <operator-target-namespace> get installplan <installplan-name> \
  -o jsonpath='{.spec.approval}{"\t"}{.spec.approved}{"\n"}'
```
