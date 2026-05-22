---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# How to Add Custom Commands to a Redis Instance

## Introduction

By default, Alauda Cache Service for Redis OSS disables some Redis commands that are considered dangerous (for example, `KEYS`, `FLUSHDB`, `FLUSHALL`, `CONFIG`). When an application requires one of these commands and fails to start because the command is unavailable, you can enable specific commands on the Redis instance.

:::tip Use ACL on the current operator
On **redis-operator 3.15+ with Redis 6.0+** (the default since 3.18), the supported way to enable previously-disabled commands is the **default user's ACL rule**, not `customConfig`. See [How to Manage Dangerous Redis Commands](./How_to_Manage_Dangerous_Redis_Commands.md) for the ACL procedure (Method 1). The `rename-command` / `customConfig` approach below is for **legacy operator versions (`<= 3.15`) or Redis `< 6.0`**.
:::

This guide describes two equivalent ways to add commands on legacy versions: via the web console UI and by editing the Redis custom resource directly.

:::info Applicable Version
This guide (rename-command via customConfig): redis-operator `> 3.10.3` and `<= 3.15`. For `>= 3.18` use ACL instead.
:::

:::warning
Editing `customConfig` (in either method below) triggers a **rolling restart of the Redis data pods** — the change is not hot-reloaded. Schedule the change in a maintenance window if your workload cannot tolerate a brief disconnect.
:::

## Prerequisites

- A running Redis instance managed by the Redis Operator.
- Permission to edit the instance from the web console or via `kubectl`.

## Procedure

### Option 1: Edit via the Web Console

1. Navigate to the Redis instance details page.
2. Open the **Parameter Configuration** (or equivalent) section.
3. Locate the disabled-commands list and remove (or add to the allowlist) the commands required by your application.
4. Save the change.

The operator reconciles the instance and restarts the relevant pods.

### Option 2: Edit the Redis Custom Resource

Edit the Redis CR directly:

```bash
kubectl -n <namespace> edit redis <instance-name>
```

The operator's default config disables commands by mapping them to the empty string via `rename-command`. To re-enable a previously-disabled command, rename it to itself; to disable a new one, map it to the empty string.

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>
  namespace: <namespace>
spec:
  customConfig:
    # Re-enable flushall (renames flushall to flushall, overriding the default disable);
    # rename debug to a hard-to-guess alias; disable set entirely.
    rename-command: 'flushall flushall debug abc123 set ""'
```

Save the file. The operator picks up the change and restarts the Redis pods.

:::note
Each entry in `rename-command` is a `<original> <replacement>` pair, separated by spaces. Use `""` as the replacement to fully disable a command. Multiple entries in a single string are supported.
:::

## Important Considerations

- Both methods cause the Redis pods to restart. Schedule the change in a maintenance window if your workload cannot tolerate a brief disconnect.
- Enabling dangerous commands (such as `FLUSHALL`, `KEYS`, or `CONFIG`) increases operational risk. Re-disable them once your application no longer requires them.
- On **operator 3.15+ with Redis 6.0+** prefer ACL — see the cross-reference at the top of this page. `rename-command` is retained for older instances.
- The exact custom-config keys and UI labels may differ slightly between Operator versions; consult the Operator documentation that matches your installed version for the precise key names.
