---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x
---

# Project administrators lose permission to manage template repositories in Catalog after upgrading to ACP 4.3

## Issue

After the platform is upgraded to ACP 4.3, users who hold the project administrator role can no longer manage template repositories in **Catalog** > **Helm Charts**. Before the upgrade, the same users could upload new chart versions to the template repositories assigned to their project. After the upgrade, the users have no permission to manage the template repositories.

## Root Cause

### Cause 1: the acp-catalog rule of the project administrator RoleTemplate is read-only after the upgrade

Platform roles are defined by `RoleTemplate` objects on the `global` cluster. Each entry in `spec.rules` points at a `FunctionResource` through `functionResourceRef` and lists the verbs the role gets on that function. The built-in project administrator role is backed by the RoleTemplate `legacy-project-admin-system`.

ACP 4.3 changed the permissions for template repositories. After the upgrade, the `legacy-project-admin-system` rule with `functionResourceRef: acp-catalog` grants only `get`, `list`, and `watch`, which are read-only verbs, while the neighbouring management rules of the same template (for example `acp-batchaction`, `acp-imagewhitelist`, and `acp-autoscalers`) grant `"*"`. Every user bound to the project administrator role therefore loses write access to template repositories. Changing the verbs of the `acp-catalog` rule in that RoleTemplate restores the permission.

## Resolution

### Cause 1

Run these steps against the `global` cluster with a platform administrator account.

1. Save the current RoleTemplate so that you can roll back:

   ```bash
   kubectl get roletemplate legacy-project-admin-system -o yaml > legacy-project-admin-system.bak.yaml
   ```

2. Confirm the signature of this cause (see Diagnostic Steps, step 1): the `acp-catalog` rule lists only `get`, `list`, and `watch`.

3. Grant management verbs on the `acp-catalog` rule.

   > **Warning:** This changes a built-in role. Every user bound to the project administrator role, in every project, gets the new permission on template repositories as soon as the platform regenerates the role. Do it only when step 2 confirmed that the `acp-catalog` rule is read-only and project administrators are expected to manage template repositories. To roll back, edit the RoleTemplate again and set the `acp-catalog` verbs back to the values saved in `legacy-project-admin-system.bak.yaml`.

   ```bash
   kubectl edit roletemplate legacy-project-admin-system
   ```

   Find the rule for `acp-catalog` and change its verbs, for example to the same value that the neighbouring management rules use:

   ```yaml
   spec:
     rules:
       - functionResourceRef: acp-catalog
         verbs:
           - "*"
   ```

   Leave all other rules unchanged.

4. Ask an affected user to sign in again and repeat the template repository action, for example **Catalog** > **Helm Charts** > **Add Template**, select a repository assigned to the project, then **Upload Template**. The template status changes from `Uploading` to `Upload Successful`.

5. The change is made on a built-in role. After every later platform upgrade, run Diagnostic Steps, step 1 again to check that the `acp-catalog` rule still has the verbs you set.

## Diagnostic Steps

1. On the `global` cluster, list the rules of the project administrator RoleTemplate:

   ```bash
   kubectl get roletemplate legacy-project-admin-system \
     -o jsonpath='{range .spec.rules[*]}{.functionResourceRef}{" "}{.verbs}{"\n"}{end}'
   ```

   Output that matches this cause:

   ```text
   acp-catalog ["get","list","watch"]
   acp-batchaction ["*"]
   acp-imagewhitelist ["*"]
   acp-autoscalers ["*"]
   ...
   ```

   If `acp-catalog` already has `"*"` or other write verbs, the role is not the problem; continue with step 3.

2. To see which resources the `acp-catalog` function covers, read the FunctionResource:

   ```bash
   kubectl get functionresource acp-catalog -o yaml
   ```

3. Rule out the look-alike: template repositories are added by platform administrators, and a project can upload templates only to a Chart or OCI Chart repository that is assigned to it with **Management** permission. In the console, check that the repository the user is trying to manage is assigned to the user's project with that permission. A repository that is not assigned to the project, or is assigned without **Management**, is refused for every project user, whatever the role grants.

4. Check that the affected user actually holds the project administrator role in that project (platform **Role Management** or the user's role list). A user with a custom role is governed by that role's RoleTemplate, not by `legacy-project-admin-system`; inspect its `acp-catalog` rule with the command in step 1, replacing the template name.
