---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500085
sourceSHA: 8d6bc6d7332bff316cbb79082071f2401d7b12215241153cbabcac097419bb29
---

# 如何向 Redis 实例添加自定义命令

## 介绍

默认情况下，Alauda Cache Service for Redis OSS 禁用一些被认为是危险的 Redis 命令（例如，`KEYS`、`FLUSHDB`、`FLUSHALL`、`CONFIG`）。当应用程序需要其中一个命令并因该命令不可用而无法启动时，您可以在 Redis 实例上启用特定命令。

:::tip 在当前 operator 上使用 ACL
在 **redis-operator 3.15+ 和 Redis 6.0+**（自 3.18 起为默认）中，启用先前禁用命令的支持方式是 **默认用户的 ACL 规则**，而不是 `customConfig`。有关 ACL 操作步骤，请参见 [如何管理危险的 Redis 命令](./How_to_Manage_Dangerous_Redis_Commands.md)（方法 1）。下面的 `rename-command` / `customConfig` 方法适用于 **旧版 operator（`<= 3.15`）或 Redis `< 6.0`**。
:::

本指南描述了在旧版中添加命令的两种等效方法：通过 Web 控制台 UI 和直接编辑 Redis 自定义资源。

:::info 适用版本
本指南（通过 customConfig 的 rename-command）：redis-operator `> 3.10.3` 和 `<= 3.15`。对于 `>= 3.18`，请使用 ACL。
:::

:::warning
编辑 `customConfig`（在下面的任一方法中）会触发 **Redis 数据 Pod 的滚动重启** — 更改不会热加载。如果您的工作负载无法容忍短暂的断开，请在维护窗口中安排更改。
:::

## 先决条件

- 一个由 Redis Operator 管理的运行中的 Redis 实例。
- 有权限通过 Web 控制台或 `kubectl` 编辑该实例。

## 操作步骤

### 选项 1：通过 Web 控制台编辑

1. 导航到 Redis 实例详细信息页面。
2. 打开 **参数配置**（或等效）部分。
3. 找到禁用命令列表，移除（或添加到允许列表）应用程序所需的命令。
4. 保存更改。

Operator 会协调实例并重启相关的 Pod。

### 选项 2：编辑 Redis 自定义资源

直接编辑 Redis CR：

```bash
kubectl -n <namespace> edit redis <instance-name>
```

Operator 的默认配置通过将命令映射到空字符串来禁用命令。要重新启用先前禁用的命令，请将其重命名为自身；要禁用新的命令，请将其映射到空字符串。

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>
  namespace: <namespace>
spec:
  customConfig:
    # 重新启用 flushall（将 flushall 重命名为 flushall，覆盖默认禁用）；
    # 将 debug 重命名为一个难以猜测的别名；完全禁用 set。
    rename-command: 'flushall flushall debug abc123 set ""'
```

保存文件。Operator 会获取更改并重启 Redis Pods。

:::note
`rename-command` 中的每个条目都是 `<original> <replacement>` 对，使用空格分隔。使用 `""` 作为替代项可以完全禁用命令。支持在单个字符串中使用多个条目。
:::

## 重要考虑事项

- 两种方法都会导致 Redis Pods 重启。如果您的工作负载无法容忍短暂的断开，请在维护窗口中安排更改。
- 启用危险命令（如 `FLUSHALL`、`KEYS` 或 `CONFIG`）会增加操作风险。一旦您的应用程序不再需要它们，请重新禁用它们。
- 在 **operator 3.15+ 和 Redis 6.0+** 中，优先使用 ACL — 请参见本页顶部的交叉引用。`rename-command` 保留用于旧实例。
- 不同 Operator 版本之间，确切的自定义配置键和 UI 标签可能会略有不同；请查阅与您安装版本匹配的 Operator 文档以获取精确的键名称。
