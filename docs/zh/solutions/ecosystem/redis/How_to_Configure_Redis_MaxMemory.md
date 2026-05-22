---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500092
sourceSHA: 117cb19f9581feec1a3344cd33aca1d3ad2dc26aba155863a750ec444b1a3947
---

# 如何配置 Redis MaxMemory

## 介绍

默认情况下，Redis Operator 将 Redis 的 `maxmemory` 指令设置为容器内存限制的约 **80%**。剩余的 20% 作为安全边际，以防止容器因非数据内存使用（复制缓冲区、持久化时的 COW、客户端缓冲区等）激增而被 OOM 杀死。

对于配置了 1 个 CPU 和 2 GiB 内存的 Redis 实例，这通常会导致 `maxmemory` 约为 1.6 GiB，如 `INFO memory` 所示：

```
maxmemory:1717986918
maxmemory_human:1.60G
```

在某些情况下，您可能需要覆盖此默认值——例如，为了在较小的 Pod 上释放更多内存以作为安全边际，或在较大的 Pod 上为数据分配更多内存。本指南描述了如何覆盖操作员的默认计算。

:::info 适用版本
redis-operator 3.12 及更高版本（该技术在当前版本的操作员上也有效）
:::

## 先决条件

- 一个由 Redis Operator 管理的运行中的 Redis 实例。
- 通过 Web 控制台或 `kubectl` 编辑实例的权限。

## 操作步骤

有两种方法可以更改运行实例的 `maxmemory`。

### 选项 1：运行时覆盖（临时）

连接到 Redis Pod 并使用 `CONFIG SET`：

```bash
redis-cli -h <host> -p 6379 -a <password> CONFIG SET maxmemory <bytes>
```

例如，将 `maxmemory` 设置为 1 GiB：

```bash
redis-cli CONFIG SET maxmemory 1073741824
```

:::warning
此更改是 **临时的**。当 Pod 重启时会丢失，因为操作员在每次协调时会从 CR 重新生成 Redis 配置。
:::

### 选项 2：通过 `customConfig` 持久化覆盖（推荐）

在 Redis CR 的 `spec.customConfig` 下添加 `maxmemory` 条目。此更改由操作员持久化，并在 Pod 重启时生效。

#### 通过 Web 控制台编辑

1. 导航到 Redis 实例详细信息页面。
2. 打开 **参数配置**（或等效）部分。
3. 添加或更新 `maxmemory` 参数，设置为所需值。
4. 保存更改。

#### 直接编辑 CR

```bash
kubectl -n <namespace> edit redis <instance-name>
```

在 `spec.customConfig` 下添加 `maxmemory`：

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>
  namespace: <namespace>
spec:
  customConfig:
    maxmemory: "1073741824"   # 1 GiB，以字节表示（如果您的操作员版本支持单位后缀，则可以使用 "1gb"）
    # ... 其他自定义配置条目
```

操作员会在运行的 Pod 上协调更改。新的 `maxmemory` 会立即应用，而无需在支持的版本上重启 Pod；较旧的操作员版本可能会重启 Pod。

## 重要考虑事项

- 始终为非数据内存留出余地。将 `maxmemory` 设置为容器的内存限制将在负载下导致容器被 OOM 杀死。
- 推荐的比例大约是容器内存限制的 70%–80% 用于 `maxmemory`。根据您的复制、持久化和连接负载进行调整。
- 当您更改容器的 `resources.limits.memory` 时，也要重新评估您的 `maxmemory` 设置。
- 使用 `redis-cli` 的 `INFO memory` 来验证更改后的实际 `maxmemory` 和 `used_memory`。
