---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2
tags:
  - LB
id: KB260500355
sourceSHA: 21091124f61165d93874ce1fa3fd494ac0155ddaf7815949ee64c13752e9f752
---

# 如何在 ACP 4.2 中安装共享网关的 GatewayAPI UI 插件

## 概述

ACP 4.2 包含一个内置的 GatewayAPI UI，但该 UI 并未针对 Envoy Gateway 共享网关场景进行适配。在创建或更新路由时，内置页面无法从其他命名空间的网关中选择监听器。这使得将一个网关作为来自多个命名空间的路由的共享流量入口点变得不方便。

本指南解释了如何在 ACP 4.2 上安装更新的 GatewayAPI UI 插件，并使用它替代内置的 GatewayAPI 页面。该插件是后续 ACP 版本中使用的 GatewayAPI UI；此操作步骤仅在 ACP 4.2 上提前安装它。

该操作步骤仅安装 UI 插件及其 API 服务。它不安装 Envoy Gateway 本身。

## 先决条件

在安装 GatewayAPI UI 插件之前，请确保满足以下要求：

1. **ACP 版本**：平台为 ACP 4.2。

2. **Envoy Gateway Operator**：Envoy Gateway Operator 必须已经安装并在将使用 GatewayAPI 资源的集群中可用。

3. **UI 插件包**：联系平台维护团队以获取 GatewayAPI 插件包，并将其重命名为 `gatewayapi-plugin.tgz`。

4. **管理员访问权限**：您可以对平台集群运行 `kubectl`，并可以使用 `violet` 上传集群插件包。

## 安装

### 步骤 1：隐藏内置的 GatewayAPI UI

在 ACP 4.2 上，使用插件页面之前，请禁用内置的 GatewayAPI 页面：

```bash
kubectl patch alaudafeaturegates.alauda.io gatewayapi -n cpaas-system --type=merge -p '{"spec":{"enabled":false}}'
```

这将隐藏旧的 UI 页面。它不会删除现有的 GatewayAPI 资源。

验证功能开关是否已禁用：

```bash
kubectl get alaudafeaturegates.alauda.io gatewayapi -n cpaas-system -o jsonpath='{.spec.enabled}{"\n"}'
```

预期输出为：

```text
false
```

### 步骤 2：上传 GatewayAPI UI 插件

使用 `violet` 命令将插件包发布到平台仓库：

```bash
violet push --debug --platform-address $ACP_PLATFORM_ADDRESS --platform-username $ACP_PLATFORM_USERNAME --platform-password $ACP_PLATFORM_PASSWORD gatewayapi-plugin.tgz
```

### 步骤 3：在全局集群上安装插件

1. 导航至 **管理员** > **Marketplace** > **集群插件**
2. 切换到 `global` 集群
3. 找到并安装 **Alauda Container Platform GatewayAPI Plugin**
4. 安装完成后，打开 **Container Platform** > **Network** > **Gateway**

仅在 `global` 集群上安装此插件。它为平台控制台提供 GatewayAPI UI 和 API 服务；工作负载集群不需要单独安装插件。

## 验证

1. 打开 **Container Platform** > **Network** > **Gateway**，确认新 Gateway 页面可用。
2. 在应用命名空间中打开路由创建或更新页面。
3. 在监听器选择字段中，确认该页面可以显示来自其他命名空间的网关的监听器，当该网关监听器允许来自路由命名空间的路由时。

## 已知限制

在使用此手动方法安装的环境中创建策略时，用户信息和创建/更新时间戳不会自动填充。
