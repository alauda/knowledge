---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500128
sourceSHA: 0957176ac278e79c146af4bedd3d388f33cd6086596186d0371f37a7497479cd
---

# RabbitMQ 灾难恢复解决方案（ACP 3.12 之前）

:::info 适用版本
已验证适用于 ACP 3.8 时代的 RabbitMQ 部署。
:::

## 介绍

早期的 RabbitMQ 灾难恢复部署也使用了 Shovel 插件，但操作模型更为手动。一个主集群处理正常流量，而一个备用集群则保存复制的数据以便故障切换。

## 支持的 Shovel 模式

较早的部署通常描述了四种源-目标组合：

| 源       | 目标        | 备注                                                  |
| -------- | ----------- | ------------------------------------------------------ |
| Exchange | Exchange    | 推荐用于保持路由的复制                                 |
| Exchange | Queue       | 在目标端发布到默认交换机                               |
| Queue    | Exchange    | 直接从源队列读取                                      |
| Queue    | Queue       | 直接的队列到队列复制                                   |

交换机到交换机的模型仍然是最安全的默认选项，因为它保持了路由行为更接近原始设计。

## 启用插件

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: rabbitmq-source
spec:
  rabbitmq:
    additionalPlugins:
      - rabbitmq_shovel
      - rabbitmq_shovel_management
```

## 重要参数

### 通用参数

- `Name`
- `Source`
- `Destination`
- `Reconnect delay`
- `Acknowledgement mode`

### 源端参数

- source URI
- source queue 或 exchange
- 当源为交换机时的路由键
- 预取计数
- 自动删除策略

### 目标端参数

- target URI
- target queue 或 exchange
- 当目标为交换机时的路由键
- 转发头

## 验证方法

对于每种配置模式：

1. 在两个集群上创建预期的交换机和队列。
2. 发布测试消息，命中匹配和不匹配的路由路径。
3. 验证在使用基于交换机的源模式时，Shovel 是否创建了其内部队列。
4. 确认在目标队列或目标交换机绑定中可见的确切消息。

## 操作注意事项

- 基于队列的源复制直接从源队列消费，可能会干扰正常消费者。
- 较早版本的管理 UI 足以进行配置和状态观察，但仍需反复手动验证。
- 该解决方案仅在团队能够容忍手动设置、手动验证和手动故障切换时适用。
