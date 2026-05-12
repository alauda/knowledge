---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
---

# How to Manage Dangerous Redis Commands

## Introduction

This guide describes how to enable or disable dangerous Redis commands (such as `flushall`, `flushdb`, `keys`) on Alauda Cache Service for Redis OSS.

:::info For users on the current operator (3.18+)
Use **Method 1 (ACL Rules)** exclusively. The operator ships Redis 6.0+ where ACL is the canonical mechanism. Methods 2–4 are documented only for completeness on legacy operators (`<= 3.16`) and are not relevant to current deployments.
:::

## Method 1: Configure via ACL Rules (Recommended)

:::info Applicable versions
- Operator: `>= 3.15`
- Redis: `>= 6.0`
- Architectures: Sentinel, Cluster
:::

Starting from operator version 3.15, Redis user management is supported (Redis 6.0+ only). For Redis versions below 6.0, use [Method 3: Configure via Standard Parameters](#method-3-configure-via-standard-parameters-rename-command).

By default, dangerous commands are disabled for the `default` user. You can customize ACL rules through **Instance** > **User Management** to enable or disable command permissions.

### Default User Permissions

```text
# Redis 6.0 default user permissions
+@all -acl -flushall -flushdb -keys ~*

# Redis 7.0 default user permissions
+@all -acl -flushall -flushdb -keys ~* &*
```

### ACL Rule Reference

| Rule | Meaning |
|------|---------|
| `+@all` | Enable all commands |
| `-@all` | Disable all commands |
| `-acl` | Disable the `acl` command. The operator enforces this rule and it cannot be removed. |
| `-flushall`, `-flushdb`, `-keys` | Disable the corresponding commands |
| `~*` | Allow operations on all keys (`*` is a glob wildcard, e.g. `~test*` allows access to keys with the `test` prefix) |
| `&*` | Allow operations on all Pub/Sub channels |

To enable a specific command (for example, `keys`), remove the `-keys` entry from the ACL rule.

### Rule Order Matters

The order of ACL directives matters. The following rule grants access to **all** commands, including `flushall` and `flushdb`, because `+@all` overrides the earlier deny rules:

```text
-flushall -flushdb +@all ~*
```

To correctly disable specific commands, place the deny rules **after** the allow rules:

```text
+@all ~* -flushall -flushdb
```

For more details, see the [Redis ACL community documentation](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/#acl-rules).

---

## Legacy Methods (operator `<= 3.16`)

The methods below are kept for users still running legacy operator releases. **Skip this section if you are on operator `3.18+`.**

## Method 2: Run Dangerous Commands Temporarily as `operator`

:::info Applicable versions
- Operator: `>= 3.12.1` and `< 3.18` (the `/account/password` file was removed in 3.18)
- Sentinel/Cluster mode requires operator `>= 3.15`
- Redis: `>= 6.0`
:::

When dangerous commands are disabled for the `default` user, the built-in `operator` account can be used for one-off administrative tasks (for example, data migration or cleanup):

```bash
# Enter the redis-cli interactive shell as the operator user
redis-cli -a $(cat /account/password) --user operator
```

:::warning
The `operator` user has full privileges and can execute any command. Use it only for explicitly required administrative tasks.
:::

## Method 3: Configure via Standard Parameters (`rename-command`)

:::info Applicable versions
- Operator: `> 3.10.3` and `<= 3.15`
- Architectures: Sentinel, Cluster
:::

In this version range, `flushall` and `flushdb` are disabled by default. Additional commands can be disabled or renamed by configuring the `rename-command` parameter.

### Disable or Rename Commands

| Action | Key | Value | Description |
|--------|-----|-------|-------------|
| Disable a command | `rename-command` | `set ""` | Disables the `set` command |
| Rename a command | `rename-command` | `set abc123` | Renames `set` to `abc123` |
| Combined configuration | `rename-command` | `flushall flushall debug abc123 set ""` | (1) Restores `flushall`, (2) renames `debug` to `abc123`, (3) disables `set` |

:::warning
Modifying the `rename-command` parameter triggers an instance restart.
:::

### Re-enable a Built-In Disabled Command

To restore an originally disabled command (for example, `flushall`), rename the command to itself:

| Action | Key | Value | Description |
|--------|-----|-------|-------------|
| Re-enable `flushall` | `rename-command` | `flushall flushall` | Renames `flushall` to `flushall`, overriding the built-in disable |

### Workaround for Operator 3.14.0 / 3.14.1 Bug (Redis 6.0)

:::warning Known issue
Operator versions **3.14.0** and **3.14.1** have a bug where `rename-command` configuration changes do not take effect for Redis 6.0 instances.
:::

Apply the following manual fix:

1. Edit the instance ACL ConfigMap:

   ```bash
   kubectl -n <namespace> edit cm drc-acl-<instance-name>
   ```

2. The ConfigMap content looks like this:

   ```yaml
   apiVersion: v1
   data:
     default: '{"name":"default","role":"Developer","password":{"secretName":"redis-c6-6sd7v"},"rules":[{"categories":["all"],"disallowedCommands":["flushall","flushdb"],"keyPatterns":["*"]}]}'
     operator: '{"name":"operator","role":"Operator","password":{"secretName":"drc-acl-c6-operator-secret"},"rules":[{"categories":["all"],"disallowedCommands":["keys"],"keyPatterns":["*"]}]}'
   kind: ConfigMap
   metadata:
     name: drc-acl-<instance-name>
   ```

3. Modify the `disallowedCommands` array in the `default` entry. For example, to remove the `flushall` restriction and add `debug`:

   ```yaml
   apiVersion: v1
   data:
     default: '{"name":"default","role":"Developer","password":{"secretName":"redis-c6-6sd7v"},"rules":[{"categories":["all"],"disallowedCommands":["debug","flushdb"],"keyPatterns":["*"]}]}'
     operator: '{"name":"operator","role":"Operator","password":{"secretName":"drc-acl-c6-operator-secret"},"rules":[{"categories":["all"],"disallowedCommands":["keys"],"keyPatterns":["*"]}]}'
   kind: ConfigMap
   metadata:
     name: drc-acl-<instance-name>
   ```

4. Update the `rename-command` parameter in the instance configuration to trigger an instance restart.
5. Wait for the restart to complete. The new ACL rules will take effect.

## Method 4: Legacy YAML Configuration

:::info Applicable versions
- Operator: `> 3.8.2` and `<= 3.10.2`
- Architectures: Sentinel, Cluster
:::

### Cluster Mode

Disabling dangerous commands is only supported through the proxy. When clients connect via the Redis proxy, commands such as `flushall` and `keys *` are automatically blocked.

### Sentinel Mode

1. Create a new Sentinel instance via the `Redis` CR (`apiVersion: middleware.alauda.io/v1`, `arch: sentinel`).
2. Add the `customCommandRenames` field to rename `flushall`, `keys`, and other commands.
3. Edit the corresponding Sentinel ConfigMap (`rfs-<instance-name>`) to set the `rename-command` directives.
4. Restart the instance for the configuration to take effect.

### Verification

After restarting, connect to the instance and confirm that the renamed or disabled commands are no longer accessible.

## Important Considerations

- Always use **Method 1 (ACL rules)** when running operator 3.15+ with Redis 6.0+. ACL provides finer-grained control and does not require an instance restart for most rule changes.
- Modifying `rename-command` triggers an instance restart. Plan changes during a maintenance window.
- The order of ACL rules is significant. Always place deny rules after the broad allow rule.
- The `operator` user is privileged. Restrict its credentials to authorized administrators only.
