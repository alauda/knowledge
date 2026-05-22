---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500117
sourceSHA: c4ddb226b3312cfe28a740cbaa710c7d6f7824c2a33b1a5b69162bac73e7b64b
---

# Kafka Operator 被异常实例阻塞

:::info 适用版本
ACP 3.x Kafka operator 版本在 ACP 3.15 修复之前。
:::

## 问题

在操作员升级或协调期间，所有 Kafka 实例可能会变得异常，升级可能会被阻塞。操作员日志显示之前的 API 服务器连接错误，随后出现类似 `Reconciliation is in progress` 的重复消息。之后，实例不再正常协调。

## 解决方案

重启 Strimzi 集群操作员，并等待协调恢复：

```bash
kubectl delete pods --all-namespaces -l strimzi.io/kind=cluster-operator
```

在操作员 pod 被重新创建后，监控 Kafka 实例状态：

```bash
kubectl get kafka --all-namespaces
kubectl get pod --all-namespaces | grep cluster-operator
```

## 根本原因

这与已知的上游 Strimzi 问题相匹配，其中在 API 服务器连接问题后，协调可能会保持阻塞。该问题在 ACP 3.15 Kafka operator 版本中已修复。

## 重要注意事项

- 仅重启操作员 pod；除非需要单独的恢复步骤，否则不要删除 Kafka broker pods。
- 重启后检查操作员日志以确认协调正在进行。
- 如果协调仍然被阻塞，请在进一步更改之前收集操作员日志和 Kafka 自定义资源状态。
