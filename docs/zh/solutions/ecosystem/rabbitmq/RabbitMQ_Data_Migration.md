---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500131
sourceSHA: 249a9ce44db6fa8239c20ccd8cb21dc7aa04a3f40f792e59b9361cb6db30bf50
---

# RabbitMQ 数据迁移

## 介绍

常见的 RabbitMQ 迁移场景包括：

1. 将一个队列复制到同一集群中的其他节点
2. 将数据从一个 RabbitMQ 集群迁移到另一个集群
3. 将队列数据导出到文件中并稍后导入
4. 从数据库驱动的工作流中加载数据到 RabbitMQ

## 集群内部的队列复制

经典的 HA 风格队列复制可以通过如下策略进行配置：

```json
{
  "policies": [
    {
      "vhost": "/",
      "name": "test-ha",
      "pattern": "test-ha",
      "apply-to": "queues",
      "definition": {
        "ha-mode": "all"
      },
      "priority": 0
    }
  ]
}
```

仅在队列模型和 RabbitMQ 版本仍支持预期的 HA 行为时使用此配置。

## 集群间迁移使用 Shovel

Shovel 可以将数据从源集群移动到目标集群。

基本流程：

1. 创建源集群和目标集群
2. 在一侧启用 shovel 插件
3. 创建源交换机和备份队列
4. 创建匹配的目标交换机和队列
5. 配置从源队列到目标交换机或队列的 shovel
6. 验证消息在目标侧的到达

该模型适用于迁移窗口，并且也构成热备份 DR 解决方案的基础。

## 将队列数据导出到文件

之前用于文件导出和导入的工具是 `node-amqp-tool`：

```bash
amqp-tool --host <host> --port <port> --user <user> --password <password> \
  --queue <queue> --export > dump.json

amqp-tool --host <host> --port <port> --user <user> --password <password> \
  --queue <queue> --import dump.json
```

限制：

- 该工具未积极维护
- 导出会像普通消费者一样消耗队列
- 格式兼容性有限
- 导出的文件包含额外的元数据，可能比原始消息负载大得多

## 数据库到 RabbitMQ 导入

可能的模式包括：

- 直接发布到 RabbitMQ 的数据库扩展
- 对数据库通知做出反应的 RabbitMQ 插件
- 在插入和更新时发布或通知的数据库触发器

风险：

- 数据库扩展可能不被平台操作员支持
- 触发器可能影响数据库性能
- 自定义 RabbitMQ 插件通常需要自定义镜像和额外的验证

## 建议

如果业务可以在切换前清空源队列的积压，建议直接切换到新集群。仅在必须保留积压时使用消息迁移。
