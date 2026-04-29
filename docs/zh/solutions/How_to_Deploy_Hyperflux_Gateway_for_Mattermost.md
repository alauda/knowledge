---
products:
  - Alauda AI
kind:
  - Solution
id: KB260400015
sourceSHA: 4c51e8b6d50b3fcc1ccdc246ca784e32551ffb64f13401f7ecab5089d15a0177
---

# 如何为 Mattermost 部署 Hyperflux Gateway

## 问题

本解决方案描述了如何部署 Hyperflux Gateway，以便 Mattermost 用户可以通过直接消息或在频道中提及机器人来提问。它旨在为需要基于 Kubernetes 的部署方法的操作员提供支持，该方法与打包的发布包一起使用，并支持标准的安装后验证。

## 环境

在部署之前，请准备以下内容：

- 可访问的 Mattermost 服务 URL。
- 具有访问 **系统控制台** 权限的 Mattermost 管理员账户。
- 一个正在运行的 Hyperflux 环境。
- 可以安装 Hyperflux Gateway 的 Kubernetes 集群。
- 包含 `install-k8s.sh`、`uninstall-k8s.sh`、`install.env` 和 `image-metadata.json` 的 Hyperflux Gateway 发布包。

您可以从以下任一 URL 下载当前的发布包：

- `https://cloud.alauda.cn/attachments/knowledge/hyperflux-gateway/hyperflux-gateway-v0.1.3.tar.gz`
- `https://cloud.alauda.io/attachments/knowledge/hyperflux-gateway/hyperflux-gateway-v0.1.3.tar.gz`

如果包中包含 `images/` 目录，请在安装之前导入打包的镜像。

```bash
nerdctl load -i images/hyperflux-gateway-<version>.tar
nerdctl tag <loaded-image> <customer-registry>/hyperflux-gateway:<version>
nerdctl push <customer-registry>/hyperflux-gateway:<version>
IMAGE=<customer-registry>/hyperflux-gateway:<version> ./install-k8s.sh
```

## 解决方案

### 1. 在 Mattermost 中启用机器人账户创建

打开 Mattermost 管理员控制台：

```text
系统控制台 -> 集成 -> 集成管理
```

启用以下选项：

```text
启用机器人账户创建 = true
```

如果此选项被禁用，则在 **机器人账户** 页面上不会显示 **添加机器人账户** 按钮。

### 2. 创建机器人账户

打开：

```text
集成 -> 机器人账户
```

点击：

```text
添加机器人账户
```

推荐值：

```text
用户名: system-bot
显示名称: 系统机器人
描述: hyperflux-gateway 机器人
```

创建机器人后，记录其用户 ID 和用户名。

### 3. 创建机器人令牌

在 **机器人账户** 页面，找到目标机器人并点击：

```text
创建新令牌
```

例如：

```text
令牌描述: hyperflux-gateway
```

请立即复制生成的令牌，因为 Mattermost 只会显示一次。

### 4. 将机器人添加到目标团队和频道

将机器人添加到用户将与 Hyperflux Gateway 交互的团队和频道。

机器人模式下的默认行为：

- 直接发送给机器人的消息会被直接处理。
- 频道消息必须提及机器人，例如 `@system-bot hello`。
- 当机器人在一个线程中被提及时，Hyperflux Gateway 会重用相同的线程会话。

### 5. 配置 Hyperflux 身份验证

将 Hyperflux Gateway 所需的身份验证设置添加到 `cpaas-system/smart-doc-config` ConfigMap 中。`<hyperflux-api-secret>` 的值必须与稍后在 Hyperflux Gateway 安装期间使用的值匹配。

```bash
kubectl -n cpaas-system patch configmap smart-doc-config --type merge -p '{
  "data": {
    "HYPERFLUX_API_AUTH": "<hyperflux-api-secret>",
    "HYPERFLUX_API_AUTH_HEADER": "X-API-KEY"
  }
}'
```

更新 ConfigMap 后，验证 `smart-doc` 部署是否成功推出。

```bash
kubectl -n cpaas-system rollout status deployment/smart-doc --timeout=180s
```

### 6. 准备安装参数

发布包安装程序在包根目录中存在 `install.env` 时会自动读取该文件。填写所需的值：

