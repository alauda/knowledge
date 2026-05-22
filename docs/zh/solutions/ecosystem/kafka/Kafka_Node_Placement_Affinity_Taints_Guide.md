---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500122
sourceSHA: edbb9fc10be498a248d33a268aa7434813384e004d0606fa163054d1b5ef492c
---

# 在专用中间件节点上调度 Kafka，使用亲和性、污点和容忍

:::info 适用版本
ACP 3.8 及更高版本。YAML 示例基于 Strimzi Kafka 资源。
:::

## 场景

一个业务集群已经运行着客户应用程序，如 Harbor 和其他工作负载。为中间件产品添加了新节点，Kafka 必须仅在这些专用节点上运行。其他应用程序不应调度到中间件节点上。

使用污点来排斥一般工作负载，使用标签来识别中间件节点，使用容忍使 Kafka 能够使用这些节点，以及使用节点亲和性确保 Kafka 仅在这些节点上调度。

## 实施计划

1. 为每个中间件节点添加污点。
2. 为每个中间件节点添加标签。
3. 配置 Kafka 和 ZooKeeper pod 的容忍以适应污点。
4. 配置 Kafka 和 ZooKeeper 的节点亲和性以适应标签。
5. 保持 pod 反亲和性启用，以确保高可用副本不会落在同一节点上。

## 标签和污点节点

示例标签：

```bash
kubectl label node <node-name> middleware.alauda.io/dedicated=true
```

示例污点：

```bash
kubectl taint node <node-name> middleware.alauda.io/dedicated=true:NoSchedule
```

## Kafka YAML 示例

在 Kafka 和 ZooKeeper pod 模板下添加亲和性和容忍：

```yaml
apiVersion: kafka.strimzi.io/v1beta1
kind: Kafka
metadata:
  name: my-cluster
  namespace: operators
spec:
  kafka:
    replicas: 3
    template:
      pod:
        affinity:
          nodeAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              nodeSelectorTerms:
                - matchExpressions:
                    - key: middleware.alauda.io/dedicated
                      operator: In
                      values:
                        - "true"
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchLabels:
                    strimzi.io/cluster: my-cluster
                    strimzi.io/kind: Kafka
                topologyKey: kubernetes.io/hostname
        tolerations:
          - key: middleware.alauda.io/dedicated
            operator: Equal
            value: "true"
            effect: NoSchedule
  zookeeper:
    replicas: 3
    template:
      pod:
        affinity:
          nodeAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              nodeSelectorTerms:
                - matchExpressions:
                    - key: middleware.alauda.io/dedicated
                      operator: In
                      values:
                        - "true"
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchLabels:
                    strimzi.io/cluster: my-cluster
                    strimzi.io/kind: Kafka
                topologyKey: kubernetes.io/hostname
        tolerations:
          - key: middleware.alauda.io/dedicated
            operator: Equal
            value: "true"
            effect: NoSchedule
```

## 验证调度

```bash
kubectl -n <namespace> get pod -o wide | grep <cluster-name>
kubectl describe node <middleware-node> | grep -E 'Taints|middleware.alauda.io/dedicated'
```

确认 Kafka 代理和 ZooKeeper pod 仅放置在专用中间件节点上，并且分布在不同的主机上。

## 重要考虑事项

- 三个代理的 Kafka 集群和三个节点的 ZooKeeper 集群在使用硬反亲和性时至少需要三个专用节点。
- 如果专用节点不足，pod 将保持待处理状态。决定是添加节点还是放宽反亲和性。
- 如果整个实例必须保持在专用节点上，则对 Kafka、ZooKeeper、实体操作员和出口商应用相同的节点放置策略。
- 保持标签和污点稳定。移除它们可能会导致在 pod 重新创建期间出现意外调度。
