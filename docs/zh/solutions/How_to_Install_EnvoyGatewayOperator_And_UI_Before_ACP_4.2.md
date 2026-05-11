---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB251200023
sourceSHA: ad6e1154aa86fde7b6b89ef8860b229084e5390660ab1f2c9d703d0767617dc9
---

# 如何在 ACP 4.2 之前安装 Envoy Gateway Operator 和 UI

## 概述

本指南解释了如何手动安装适用于 ACP 版本 4.2 之前的 Envoy Gateway Operator 和 GatewayAPI UI。

**注意：**

- **ACP 4.2+**：Envoy Gateway Operator 可以直接在 OperatorHub 中获取。您可以跳过“安装 Operator”部分。
- **ACP 4.3+**：GatewayAPI UI 包已预安装。您可以跳过“安装 GatewayAPI UI”部分。

## 安装 Operator

### 先决条件

在安装 Envoy Gateway Operator 之前，请确保满足以下要求：

1. **Gateway API CRDs**：必须在您的集群中安装 Gateway API 自定义资源定义，因为 Envoy Gateway 依赖于它们。

2. **安装包**：从 Alauda Cloud 下载 Envoy Gateway Operator 安装文件，并将其重命名为 `envoy-gateway-operator.tgz`。

3. **发布到平台仓库**：使用 `violet` 命令将包发布到平台仓库：

   ```bash
   violet push --debug --platform-address $ACP_PLATFORM_ADDRESS --platform-username $ACP_PLATFORM_USERNAME --platform-password $ACP_PLATFORM_PASSWORD ./envoy-gateway-operator.tgz
   ```

### 安装步骤

#### 步骤 1：安装 Operator

1. 导航到 **管理员** > **Marketplace** > **OperatorHub**
2. 在 **Networking** 类别和 **Alauda** 来源下，找到 **Envoy Gateway Operator**
3. 点击 **安装** 开始安装过程
4. 在 **安装 Alauda 版本的 Envoy Gateway** 对话框中，点击 **安装**
5. 点击 **确认** 完成安装

安装完成后，状态将在 OperatorHub 页面上更改为 **已安装**。

#### 步骤 2：创建 EnvoyGatewayCtl 实例

1. 在 OperatorHub 页面，点击 **Alauda 版本的 Envoy Gateway** 打开其详细信息页面
2. 导航到 **所有实例** 标签
3. 点击 **创建** 创建一个新实例
4. 选择 **EnvoyGatewayCtl** 作为实例类型，然后点击 **创建**
5. 在大多数情况下，默认配置即可。点击 **创建** 完成设置。

##### 如何为 Operator 添加 Taint Tolerations

```bash
kubectl -n envoy-gateway-operator patch subscription envoy-gateway-operator  \
  --type='merge' \
  -p='{
    "spec": {
      "config": {
        "tolerations": [
          {
            "operator": "Exists"
          }
        ]
      }
    }
  }'
```

###### 如何检查 Operator 状态

安装后，您可以使用以下方法验证 Operator 状态：

```bash
kubectl get pods -n envoy-gateway-operator
```

当以下条件满足时，Operator 正在正常运行：

- `envoy-gateway-operator` 命名空间中的所有 pod 均处于 **Running** 状态

## 安装 GatewayAPI UI

### 重要说明

- **ACP 版本 4.2 之前**：只有平台管理员可以通过 UI 创建网关。其他用户角色在尝试创建网关时将遇到错误。

- **ACP 4.2**：如果您在 ACP 4.2 中安装 GatewayAPI UI 插件，可以通过运行以下命令隐藏旧的 UI 页面：

  ```bash
  kubectl patch alaudafeaturegates.alauda.io gatewayapi -n cpaas-system --type=merge -p '{"spec":{"enabled":false}}'
  ```

- **已知限制**：在使用此手动方法安装的环境中创建策略时，用户信息和创建/更新时间戳将不会自动填充。

### 先决条件

在安装 GatewayAPI UI 之前，请确保满足以下要求：

1. **Envoy Gateway Operator**：必须安装 Envoy Gateway Operator（请参见前一部分）。

2. **UI 插件包**：从 Alauda Cloud 下载 GatewayAPI 插件安装文件，并将其重命名为 `gatewayapi-plugin.tgz`。

3. **发布到平台仓库**：使用 `violet` 命令将插件发布到平台仓库：

   ```bash
   violet push --debug --platform-address $ACP_PLATFORM_ADDRESS --platform-username $ACP_PLATFORM_USERNAME --platform-password $ACP_PLATFORM_PASSWORD gatewayapi-plugin.tgz
   ```

### 安装步骤

1. 导航到 **管理员** > **Marketplace** > **集群插件**
2. 切换到 `global` 集群
3. 找到并安装 **Alauda Container Platform GatewayAPI 插件**
4. 安装完成后，**Container Platform** > **Network** 下将出现新的 **Gateway** 菜单项
