---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500080
sourceSHA: 6ce5aa0e8672779ce2b46ef3377eb797d2011a9064276f8c142f7e3b7df42e22
---

# 如何管理危险的 Redis 命令

## 介绍

本指南描述了如何在 Alauda Cache Service for Redis OSS 上启用或禁用危险的 Redis 命令（如 `flushall`、`flushdb`、`keys`）。

:::info 当前 operator 用户（3.18+）
仅使用 **方法 1（ACL 规则）**。该 operator 提供 Redis 6.0+，其中 ACL 是标准机制。方法 2–4 仅为遗留 operator (`<= 3.16`) 的完整性而记录，与当前部署无关。
:::

## 方法 1：通过 ACL 规则配置（推荐）

:::info 适用版本

- Operator: `>= 3.15`
- Redis: `>= 6.0`
- 架构：Sentinel、Cluster
  :::

从 operator 版本 3.15 开始，支持 Redis 用户管理（仅限 Redis 6.0+）。对于低于 6.0 的 Redis 版本，请使用 [方法 3：通过标准参数配置](#method-3-configure-via-standard-parameters-rename-command)。

默认情况下，危险命令对 `default` 用户是禁用的。您可以通过 **实例** > **用户管理** 自定义 ACL 规则以启用或禁用命令权限。

### 默认用户权限

```text
# Redis 6.0 默认用户权限
+@all -acl -flushall -flushdb -keys ~*

# Redis 7.0 默认用户权限
+@all -acl -flushall -flushdb -keys ~* &*
```

### ACL 规则参考

| 规则                             | 说明                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `+@all`                          | 启用所有命令                                                                                               |
| `-@all`                          | 禁用所有命令                                                                                              |
| `-acl`                           | 禁用 `acl` 命令。该 operator 强制执行此规则，无法移除。                              |
| `-flushall`、`-flushdb`、`-keys` | 禁用相应的命令                                                                                |
| `~*`                             | 允许对所有键进行操作（`*` 是通配符，例如 `~test*` 允许访问以 `test` 为前缀的键） |
| `&*`                             | 允许对所有 Pub/Sub 通道进行操作                                                                          |

要启用特定命令（例如 `keys`），请从 ACL 规则中移除 `-keys` 条目。

### 规则顺序很重要

ACL 指令的顺序很重要。以下规则授予对 **所有** 命令的访问，包括 `flushall` 和 `flushdb`，因为 `+@all` 会覆盖之前的拒绝规则：

```text
-flushall -flushdb +@all ~*
```

要正确禁用特定命令，请将拒绝规则放在允许规则 **之后**：

```text
+@all ~* -flushall -flushdb
```

有关更多详细信息，请参见 [Redis ACL 社区文档](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/#acl-rules)。

---

## 遗留方法（operator `<= 3.16`）

以下方法保留给仍在运行遗留 operator 版本的用户。如果您使用的是 operator `3.18+`，请跳过此部分。

## 方法 2：以 `operator` 身份临时运行危险命令

:::info 适用版本

- Operator: `>= 3.12.1` 且 `< 3.18`（`/account/password` 文件在 3.18 中被移除）
- Sentinel/Cluster 模式需要 operator `>= 3.15`
- Redis: `>= 6.0`
  :::

当危险命令对 `default` 用户禁用时，可以使用内置的 `operator` 账户进行一次性管理任务（例如，数据迁移或清理）：

```bash
# 以 operator 用户身份进入 redis-cli 交互式 shell
redis-cli -a $(cat /account/password) --user operator
```

:::warning
`operator` 用户具有完全权限，可以执行任何命令。仅在明确需要的管理任务中使用。
:::

## 方法 3：通过标准参数配置（`rename-command`）

:::info 适用版本

- Operator: `> 3.10.3` 且 `<= 3.15`
- 架构：Sentinel、Cluster
  :::

在此版本范围内，`flushall` 和 `flushdb` 默认情况下是禁用的。可以通过配置 `rename-command` 参数来禁用或重命名其他命令。

### 禁用或重命名命令

| 操作                   | 键                | 值                                     | 描述                                                                  |
| ---------------------- | ---------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| 禁用命令               | `rename-command` | `set ""`                                | 禁用 `set` 命令                                                   |
| 重命名命令             | `rename-command` | `set abc123`                            | 将 `set` 重命名为 `abc123`                                                    |
| 组合配置              | `rename-command` | `flushall flushall debug abc123 set ""` | (1) 恢复 `flushall`，(2) 将 `debug` 重命名为 `abc123`，(3) 禁用 `set` |

:::warning
修改 `rename-command` 参数会触发实例重启。
:::

### 重新启用内置禁用命令

要恢复原本禁用的命令（例如 `flushall`），将命令重命名为其自身：

| 操作               | 键                | 值               | 描述                                                       |
| -------------------- | ---------------- | ----------------- | ----------------------------------------------------------------- |
| 重新启用 `flushall` | `rename-command` | `flushall flushall` | 将 `flushall` 重命名为 `flushall`，覆盖内置禁用 |

### 解决 Operator 3.14.0 / 3.14.1 Bug（Redis 6.0）

:::warning 已知问题
Operator 版本 **3.14.0** 和 **3.14.1** 存在一个 bug，`rename-command` 配置更改对 Redis 6.0 实例无效。
:::

应用以下手动修复：

1. 编辑实例 ACL ConfigMap：

   ```bash
   kubectl -n <namespace> edit cm drc-acl-<instance-name>
   ```

2. ConfigMap 内容如下：

   ```yaml
   apiVersion: v1
   data:
     default: '{"name":"default","role":"Developer","password":{"secretName":"redis-c6-6sd7v"},"rules":[{"categories":["all"],"disallowedCommands":["flushall","flushdb"],"keyPatterns":["*"]}]}'
     operator: '{"name":"operator","role":"Operator","password":{"secretName":"drc-acl-c6-operator-secret"},"rules":[{"categories":["all"],"disallowedCommands":["keys"],"keyPatterns":["*"]}]}'
   kind: ConfigMap
   metadata:
     name: drc-acl-<instance-name>
   ```

3. 修改 `default` 条目中的 `disallowedCommands` 数组。例如，要移除 `flushall` 限制并添加 `debug`：

   ```yaml
   apiVersion: v1
   data:
     default: '{"name":"default","role":"Developer","password":{"secretName":"redis-c6-6sd7v"},"rules":[{"categories":["all"],"disallowedCommands":["debug","flushdb"],"keyPatterns":["*"]}]}'
     operator: '{"name":"operator","role":"Operator","password":{"secretName":"drc-acl-c6-operator-secret"},"rules":[{"categories":["all"],"disallowedCommands":["keys"],"keyPatterns":["*"]}]}'
   kind: ConfigMap
   metadata:
     name: drc-acl-<instance-name>
   ```

4. 更新实例配置中的 `rename-command` 参数以触发实例重启。

5. 等待重启完成。新的 ACL 规则将生效。

## 方法 4：遗留 YAML 配置

:::info 适用版本

- Operator: `> 3.8.2` 且 `<= 3.10.2`
- 架构：Sentinel、Cluster
  :::

### 集群模式

仅通过代理支持禁用危险命令。当客户端通过 Redis 代理连接时，`flushall` 和 `keys *` 等命令会自动被阻止。

### Sentinel 模式

1. 通过 `Redis` CR 创建新的 Sentinel 实例（`apiVersion: middleware.alauda.io/v1`，`arch: sentinel`）。
2. 添加 `customCommandRenames` 字段以重命名 `flushall`、`keys` 和其他命令。
3. 编辑相应的 Sentinel ConfigMap（`rfs-<instance-name>`）以设置 `rename-command` 指令。
4. 重启实例以使配置生效。

### 验证

重启后，连接到实例并确认重命名或禁用的命令不再可访问。

## 重要注意事项

- 在运行 operator 3.15+ 和 Redis 6.0+ 时，始终使用 **方法 1（ACL 规则）**。ACL 提供更细粒度的控制，并且大多数规则更改不需要实例重启。
- 修改 `rename-command` 会触发实例重启。请在维护窗口期间计划更改。
- ACL 规则的顺序很重要。始终将拒绝规则放在广泛允许规则之后。
- `operator` 用户具有特权。仅将其凭据限制给授权的管理员。
