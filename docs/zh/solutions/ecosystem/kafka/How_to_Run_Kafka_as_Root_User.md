---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500115
sourceSHA: 119e5a38239ffae4665904034a6460436dddfe0666749a58d6d57ec82bfcba92
---

# 以根用户身份运行 Kafka Pods

:::info 适用版本
ACP 3.12 及更高版本。
:::

## 问题

Kafka 组件通常以非根用户身份运行以增强安全性。一些存储集成或遗留环境要求 Kafka 和 ZooKeeper pods 以 UID 0 运行，并使用根用户拥有的文件系统。

仅在存储集成无法与默认的非根安全上下文一起工作时使用此方法。

## 操作步骤

在创建 Kafka 实例时，切换到 YAML 视图，并在 `spec.kafka.template.pod` 和 `spec.zookeeper.template.pod` 下添加 pod 安全上下文设置：

```yaml
spec:
  kafka:
    template:
      pod:
        securityContext:
          runAsUser: 0
          fsGroup: 0
  zookeeper:
    template:
      pod:
        securityContext:
          runAsUser: 0
          fsGroup: 0
```

创建或更新实例，然后进入 pod 并验证有效用户：

```bash
kubectl -n <namespace> exec -it <kafka-pod> -- id
kubectl -n <namespace> exec -it <zookeeper-pod> -- id
```

## 重要考虑事项

- 以根用户身份运行会削弱默认的安全态势。仅在存储需求使其必要时使用。
- 确认命名空间安全策略、准入策略或 Pod 安全准入级别允许 UID 0。
- 在存储类或 CSI 驱动程序更改后重新测试卷权限。
- 记录此例外以供安全审查。
