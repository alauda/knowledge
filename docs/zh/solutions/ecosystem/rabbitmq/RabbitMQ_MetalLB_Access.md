---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500135
sourceSHA: 344a646f71ae1d0f649c66a302102ae88a0472b398f4ea72b87e96e885565582
---

# RabbitMQ MetalLB 访问

:::info 适用版本
已验证适用于 ACP 3.16。
:::

## 问题

在环境中已经提供基于 MetalLB 的 `LoadBalancer` 实现时，通过 MetalLB 暴露 RabbitMQ。

## 先决条件

- MetalLB 已在集群中部署并正常工作。

## 配置

将 RabbitMQ 服务类型设置为 `LoadBalancer`，并为服务覆盖禁用节点端口分配：

```yaml
spec:
  service:
    type: LoadBalancer
  override:
    service:
      spec:
        allocateLoadBalancerNodePorts: false
```

## 验证

1. 创建或更新实例。
2. 确认集群状态变为就绪。
3. 检查服务：

```bash
kubectl get svc -n <namespace> | grep <cluster-name>
```

使用服务外部 IP 和标准 RabbitMQ 端口：

| 访问类型         | 地址                   |
| ----------------- | --------------------- |
| 客户端连接       | `<external-ip>:5672`  |
| 管理 UI          | `<external-ip>:15672` |

## 验证

- 通过外部 IP 打开管理 UI。
- 通过暴露的端点发布和消费测试消息。

## 注意事项

只要服务未被删除和重新创建，分配的 MetalLB IP 将保持稳定。
