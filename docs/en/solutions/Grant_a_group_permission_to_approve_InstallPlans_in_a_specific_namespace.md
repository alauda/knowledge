---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Grant a group permission to approve InstallPlans in a specific namespace
## Issue

Operators installed through OLM on ACP are governed by the `Subscription` / `InstallPlan` / `ClusterServiceVersion` trio from the `operators.coreos.com` API group. When a `Subscription` is created with `installPlanApproval: Manual`, each upgrade produces a fresh `InstallPlan` that stays `Pending` until a human sets `spec.approved: true`. Organisations commonly want to delegate that approval step to a specific identity group — the operator owner for a given namespace — without giving that group broader cluster-admin rights. The task is to build a least-privilege role that grants exactly the verbs needed to list, inspect, and approve `InstallPlans` in one namespace.

## Resolution

Create a namespace-scoped `Role` that only touches `installplans`, bind it to the target group, and confirm the group can approve without any additional rights. The same pattern works for a `ServiceAccount` or a named user by swapping the `subjects` entry.

1. Define a `Role` with the verbs required to read `InstallPlans` and to toggle the `approved` field. `patch` (or `update`) is what actually writes the approval; `get` / `list` / `watch` are needed so the console and CLI can surface the pending plan; keeping `approve` as an explicit verb matches the common operator-lifecycle auditing practice.

   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: Role
   metadata:
     name: installplan-approver
     namespace: <target-namespace>
   rules:
     - apiGroups: ["operators.coreos.com"]
       resources: ["installplans"]
       verbs: ["get", "list", "watch", "patch", "update"]
     - apiGroups: ["operators.coreos.com"]
       resources: ["subscriptions"]
       verbs: ["get", "list", "watch"]
   ```

   Read access on `subscriptions` is included so the approver can see which `Subscription` produced the pending plan and which upgrade target it points at.

2. Apply the `Role`:

   ```bash
   kubectl apply -f installplan-approver-role.yaml
   ```

3. Bind the role to the group responsible for operator approvals in that namespace. Replace `<approver-group>` with the actual group name coming from the cluster's identity provider (or the `system:serviceaccounts:<ns>` form for a service account).

   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: RoleBinding
   metadata:
     name: installplan-approver-binding
     namespace: <target-namespace>
   subjects:
     - kind: Group
       name: <approver-group>
       apiGroup: rbac.authorization.k8s.io
   roleRef:
     kind: Role
     name: installplan-approver
     apiGroup: rbac.authorization.k8s.io
   ```

   ```bash
   kubectl apply -f installplan-approver-rolebinding.yaml
   ```

4. To approve a pending plan, a member of the bound group lists the `InstallPlan`s in the namespace and patches the one whose `spec.approved` is still `false`:

   ```bash
   kubectl -n <target-namespace> get installplan
   kubectl -n <target-namespace> patch installplan <name> \
     --type=merge -p '{"spec":{"approved":true}}'
   ```

   OLM reconciles the plan immediately after the patch, pulls the operator bundle, and updates the `ClusterServiceVersion`.

If the same delegation is needed across several namespaces, create one `RoleBinding` per namespace referencing the same `Role` definition (repeated per namespace) — or, if the scope really is cluster-wide, a `ClusterRole` + `ClusterRoleBinding` with the same rules is the OSS-generic equivalent.

## Diagnostic Steps

1. Confirm the group resolves and the binding applies. Impersonate the approver group to verify the authorisation model works before handing it to real users:

   ```bash
   kubectl auth can-i patch installplan \
     -n <target-namespace> \
     --as=<user-name> --as-group=<approver-group>
   ```

   The answer should be `yes`. A `no` means either the `RoleBinding` has not propagated, the group name does not match the name supplied by the identity provider, or the subject identity was typed incorrectly.

2. When approval appears to succeed but the operator does not upgrade, inspect the `InstallPlan` itself — OLM records the approval transition and any subsequent reconciliation errors on the object:

   ```bash
   kubectl -n <target-namespace> get installplan <name> -o yaml \
     | sed -n '/status:/,$p'
   ```

3. Tail the OLM controller to see why a plan stays `Installing` or moves to `Failed`:

   ```bash
   kubectl -n <olm-namespace> logs deployment/catalog-operator
   kubectl -n <olm-namespace> logs deployment/olm-operator
   ```

   Permission issues on unrelated resources (CRDs, RBAC objects the operator creates on install) show up here, not on the `Role` the approver is using.

4. To audit historical approvals, the API-server audit policy for the cluster should already record `patch` verbs against `installplans`. Filter by the approver subject to reconstruct who approved which upgrade — this is the reason the `Role` is deliberately narrow: each approval event is clearly attributable.
</content>
</invoke>