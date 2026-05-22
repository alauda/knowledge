---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500125
sourceSHA: 9a370478cc757037e079820e11499ab663e8d72c89b608dbac720a473b7c0c29
---

# 如何以根用户身份运行 RabbitMQ

:::info 适用版本
ACP 3.12 及更高版本。
:::

## 背景

RabbitMQ 通常以非根用户身份运行内部进程。一些环境需要根级别的访问权限，以便与现有存储或平台约束进行集成。

## 配置

将以下覆盖添加到 `RabbitmqCluster`：

```yaml
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: my-rabbitmq
spec:
  override:
    statefulSet:
      spec:
        template:
          spec:
            securityContext:
              runAsUser: 0
```

## 验证

检查 RabbitMQ pod 中的运行用户：

```bash
kubectl -n <namespace> exec -ti my-rabbitmq-server-0 -- id
```

预期结果包括：

```text
uid=0(root)
```

## 注意事项

- 仅在环境要求时使用根用户。
- 在应用此更改之前，请检查存储权限、初始化容器行为和安全策略影响。
