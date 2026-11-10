---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.4
---

# Built-in admin username cannot be renamed: disable admin after creating another platform administrator on ACP

## Issue

A security compliance assessment flags the platform's default `admin` account as a high-risk item (for example "the system has an admin account"), and asks for the default account to be renamed or removed. Administrators look for a way to change the login username of `admin`:

- In the console, the user details and the personal center only allow changing the **display name** (and the password), not the username.
- The product documentation describes the platform administrator created at deployment as a system account that cannot be managed through user management, and has no procedure for renaming it.

## Root Cause

The login username of the local platform administrator created at deployment (`admin`) cannot be changed, either in the console or in the backend. The console only supports changing a user's display name.

The `User` resource (`auth.alauda.io/v1`) of each user has a boolean `spec.is_disabled` field. Setting it to `true` on the `admin` user disables that account, which removes the default account from use without renaming it.

## Resolution

The supported workaround is to create a replacement platform administrator and then disable `admin`.

1. Create a new local user with a non-default username in the console and grant it the platform administrator role.

2. Log out, log in with the new user, and confirm it has full platform administration access. Keep this session open until step 4 is verified.

3. On a control plane node of the `global` cluster, find the `User` resource of `admin`. Its resource name is a hash, not the username:

   ```bash
   kubectl get users.auth.alauda.io | grep admin
   kubectl get users.auth.alauda.io <user-resource-name> -o jsonpath='{.spec.username}  is_admin={.spec.is_admin}{"\n"}'
   ```

   Expected: `admin  is_admin=true`.

4. Disable the account.

   > **Warning:** After this step nobody can log in to the console as `admin`. Run it only after step 2 confirms that the new platform administrator can log in and manage the platform, otherwise you can lock yourself out of the console. Check first that no script or integration still logs in as `admin`. To roll back, set `is_disabled` back to `false` (or remove it) on the same resource from a `global` control plane node with `kubectl`.

   ```bash
   kubectl edit users.auth.alauda.io <user-resource-name>
   ```

   Add the field under `spec`:

   ```yaml
   spec:
     is_disabled: true
   ```

5. Open a new private browser window and confirm that logging in as `admin` is refused while the new administrator still works.

## Diagnostic Steps

1. Confirm which account the assessment refers to: the local `admin` user created at deployment has `spec.username: admin` and `spec.is_admin: true`:

   ```bash
   kubectl get users.auth.alauda.io -o custom-columns='NAME:.metadata.name,USERNAME:.spec.username,ADMIN:.spec.is_admin,DISABLED:.spec.is_disabled'
   ```

2. After the change, the same command shows `DISABLED` = `true` for `admin` and the new administrator listed with `ADMIN` = `true`.
