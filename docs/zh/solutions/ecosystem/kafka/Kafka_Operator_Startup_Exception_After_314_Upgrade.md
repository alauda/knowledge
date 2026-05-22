---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500108
sourceSHA: fe3c9c050b78002be831435877d88f1db251c4bd74c8768985d47013b8b51f25
---

# Kafka Operator 在 ACP 3.14 升级后启动异常

:::info 适用版本
受引用问题影响的 ACP 3.14 operator 升级路径。
:::

## 问题

在升级 Kafka operator 后，当存在 `RdsTopic` 自定义资源但相应的 `KafkaTopic` 自定义资源不存在时，operator 可能会异常启动。在启动过程中，operator 可能会遇到空指针恐慌。

## 解决方案

识别 operator 错误日志中提到的 `RdsTopic` 资源，移除其最终处理器，然后删除过时的资源。

```bash
kubectl -n <namespace> get rdstopic
kubectl -n <namespace> patch rdstopic <topic-cr-name> \
  --type=merge \
  -p '{"metadata":{"finalizers":[]}}'
kubectl -n <namespace> delete rdstopic <topic-cr-name>
```

如果 operator 没有自动恢复，请重启 operator：

```bash
kubectl delete pods --all-namespaces -l strimzi.io/kind=cluster-operator
```

## 重要注意事项

- 仅修补日志中报告的过时 `RdsTopic`。
- 在删除产品层资源之前，确认是否仍存在真实的 Kafka 主题。
- 如果需要升级处理，请在修复之前收集 operator 日志。
