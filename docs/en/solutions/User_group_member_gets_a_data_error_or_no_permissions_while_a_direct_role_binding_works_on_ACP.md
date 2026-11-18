---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.2.6"
---

# User group member gets a data error or no permissions while a direct role binding works on ACP

## Issue

A user (local, synchronized from LDAP, or from a third-party identity source) is a member of a user group, and the group is bound to a platform or namespace role, including platform administrator. The user can log in but cannot do what a user with the same role bound directly can do:

- Batch delete of Pods on the container platform shows a data error and deletes nothing; the same batch delete succeeds for a local platform administrator.
- Creating a namespace, or opening one, reports insufficient permissions. Assigning the role directly to the account makes it work.
- "The user group is authorized, but the user has no permissions after logging in": any role granted through that group, including a custom namespace role, is missing.
- Users added to a group with a role association cannot open the related namespaces, while a newly created group with a role association works.
- Pipeline (Tekton) pages do not load or query for a user whose permissions come only from a group, while every other feature works for that user.

The failure is authorization through the group, not a bad password.

## Root Cause

### Cause 1: metis does not apply group authorization to batch delete

`auth-controller2` logs show the batch-delete request intercepted by a webhook, and metis validation rejects it. Metis lacks group authorization: a permission that exists on the group is not applied when metis evaluates the user. A directly bound role does not take this path. This is a platform defect; the fix is planned for 4.2.6.

### Cause 2: group role permissions do not take effect for namespace creation on 3.18 and 4.1.0

On 3.18, and on 4.1.0, permissions granted through a user group did not take effect for namespace creation. On 4.1.0 this affects LDAP users and local users in a local group alike. It is fixed starting in 4.2.

### Cause 3: the group's name does not start with `g-`

Authorization discards every permission of a group whose Kubernetes object name lacks the `g-` prefix. A group created in the web console gets a generated `g-` name; a group without the prefix was created another way, for example by applying an object with a hand-chosen name. The role content is irrelevant.

### Cause 4: the group was never actually associated with the role

A component problem while the group and its role association were first created left the role unbound, although the console showed the association. In the browser, `selfsubjectaccessreviews` returns `201` while the namespace page's requests return `403` (the namespace itself, `resourcequota`, `pod`, `workload`, `application`, `configmaps?labelSelector=features.cpaas.io%2Ftype%3DCustomResourceLimitation`, the `features` queries for `prometheus` and `victoriametrics`, and `log-agent`), and `custom-navconfig-acp` returns `404`. A new group with the role associated works, which shows the original association was never stored. The exact mechanism was not confirmed.

### Cause 5: the pipeline Hub API of Tekton operator 4.10 does not honor group bindings

The group's UserBindings are `Success` and synced to all clusters, and the user has every other feature, but the pipeline pages fail. The pipeline Hub API in Tekton operator (Alauda DevOps Pipelines) 4.10 does not support authorization through user-group bindings, so permissions granted only through a group are ignored by the pipeline pages. Directly bound roles are honored. Group authorization for pipelines needs Alauda DevOps Pipelines 4.14 or later together with Alauda Artifact Hub Shim v1.0.0, which are compatible only with platform v4.4 and v4.3.3.

## Resolution

### Cause 1: metis does not apply group authorization to batch delete

1. Upgrade to the release that contains the metis group-authorization fix (planned for 4.2.6); check the release notes of the target version.
2. Until then, bind the role directly to the affected user in Platform Management > User Management, the same way the working local account is bound, and retry the batch delete. Rollback: remove that direct binding; the group binding is unchanged.

### Cause 2: group role permissions do not take effect for namespace creation on 3.18 and 4.1.0

1. Upgrade to 4.2 or later, then create the namespace again as the group user without a direct binding.
2. While the upgrade is scheduled, a direct binding of the same role to the user also makes namespace creation succeed. Rollback: delete that direct binding.

### Cause 3: the group's name does not start with `g-`

An object name cannot be renamed, so the fix is a new group.

1. Export the old group and its bindings:

   ```bash
   kubectl get groups.auth.alauda.io
   kubectl get groups.auth.alauda.io <old-group-name> -o yaml > old-group.before.yaml
   kubectl get userbinding -o yaml > userbindings.before.yaml
   ```

2. In Platform Management > User Management, create a new user group in the web console and confirm its name starts with `g-`.
3. Import the affected users, and bind the role the old group had, with the same project or namespace scope.
4. Log in as an affected user and confirm the permissions.
5. Remove the old group.

   > **Warning:** Deleting the old group removes it and its bindings for every member; members not moved to the new group keep nothing from it (they had nothing in effect while this cause applied). Only after the new `g-` group is verified. Rollback: `kubectl apply -f old-group.before.yaml` and recreate its bindings from `userbindings.before.yaml`; a restored group still lacks the prefix.

### Cause 4: the group was never actually associated with the role

1. Save the original group's bindings so a recurrence can be compared:

   ```bash
   kubectl get userbinding -o yaml | grep -n <group-name>
   kubectl get userbinding <binding-name> -o yaml > userbinding.before.yaml
   ```

2. Create a new user group, associate the role the original group should have had, add the users, and confirm access.
3. Retire the original group after the new one is verified. If the problem reappears, collect the full `auth-controller2` log and the UserBinding YAML:

   ```bash
   kubectl get pods -A | grep auth-controller2
   kubectl logs -n <auth-controller2-namespace> <auth-controller2-pod> > auth-controller2.log
   ```

### Cause 5: the pipeline Hub API of Tekton operator 4.10 does not honor group bindings

1. Workaround: grant the role directly to each user who needs the pipeline pages, instead of only through the group. Rollback: remove the direct binding.
2. Permanent fix: upgrade Alauda DevOps Pipelines to 4.14 or later and deploy Alauda Artifact Hub Shim v1.0.0. Because these require platform v4.4 or v4.3.3, upgrade the platform first if it is on another version.

## Diagnostic Steps

1. Compare the group user with a directly bound user:

   ```bash
   kubectl auth can-i create namespaces --as=<group-user>
   kubectl auth can-i create namespaces --as=<directly-bound-user>
   kubectl auth can-i get pods -n <namespace> --as=<group-user>
   ```

   `auth can-i` answers Kubernetes RBAC only. A `yes` together with a console data error on batch delete still fits Cause 1, because metis rejects the call after RBAC.

2. Check the group name and its bindings:

   ```bash
   kubectl get groups.auth.alauda.io
   kubectl get userbinding | grep <group-name>
   kubectl get userbinding <binding-name> -o jsonpath='{.status}{"\n"}'
   ```

3. For batch delete, read the intercepting component:

   ```bash
   kubectl logs -n <auth-controller2-namespace> <auth-controller2-pod> --tail=400
   ```

| What you see | Cause |
| --- | --- |
| Batch delete data error, local user works, `auth-controller2` log shows the metis webhook, 4.x before 4.2.6 | 1 |
| Namespace creation denied for group users, direct role works, platform 3.18 or 4.1 | 2 |
| No permission at all through one group, group name lacks the `g-` prefix | 3 |
| Group name has `g-`, namespace page requests return `403` while `selfsubjectaccessreviews` returns `201`, a new group works | 4 |
| Only the pipeline pages fail for a group-only user, group UserBindings `Success`, Tekton operator 4.10 | 5 |