| 变量                      | 描述                                                    |
| ------------------------- | ------------------------------------------------------- |
| `MATTERMOST_URL`          | 不带尾部 `/` 的 Mattermost 服务 URL。                   |
| `MATTERMOST_BOT_USER_ID`  | Mattermost 机器人用户 ID。                              |
| `MATTERMOST_BOT_USERNAME` | 不带 `@` 的 Mattermost 机器人用户名。                   |
| `MATTERMOST_TOKEN`        | 机器人的个人访问令牌。                                 |
| `HYPERFLUX_API_URL`       | 网关使用的 Hyperflux API 端点。                        |
| `HYPERFLUX_API_AUTH`      | 在 `smart-doc-config` 中配置的身份验证值。             |

其他参数使用 `install-k8s.sh` 中嵌入的默认值。仅在必要时覆盖它们。

### 7. 执行安装前检查

在安装之前，请确认以下内容：

1. `MATTERMOST_URL` 可以从目标环境访问。
2. `MATTERMOST_TOKEN` 是机器人令牌，而不是常规用户令牌。
3. `MATTERMOST_BOT_USER_ID` 和 `MATTERMOST_BOT_USERNAME` 属于同一个机器人账户。
4. `HYPERFLUX_API_AUTH` 与在 Hyperflux 中配置的值匹配。

### 8. 安装 Hyperflux Gateway

在准备好 `install.env` 后，运行：

```bash
./install-k8s.sh
```

安装程序会创建或更新以下资源：

- 命名空间
- 秘密
- ConfigMap
- 服务
- Web 部署
- Mattermost 工作程序部署

### 9. 在需要时覆盖镜像

如果客户环境使用不同的注册表或镜像位置，请在安装期间显式覆盖镜像：

```bash
IMAGE=<your-image-ref> ./install-k8s.sh
```

### 10. 在不应用的情况下验证生成的资源

使用干运行模式验证 Kubernetes 清单：

```bash
DRY_RUN=true ./install-k8s.sh
```

### 11. 仅在需要时启用斜杠命令或外发 Webhook

默认部署模式是 WebSocket 监听器机器人模式。如果还需要斜杠命令或外发 Webhook 集成，请在 `install.env` 中添加或覆盖以下设置，然后重新运行安装程序：

```bash
MATTERMOST_WEBHOOK_TOKEN=<slash-command-or-outgoing-webhook-token>
ENABLE_WEBSOCKET_WORKER=false
```

如果必须同时启用机器人模式和斜杠命令或 Webhook 模式，请使用：

```bash
MATTERMOST_WEBHOOK_TOKEN=<slash-command-or-outgoing-webhook-token>
ENABLE_WEBSOCKET_WORKER=true
```

在 Mattermost 中，还需确认：

```text
启用命令 = true
启用外发 Webhook = true
```

使用以下回调 URL：

```text
https://<gateway-domain>/mattermost/webhook
```

### 12. 卸载 Hyperflux Gateway

要移除发布：

```bash
./uninstall-k8s.sh
```

要同时移除命名空间：

```bash
DELETE_NAMESPACE=true ./uninstall-k8s.sh
```

## 诊断步骤

### 检查部署推出状态

```bash
kubectl -n hyperflux rollout status deployment/hyperflux-gateway-web --timeout=180s
kubectl -n hyperflux rollout status deployment/hyperflux-gateway-mattermost-worker --timeout=180s
```

### 检查健康端点

```bash
curl https://<gateway-domain>/healthz
```

预期输出：

```json
{"message":"ok"}
```

### 验证机器人交互行为

频道提及测试：

```text
@system-bot hello
```

预期结果：机器人在同一线程中回复。

直接消息测试：

```text
hello
```

预期结果：机器人在 DM 对话中直接回复。

非提及频道消息：

```text
hello everyone
```

预期结果：机器人不回复。

### 排查常见问题

**添加机器人账户按钮缺失**

验证以下 Mattermost 设置是否已启用：

```text
系统控制台 -> 集成 -> 集成管理 -> 启用机器人账户创建
```

**机器人多次回复**

这通常意味着多个监听器同时连接到 Mattermost。保持 WebSocket 监听器部署为单线程，并验证工作程序计数配置。

**频道消息未触发机器人**

默认情况下，频道消息必须提及机器人。验证消息是否包含 `@<bot-name>`。

**斜杠命令或 Webhook 请求未获得响应**

检查以下内容：

- 回调 URL 为 `https://<gateway-domain>/mattermost/webhook`。
- Mattermost 可以访问网关端点。
- `MATTERMOST_WEBHOOK_TOKEN` 与 Mattermost 生成的令牌匹配。
- `MATTERMOST_TOKEN` 是有效的机器人令牌。
- `HYPERFLUX_API_AUTH` 和 `HYPERFLUX_API_AUTH_HEADER` 与 Hyperflux 端的配置匹配。
