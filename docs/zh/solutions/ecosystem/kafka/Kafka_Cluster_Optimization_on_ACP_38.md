---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500112
sourceSHA: 7b1ecfec2f58d713c9aa2bf06950749d6a501fd413c42e844a190f1baa833ba1
---

# ACP 3.8 上的 Kafka 集群优化

:::info 适用版本
ACP 3.8.x.
:::

## 介绍

本指南总结了 ACP 3.8.x 上 Kafka 集群的资源和配置调整。创建或调整 Kafka 实例时，可以将其作为审核检查表。

## 参考资源计划

对于小型 2 vCPU / 4 GiB 的 Kafka 代理配置，还需规划周边组件：

| 组件           | 资源               | 存储                          |
| -------------- | ------------------ | ------------------------------ |
| Kafka 代理     | 2 vCPU / 4 GiB     | 100 GiB 或特定工作负载        |
| ZooKeeper      | 2 vCPU / 4 GiB     | 10-100 GiB，具体取决于策略    |
| TLS 边车      | 200m CPU / 128 MiB | 不适用                        |
| 主题操作器    | 1 vCPU / 2 GiB     | 不适用                        |
| 用户操作器    | 1 vCPU / 2 GiB     | 不适用                        |
| Kafka 导出器   | 1 vCPU / 2 GiB     | 不适用                        |

## JVM 大小设置

将 Kafka 和 ZooKeeper 的 JVM 堆设置为容器内存限制的大约四分之一作为起始点：

```yaml
spec:
  kafka:
    jvmOptions:
      -Xms: 1024m
      -Xmx: 1024m
    resources:
      limits:
        cpu: 2
        memory: 4Gi
      requests:
        cpu: 2
        memory: 4Gi
  zookeeper:
    jvmOptions:
      -Xms: 1024m
      -Xmx: 1024m
    resources:
      limits:
        cpu: 2
        memory: 4Gi
      requests:
        cpu: 2
        memory: 4Gi
```

## 实体操作器资源

```yaml
spec:
  entityOperator:
    tlsSidecar:
      resources:
        limits:
          cpu: 200m
          memory: 128Mi
        requests:
          cpu: 200m
          memory: 128Mi
    topicOperator:
      jvmOptions:
        -Xms: 500m
        -Xmx: 500m
      resources:
        limits:
          cpu: "1"
          memory: 2Gi
        requests:
          cpu: "1"
          memory: 2Gi
    userOperator:
      jvmOptions:
        -Xms: 500m
        -Xmx: 500m
      resources:
        limits:
          cpu: "1"
          memory: 2Gi
        requests:
          cpu: "1"
          memory: 2Gi
```

## Kafka 导出器资源

```yaml
spec:
  kafkaExporter:
    groupRegex: ".*"
    topicRegex: ".*"
    resources:
      limits:
        cpu: 1
        memory: 2Gi
      requests:
        cpu: 1
        memory: 2Gi
```

## 命名规则

在与 Kafka 相关的自定义资源名称中，请勿使用下划线。Kubernetes 资源名称必须遵循 RFC 1123。使用小写字母、数字、连字符和点，并以字母数字字符开头和结尾。

## 主题默认值

在 ACP 3.8.2 及更高版本中，默认主题段大小已被修正。对于旧资源，请验证主题配置，并在需要时明确设置预期值：

```yaml
spec:
  config:
    retention.ms: "604800000"
    message.max.bytes: "1073741824"
```

## 重要注意事项

- 根据主题和用户的数量，而不仅仅是代理的大小来调整主题操作器和用户操作器的大小。
- 对于生产工作负载，使用明确的主题配置。
- 在使用专用节点时，保持资源请求等于限制，以实现可预测的 Kafka 调度。
- 在 UI 更改后验证生成的 YAML，因为产品默认值可能因补丁版本而异。
