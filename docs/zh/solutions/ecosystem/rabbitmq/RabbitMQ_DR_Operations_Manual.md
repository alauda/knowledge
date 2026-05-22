---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500127
sourceSHA: 56f6334ca1bb6ac21621c31fdf85d9bde063b1a103015d4de56790e225e50c55
---

# RabbitMQ 灾难恢复操作手册

:::info 适用版本
ACP 3.14、3.15 和 3.16。
:::

## 常规监控

灾难恢复解决方案应从 RabbitMQ 管理和队列行为两个方面进行监控。

关键检查：

- shovel 状态
- 源端 `amq.gen-*` 内部队列
- 排队消息增长
- 消费者确认率
- 目标集群健康状况和存储消耗

## Shovel 状态

| 状态      | 意义                                              |
| ---------- | ---------------------------------------------------- |
| `starting` | Shovel 正在尝试连接一侧或两侧                     |
| `running`  | Shovel 正在积极消费和转发消息                     |

如果状态未达到 `running`，请检查源 URI、目标 URI、凭据、队列或交换的存在性以及网络连接。

## 基于队列的健康检查

当使用交换到交换的复制时，Shovel 会在源交换下创建一个内部队列。

使用以下信号：

- 如果总排队消息持续增加，目标端复制速度慢于源端发布速度。
- 如果排队消息保持在零以上且没有变化，复制可能已停滞。
- 如果消费者确认率远低于发布率，请检查目标集群性能和跨站点延迟。

## 切换程序

1. 确认源集群不可用或不再安全进行写入。
2. 停止或重定向生产者，以便控制切换。
3. 将生产者和消费者指向目标集群。
4. 验证目标端的交换、队列和消费者行为。
5. 在第一次恢复窗口期间注意重复消费。

## 切换回原原则

不要自动将流量复制回原始源集群。在源集群修复后，决定是从头重建、重新同步业务状态，还是创建新的灾难恢复方向。

## Shovel 管理命令

列出特定节点上的 shovel 状态：

```bash
rabbitmqctl shovel_status -n rabbit@<pod>.<headless-service>.<namespace>
```

重启一个 shovel：

```bash
rabbitmqctl -n rabbit@<pod>.<headless-service>.<namespace> restart_shovel <shovel-name>
```

删除一个 shovel：

```bash
rabbitmqctl -n rabbit@<pod>.<headless-service>.<namespace> delete_shovel <shovel-name>
```

## 常见风险

- 源-目标延迟激增
- 目标集群存储耗尽
- 忘记的队列或绑定更改未复制到目标端
- 客户端故障转移后的重复消费

## 建议

- 在操作员升级或重大队列拓扑更改后进行灾难恢复演练。
- 保留所有 shovel 名称、URI、受保护交换和拥有应用程序的操作记录。
- 在依赖生产环境中的灾难恢复设计之前，测试应用程序的重新连接行为。
