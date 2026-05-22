---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB260500096
sourceSHA: cb9d3a791e4487d4e78610652bca01706c4962b730cb6909fe94aea8306378b4
---

# 如何在 Redis Sentinel 节点上设置密码

## 介绍

本指南解释了如何在 Redis Sentinel 模式实例的 Sentinel 节点上配置密码。虽然 Sentinel 节点不存储用户数据，但它们可以操作 Redis 集群的拓扑（例如，通过触发故障转移）。用密码保护它们可以防止未经授权的客户端干扰集群。

在 Redis 5.0.1 中引入了对 Sentinel 的原生密码支持。Alauda Cache Service for Redis OSS 从 redis-operator 3.18 开始提供此功能。

:::info 适用版本
redis-operator >= 3.18（仅限 Sentinel 模式）
:::

:::warning

- Sentinel 节点凭据与数据节点凭据是独立的。它们作为两个独立的密码链进行管理。
- 更改 Sentinel 密码会导致 **所有实例 Pod 重启**。
- 在 **redis-operator 3.18** 上，S3 备份与 Sentinel 保护的实例不兼容。在依赖此组合的后续版本之前，请验证您的操作员发布说明。
  :::

## 先决条件

- 目标集群中已安装 redis-operator 3.18 或更高版本。
- Redis 实例正在使用 Sentinel 架构。
- 您有权限在目标命名空间中创建 Secrets。

## 操作步骤

### 在实例创建时设置 Sentinel 密码

1. 在与 Redis 实例相同的命名空间中创建一个 Secret：

   ```bash
   kubectl -n <namespace> create secret generic <sentinel-password-secret> \
     --from-literal=password=<your-password>
   ```

   :::note
   Secret 必须与 Redis 实例位于 **同一命名空间**。请勿将数据节点密码 Secret 重用为 Sentinel 密码 — 它们必须是不同的 Secrets。
   :::

2. 在实例创建页面，切换到 YAML 选项卡并添加 Sentinel 密码引用：

   ```yaml
   spec:
     sentinel:
       passwordSecret: "<sentinel-password-secret>"
   ```

3. 提交表单以创建实例。

### 更新 Sentinel 密码

要轮换 Sentinel 密码：

1. 创建一个包含新密码的新 Secret：

   ```bash
   kubectl -n <namespace> create secret generic <new-sentinel-password-secret> \
     --from-literal=password=<new-password>
   ```

2. 更新 Redis CR 中的 `spec.sentinel.passwordSecret` 以引用新 Secret。

:::warning

- 您必须轮换到一个 **新的** Secret。更新现有 Secret 内部的值而不更改引用将不会被操作员识别。
- 当 Sentinel 密码被轮换时，所有实例 Pod 会重启。请相应地计划操作。
  :::

## 重要注意事项

- Sentinel 和数据节点密码是独立管理的。更改一个不会影响另一个。
- S3 备份兼容性：在 **redis-operator 3.18** 上确认不兼容。后续版本可能已解除此限制 — 在假设限制仍然适用之前，请检查您的操作员发布说明。
- 在 UI 中从表单视图切换回 YAML 视图可能会覆盖手动编辑。请通过直接 CR 编辑或通过 YAML 选项卡进行 Sentinel 密码更改，而不是通过表单进行往返。
