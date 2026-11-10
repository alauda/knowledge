---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# LDAP user who has never logged in gets an invalid password error on the ACP login page

## Issue

A user tries to log in to the ACP console with a directory (LDAP / Active Directory) account for the first time. The account has no platform user yet, because directory users are only created in ACP when they log in or are synchronized. The login page reports that the password is invalid, although the password has been verified and works elsewhere.

Other directory users log in normally, and the user is testing from a network segment that can reach the platform. Often the organization has more than one directory domain, and the failing user belongs to a domain other than the one most users are in.

## Root Cause

The login page does not reveal whether an account exists. When the account cannot be found and when the password is wrong, the platform returns the same invalid-password error, by design: a distinct "user not found" answer would let an attacker probe for valid account names. An invalid-password error for a user whose password is known to be correct therefore usually means that the platform **cannot find the account**.

For an LDAP identity provider (IDP), ACP looks up a login account by combining the IDP's user **Filter** with an equality match on the configured **Login Field** attributes, below the user **Base DN**, in the directory server the IDP is connected to. A user who is not in that directory, is outside the Base DN, or is excluded by the Filter is never found, and the login fails with the invalid-password error. This happens, for example, when the user's accounts live in a separate directory domain whose accounts are not present in the directory the IDP queries.

## Resolution

1. Confirm which directory, Base DN and Filter the platform uses: open **Users** > **IDP** and check the LDAP IDP's server address, **Search Setting** (**Filter**, **Base DN**) and **Field Mapping** (**Login Field**).

2. Make the user reachable through that configuration. Choose what fits the directory layout:

   - Have the directory administrator make the user's account available in the directory the IDP queries, for example by synchronizing the other domain's accounts into it, so that the user is found below the configured Base DN and matches the Filter.
   - Or adjust the IDP's **Base DN** and **Filter** so that they include the user's branch, if the account is already in that directory but outside the configured search.

3. If the IDP has **Auto Sync** enabled or you synchronize manually, run the synchronization and check that the user now appears under **Users**. Otherwise, the platform user is created at the first successful login.

4. Ask the user to log in again with the same login attribute (for example `sAMAccountName` or `mail`) configured as **Login Field**.

## Diagnostic Steps

1. Read the authentication log on the `global` cluster around the failing login. Find the `apollo` pod and search its log for the username:

   ```bash
   kubectl get pod -A | grep apollo
   kubectl logs -n cpaas-system <apollo-pod> | grep -C 5 <username>
   ```

2. Query the directory with the IDP's own settings from a host whose network is equivalent to the cluster. No result means the platform cannot find the user, which explains the invalid-password error:

   ```bash
   ldapsearch -H ldap://<ldap-server>:389 -D '<bind-dn>' -W \
     -b '<user-base-dn>' '(&<user-filter>(<login-field>=<username>))' dn
   ```

   One entry returned means the account is found; then the password itself, an account lock, or the account being excluded by policy is the next thing to check.

3. Compare with a user who can log in: if that user is in a different domain or branch than the failing one, the IDP's directory or Base DN covers only the working one.

4. Rule out network reachability by testing from a segment that is known to reach the platform. A user who cannot reach the platform at all sees a connection error, not an invalid-password error.
