---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500111
sourceSHA: 1b0175a416264d5d6eb7a8be906abf54b6a8de1a33443badfcccf74f20a56883
---

# 删除异常主题 CR 时避免 Kafka 主题数据丢失

:::info 适用版本
受影响版本：ACP 3.10.x，<= 3.12.3，<= 3.14.2，<= 3.16.1。已在 ACP 3.12.4、3.14.3、3.16.2 和 3.18 中修复。
:::

## 问题

如果名为 `test` 的 Kafka 主题已经存在，用户创建了第二个主题自定义资源，其 `spec.topicName` 也为 `test`，则第二个主题自定义资源将进入异常状态。在受影响的版本中，删除该异常自定义资源可能会删除或清除现有主题中的数据。

该问题是由社区删除逻辑中的一个错误引发的，该错误未能正确验证私有主题与被删除的自定义资源之间的关系。

## 触发条件

该问题需要以下两个操作：

1. 用户创建一个主题自定义资源，并手动将 `spec.topicName` 设置为另一个主题自定义资源已使用的主题名称。
2. 用户删除异常主题自定义资源。

如果 `spec.topicName` 未手动设置，则主题名称默认为自定义资源名称，问题发生的可能性较小。

## 解决方法

在删除异常主题自定义资源之前，将其 `spec.topicName` 更改为一个新的未使用的主题名称。然后删除该异常自定义资源。

```bash
kubectl -n <namespace> edit rdstopic <abnormal-topic-cr>
```

将主题名称更新为一个可丢弃的未使用名称：

```yaml
spec:
  topicName: unused-topic-name-for-cleanup
```

然后删除自定义资源：

```bash
kubectl -n <namespace> delete rdstopic <abnormal-topic-cr>
```

## 重要注意事项

- 如果异常主题 CR 的 `spec.topicName` 指向一个现有的有效主题，请勿删除该异常主题 CR。
- 优先将 `spec.topicName` 保持为空，以便操作员使用 CR 名称作为主题名称。
- 在可用时升级到修复版本。
- 在受影响版本中删除主题资源之前，请确认 CR 名称与 `spec.topicName` 之间的关系。
