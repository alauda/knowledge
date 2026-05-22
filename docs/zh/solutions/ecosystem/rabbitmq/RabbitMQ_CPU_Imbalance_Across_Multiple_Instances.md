---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500137
sourceSHA: 6ac7a2b0506cba7095b4ab994cec5d5e7f75ff619d474cb6dc58ddf94209679c
---

# RabbitMQ 在多个实例间的 CPU 不平衡

## 问题

在同一节点上进行多个大型 RabbitMQ 实例的性能测试时，CPU 和内存并未耗尽，但吞吐量仍然早期达到平台期，实例之间相互干扰。

## 原因

在容器化环境中，RabbitMQ 和 Erlang 调度程序的行为可能会导致工作在 CPU 核心之间不均匀分配。使用默认的 RabbitMQ 调度程序绑定类型时，一些核心被重度使用，而其他核心则未被充分利用。当多个 RabbitMQ 实例共享一个节点时，这可能会造成不必要的 CPU 竞争并降低吞吐量。

## Erlang 调度程序绑定类型

| 值    | 说明                                                      |
| ----- | ---------------------------------------------------------- |
| `u`   | 未绑定。操作系统决定调度程序的放置。                     |
| `ns`  | 无扩展。保持调度程序靠近在一起。                         |
| `ts`  | 线程扩展。跨硬件线程分配。                               |
| `ps`  | 处理器扩展。跨处理器包分配。                             |
| `s`   | 尽可能扩展。                                            |
| `db`  | 默认绑定行为。                                          |

## 建议

将调度程序绑定类型设置为 `u`，以便操作系统可以更均匀地分配 RabbitMQ 调度程序线程。

## 配置

在 `spec.rabbitmq.envConfig` 下添加以下内容：

```yaml
spec:
  rabbitmq:
    envConfig: |
      RABBITMQ_SCHEDULER_BIND_TYPE="u"
```

## 预期结果

更改后：

- CPU 分配通常在核心之间更加平衡
- 当多个 RabbitMQ 实例共享同一节点时，吞吐量改善
- 工作负载可以接近真实的网络或存储限制，而不是人为的 CPU 调度瓶颈

## 注意事项

- 更改后重新运行性能测试。
- 如果多个大型集群共享相同的硬件，请将此修复与适当的节点放置和反亲和性结合使用。
