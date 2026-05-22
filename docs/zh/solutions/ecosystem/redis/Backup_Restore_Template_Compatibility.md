---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500089
sourceSHA: c6f6a3b65e82e2344ca9263e9d34951cc6988f5084e63f21bc226f3ccb0c1049
---

# 备份和恢复与参数模板的兼容性

## 介绍

Alauda Cache Service for Redis OSS 支持两种备份目的地和三种持久性参数模板。这些组合并不都能互操作——特别是，将仅包含 RDB 的备份恢复到配置为 AOF 模板的实例中将不会加载任何数据，因为 Redis 在启动时会优先选择 AOF，当两者都可用时。

本文描述了兼容性矩阵，并提供了 AOF 恢复案例的手动解决方法，直到 operator 支持自动格式转换。

## 备份目的地

该平台支持两种备份方法：

- **基于 PVC 的备份。** 文件被复制到 `PersistentVolumeClaim` 并与源实例一起管理。
- **基于 S3 的备份。** 文件被上传到由平台备份中心管理的外部 S3 兼容对象存储。

## 兼容性矩阵

### PVC 备份 — 按 Redis 版本和模板的数据格式

| Redis 版本 | RDB 模板 | AOF 模板 (5/6) | 无磁盘模板 (5/6) |
| ---------- | -------- | --------------- | ----------------- |
| 5.0        | RDB      | RDB / AOF       | RDB               |
| 6.0        | RDB      | RDB / AOF       | RDB               |
| 7.2        | RDB      | RDB             | RDB               |

### S3 备份 — 按 Redis 版本和模板的数据格式

| Redis 版本 | RDB 模板 | AOF 模板 (5/6) | 无磁盘模板 (5/6) |
| ---------- | -------- | --------------- | ----------------- |
| 5.0        | RDB      | RDB             | RDB               |
| 6.0        | RDB      | RDB             | RDB               |
| 7.2        | RDB      | RDB             | RDB               |

:::note
S3 备份始终以 **RDB** 格式存储数据集，无论源实例使用哪个参数模板。当在 Redis 5.0 或 6.0 上使用 AOF 模板时，PVC 备份会捕获两个文件（RDB 和 AOF）。
:::

### Redis 启动时如何加载数据

Redis 根据活动配置决定加载什么：

| 配置                              |   RDB  |   AOF  |
| --------------------------------- | :----: | :----: |
| `save` 启用（仅 RDB）            | Loaded |    —   |
| `appendonly yes`（仅 AOF）       |    —   | Loaded |
| 同时启用 `save` 和 `appendonly yes` |    —   | Loaded |
| 均未配置                          | Loaded |    —   |

这意味着 **当 AOF 启用时，Redis 加载 AOF 文件并忽略 RDB 文件**。

## AOF 恢复问题

结合上述两个表格显示了问题案例：

> **将仅包含 RDB 的备份恢复到配置为 AOF 参数模板的实例中将导致没有数据被加载。**

这发生的原因是：

1. 备份仅包含 `dump.rdb`。
2. 新实例以 `appendonly yes` 启动，因此 Redis 查找 `appendonly.aof` 并忽略 RDB 文件。
3. 由于没有 AOF 文件，Redis 以空数据集启动。

## 解决方法

在 operator 支持在恢复时自动进行 RDB 到 AOF 的转换之前，请使用以下两步操作步骤将 RDB 备份恢复到启用 AOF 的实例中：

### 1. 创建禁用 AOF 的恢复实例

当您为恢复创建新的 Redis 实例时，覆盖参数模板以设置 `appendonly: "no"`。这允许 Redis 在启动时加载 `dump.rdb`。

例如，在 `RedisFailover` 资源上：

```yaml
spec:
  redis:
    customConfig:
      appendonly: "no"
    restore:
      backupName: <backup-name>
```

### 2. 等待就绪，然后重新启用 AOF

一旦实例达到 `Ready` 状态并且您已验证数据已加载，将 `appendonly` 切换回 `yes`。

```yaml
spec:
  redis:
    customConfig:
      appendonly: "yes"
```

当在运行时切换 `appendonly` 时，Redis 会从内存数据集中写入一个新的 AOF 文件，而无需重启进程。一旦 AOF 文件生成，持久性将恢复到 AOF 行为。

:::tip
在将 `appendonly` 切换回 `yes` 之前，请验证数据已加载（使用 `DBSIZE` 和一些示例键）。切换后，内存数据集将被持久化到新的 AOF 文件中。
:::

## 重要注意事项

- **始终将 RDB 视为通用备份格式。** 每个备份目的地都支持 RDB，因此即使源实例使用 AOF，也要围绕 RDB 规划恢复程序。
- **切换期间无数据丢失。** 将 `appendonly` 从 `no` 切换到 `yes` 不会重启 Redis，也不会刷新数据集。
- **为 AOF 重写计划停机时间。** 当重新启用 AOF 时，Redis 会将整个数据集写入磁盘。在大型数据集上，这可能会短暂增加磁盘和 CPU 使用率。
- **未来改进。** operator 的未来版本将自动执行格式转换，因此此解决方法将不再必要。
