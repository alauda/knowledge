---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500130
sourceSHA: 8370016339869f5aa7dc3e6abae59ca40aabed525d0b3f5facaa9f69d4f31216
---

# RabbitMQ 从 3.8.x 迁移到 3.12.4

:::info 适用版本
已验证适用于需要替换旧版 3.8.x RabbitMQ 集群的 ACP 3.14 及更高版本环境。
:::

## 问题

将数据和元数据从 RabbitMQ 3.8.x 迁移到 RabbitMQ 3.12.4。

## 约束

- 操作员工作流不支持直接跨所有中间版本的滚动升级。
- 上游指导中的 RabbitMQ 升级路径需要中间的主要和次要版本。
- 最安全的生产路径通常是创建一个新的 3.12.4 集群并切换应用程序到该集群。

## 推荐选项

如果可能，让旧集群完全排空，然后切换到新集群，而不迁移消息。

## 选项 1：在积压排空后切换

### 适用场景

队列可以完全消费，或者不需要保留未消费的消息。

### 步骤

1. 创建一个新的 3.12.x 集群，规模相当。
2. 启用相同的必需插件。
3. 从旧集群导出定义。
4. 将定义导入到新集群。
5. 停止旧集群上的生产者。
6. 等待源队列排空。
7. 更新客户端连接设置并开始使用新集群。

## 选项 2：使用 Shovel 迁移剩余数据

### 适用场景

某些队列无法完全排空，且其积压必须保留。

### 额外准备

在新集群上启用 Shovel：

```yaml
spec:
  rabbitmq:
    additionalPlugins:
      - rabbitmq_shovel
      - rabbitmq_shovel_management
```

### 步骤

1. 创建新的 3.12.x 集群。
2. 从旧集群导入元数据。
3. 在可能的情况下停止源侧生产者，以减少需要迁移的队列数量。
4. 确定仍包含所需积压的队列。
5. 为每个队列配置一个 Shovel。
6. 验证消息是否到达新集群。
7. 迁移完成后移除 Shovel。
8. 将客户端切换到新集群。

### 示例 Shovel 命令

```bash
rabbitmqctl set_parameter shovel <shovel-name> --vhost / \
  '{"src-protocol":"amqp091","src-uri":"amqp://<src-user>:<src-pass>@<src-host>:<src-port>/<vhost>","src-queue":"<src-queue>","dest-protocol":"amqp091","dest-uri":"amqp://<dest-user>:<dest-pass>@<dest-host>:<dest-port>/<vhost>","dest-queue":"<dest-queue>"}'
```

检查 Shovel 状态：

```bash
rabbitmqctl shovel_status --formatter=pretty_table
```

切换后移除 Shovel：

```bash
rabbitmqctl clear_parameter shovel "<shovel-name>"
```

## 重要说明

- 对于默认 vhost，如果您的环境拒绝 URI 中的 `/`，请不要在 URI 中保留尾随的 `/<vhost>` 值。
- 按队列配置 Shovel 是耗时的。首先减少积压可以节省大量精力。
- 切换前请重新验证新集群上的插件兼容性。
