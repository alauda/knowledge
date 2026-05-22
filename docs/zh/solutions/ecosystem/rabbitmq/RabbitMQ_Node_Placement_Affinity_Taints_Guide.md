---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500134
sourceSHA: b9d2f6c11b6578747b9d5488b6b2e564148213f60373fc380cab00f6320c8bd3
---

# RabbitMQ 节点放置亲和性和污点指南

## 场景

一些客户集群同时运行业务应用和中间件。在这种情况下，RabbitMQ 应该仅在专用的中间件节点上运行，且不相关的工作负载应远离这些节点。

## 目标

1. 为中间件工作负载保留选定的节点。
2. 确保 RabbitMQ pods 仅调度到这些保留的节点上。
3. 在不同节点上分散 RabbitMQ 副本以实现高可用性。

## 推荐方法

1. 为专用的中间件节点添加污点。
2. 为相同的节点添加标签。
3. 配置 RabbitMQ 节点亲和性以匹配标签。
4. 配置 RabbitMQ 容忍以接受污点。
5. 配置 pod 反亲和性，以确保副本不会落在同一节点上。

## 示例配置

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: rabbitmq3816
  namespace: operators
spec:
  replicas: 3
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: rabbitmq3816
          topologyKey: kubernetes.io/hostname
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: middleware
                operator: In
                values:
                  - "enable"
  tolerations:
    - key: middleware
      operator: Equal
      value: enable
      effect: NoSchedule
```

## 预期结果

- 只有能够容忍中间件污点的 RabbitMQ 工作负载可以使用专用节点。
- RabbitMQ 副本仅调度到标记为中间件的节点上。
- 反亲和性防止同一集群的多个副本落在一个节点上。

## 注意事项

- 保持标签键和污点键在团队之间的一致性。
- 在将多个中间件集群固定到同一节点池之前，验证节点容量。
