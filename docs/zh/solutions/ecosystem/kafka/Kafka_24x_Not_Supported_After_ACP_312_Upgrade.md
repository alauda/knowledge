---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500118
sourceSHA: da95e15522ef69b2862b3bc908414ff2e358854ac5ad7dcfcce12bb9a0fccd2f
---

# 升级到 ACP 3.12 后不再支持 Kafka 2.4.x

:::info 适用版本
ACP 3.8 到 3.12 的升级路径。
:::

## 问题

ACP 3.12 使用的 Kafka operator 版本不支持 Kafka 2.4.x。ACP 3.12 支持更新的 Kafka 版本，如 2.5.x、2.6.x 和 2.7.x。在平台升级之前仍然使用 2.4.x 的 Kafka 实例在 operator 升级后可能会出现异常。

管理视图中的 Kafka 资源在升级到 ACP 3.12 之前也需要导入到 RDS 业务视图中。否则，由于新的 CRD 架构与旧的 3.8 时代架构不同，字段可能会丢失。

## 解决方案

### 1. 在平台升级之前升级 Kafka

在将 ACP 升级到 3.12 之前，将每个 Kafka 实例从 2.4.x 升级到 2.5.0 或更高版本。

您可以使用产品 UI 进行逐步版本升级，或直接编辑资源 YAML 并更新 `spec.version`：

```yaml
spec:
  kafka:
    version: 2.5.0
```

在版本升级期间，Kafka 实例会逐个重启代理。通过健康的副本和 ISR，滚动升级不应中断服务或丢失数据。

### 2. 导入管理视图资源

如果 Kafka 实例是直接在 ACP 3.8 的管理视图中创建的，请在升级到 ACP 3.12 之前将其导入到业务视图中。

使用导入指南中描述的 `rdskafka-sync` 工具：

```bash
./rdskafka-sync check cluster -n <namespace>
./rdskafka-sync sync cluster <name> -n <namespace>
```

## 影响

在成功升级 Kafka 版本和资源导入后，客户端可以正常继续使用 Kafka 集群。该操作设计为滚动更新，并且在集群健康时不应导致数据丢失。

## 重要注意事项

- 在 Kafka 实例仍然使用 2.4.x 时，请勿升级平台。
- 在 ACP 3.12 升级之前导入管理视图资源。
- 在滚动更新之前和之后确认所有 Kafka 代理和 ZooKeeper pod 已准备就绪。
- 在升级后验证主题可用性和消费者堆积量。
