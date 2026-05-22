---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500094
sourceSHA: 6bc3fd34067b8c196b56a1d18833cb5614e4fb7bf946a6514b552722ee730104
---

# 如何以根用户身份运行 Redis

:::info 适用版本

- Operator: `>= 3.10.3` 或 `>= 3.12.2`
- 架构: Sentinel, Cluster
  :::

## 介绍

默认情况下，Alauda Cache Service for Redis OSS 以非根用户 **`UID 999` / `GID 1000`** 运行容器以确保安全性。某些外部存储后端要求 Redis 以根用户身份运行，以便正确挂载或写入卷。本指南解释了如何配置 Redis Pod 的 `securityContext`，使容器以根用户身份运行，从而与这些存储系统集成。

## 需要根用户的存储后端

| 存储类型    | 需要根用户  | 备注                                                                                                                    |
| ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| CephFS       | — (已弃用)  | CephFS 集成在 operator 3.8 中已停止。请改用 NFS、EFS 或基于 CSI 的块存储类。                                           |
| NFS          | 有条件      | 仅在导出未授予 `others` 读/写权限时需要。优先修复导出，而不是启用根用户。                                           |
| EFS          | 是          | 默认的 AWS EFS 持久卷需要根用户。                                                                                        |

如果您的存储类不需要根访问权限，**请勿**启用此选项——以根用户身份运行会削弱容器的安全性。

## 操作步骤

对于 Sentinel 和 Cluster 模式，配置是相同的。在创建新的 Redis 实例时，切换到 YAML 视图并添加 `spec.securityContext` 以使容器以根用户身份运行。

### 示例

```yaml
apiVersion: middleware.alauda.io/v1
kind: Redis
metadata:
  name: <instance-name>
  namespace: <namespace>
spec:
  securityContext:
    runAsUser: 0
    runAsGroup: 0
    fsGroup: 0
  # ... 其余字段 (arch, replicas, resources, persistent, etc.)
```

应用资源：

```bash
kubectl apply -f <redis-instance>.yaml
```

实例创建后，验证 Pods 是否以根用户身份运行：

```bash
kubectl -n <namespace> exec -it <redis-pod> -- id
# 预期输出: uid=0(root) gid=0(root) groups=0(root)
```

## 重要注意事项

:::note
当您在 **现有** 实例上修补 `spec.securityContext` 时，operator 会立即更新底层 StatefulSet，但正在运行的 Pods **不会** 自动重启。要将更改应用于正在运行的 Pods，请手动删除每个 Pod（StatefulSet 控制器会使用新的安全上下文重新创建它们），或通过增加 CPU/内存等资源字段触发滚动重启。
:::

- 以根用户身份运行会扩展容器的权限。仅在底层存储严格要求时应用此配置。
- 对于 NFS，优先调整导出权限（授予 `others` 读/写）而不是在可行时以根用户身份运行。
- 将此配置与明确允许在 Redis 命名空间中使用特权 Pods 的 PodSecurity 策略结合使用，因为大多数集群范围的安全基线不允许根容器。
