---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500101
sourceSHA: b0dc195280463bebfd28f39e1267a66dc4c669472ff12ea8aae76294306c67f8
---

# RocketMQ 部署因未验证的存储而失败

:::info 适用版本
所有在源页面中提到的当前受影响版本。
:::

## 问题

当 RocketMQ 使用需要 root 拥有权限的存储后端时，部署可能会失败，或者在默认的非 root 运行时模型下无法正常工作。

## 根本原因

出于安全原因，RocketMQ 容器默认不以 `root` 身份运行。一些客户提供的存储后端需要与默认容器用户不兼容的所有权或写权限，这导致集群创建或启动失败。

## 解决方案

通过自定义资源设置显式的安全上下文，并使用匹配的 `fsGroup`。

示例：

```yaml
spec:
  override:
    statefulSet:
      spec:
        template:
          spec:
            securityContext:
              runAsUser: 1001
              runAsGroup: 1001
              fsGroup: 1001
```

## 注意事项

- 仅在确认存储类或后端确实需要此设置后应用。
- 更改后重新验证卷挂载权限。
