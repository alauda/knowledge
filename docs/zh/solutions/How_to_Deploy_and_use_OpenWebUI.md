---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB260400008
sourceSHA: f1be415ee1ff1f3d0d5a876086a9b40949bf2442cb308bc2bef21cccf3fd14b3
---

# OpenWebUI

## 概述

OpenWebUI 是一个开源的 AI Web 界面，通过统一的入口点支持与多个兼容 OpenAI 协议的推理后端（如 vLLM、MLServer、XInference 等）对接。它用于文本生成、多模态输入和语音输入等场景。它提供了可扩展的外部工具机制，以便于集成检索、函数调用和第三方服务。适合在本地或云中以容器方式部署，支持持久数据和基于 Ingress 的 HTTPS 访问。

## 基本功能

- **对话与文本生成**：支持系统提示、可调参数（温度、长度等）和会话管理。
- **多模态与语音**：将图像/文档作为上下文，语音输入/转录（依赖于后端能力）。
- **外部工具扩展**：可以调用检索、数据库、HTTP API 等，构建工具增强的工作流。
- **数据与安全**：会话和配置可以持久化；可以与身份验证、速率限制、日志/监控集成。

## 后端集成

- **协议兼容性**：支持与 OpenAI API 兼容的后端（如 vLLM、MLServer、XInference、TGI 等）。
- **连接参数**：基本 URL（例如 `http(s)://{backend}/v1`）、API 密钥、模型名称和默认推理参数。
- **多个后端**：在 UI 中配置，允许在不同的推理服务后端之间切换。

## 部署方案

按顺序创建以下资源。在这种情况下，选择一个独立的 `open-webui-ns` 命名空间。根据需要选择可用的命名空间。

### 命名空间

```bash
kubectl create ns open-webui-ns
```

### 创建特定的部署

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: open-webui
  name: open-webui
  namespace: open-webui-ns
spec:
  replicas: 1
  selector:
    matchLabels:
      app: open-webui
  template:
    metadata:
      labels:
        app: open-webui
    spec:  
      volumes:
      - name: webui-data
        emptyDir: {}
      containers:
      - image: ghcr.io/open-webui/open-webui
        name: open-webui
        ports:
        - containerPort: 8080
        env:
        - name: ENABLE_DIRECT_CONNECTIONS
          value: "true"
        - name: OPENAI_API_BASE_URL
          value: http://example-predictor/v1  # REPLACE with actual inference service URL
        - name: PORT
          value: "8080"
        volumeMounts:
          - name: webui-data
            mountPath: /app/backend/data
        resources:
          requests:
            cpu: 1000m
            memory: 128Mi
          limits: 
            cpu: 2000m
            memory: 1Gi
```

## 重要环境变量

相应的环境变量应进行配置。

### ENABLE_DIRECT_CONNECTIONS

- 设置为 true 以启用外部连接。
- 目的：允许在 OpenWebUI 中添加额外的外部推理服务后端。

### 安全考虑

**ENABLE_DIRECT_CONNECTIONS**：设置为 `true` 时，用户可以配置 OpenWebUI 连接到外部推理服务。请考虑以下事项：

- 仅在受信任的环境中或用户经过身份验证和授权时启用此功能
- 外部连接可能会暴露敏感数据或凭据
- 监控出站连接以防止数据外泄
- 考虑使用网络策略限制出口流量
- 对于生产环境，考虑将其设置为 `false` 并预配置允许的后端

### OPENAI_API_BASE_URL

- 指定默认的推理服务端点。
- 如果 OpenWebUI 和推理服务部署在同一集群中，请使用服务的内部集群地址。
- 有关地址的详细信息，请参阅：**AML 业务视图 / 推理服务 / 推理服务详情 / 访问方法**。
- 值的格式：`{{Cluster Internal URL}}/v1`。

### 验证

```bash
kubectl get deployment open-webui -n open-webui-ns -w
```

等待部署状态为 `1/1 Ready`。

## 访问 OpenWebUI

### 1. 通过 NodePort 服务查看 OpenWebUI

创建以下资源：

```yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: open-webui
  name: svc-open-webui
  namespace: open-webui-ns
spec:
  type: NodePort
  ports:
  - port: 8080
    protocol: TCP
    targetPort: 8080
  selector:
    app: open-webui
```

检查相关端口和节点 IP 以访问页面。

### 2. 初始设置

首次访问 OpenWebUI 时，您需要注册。为管理员帐户选择一个强密码。

### 3. 添加推理服务

转到 **设置 -> 连接 -> 添加连接**。
在这里，您需要添加推理服务地址。
您可以通过 **AML 业务视图 / 推理服务 / 推理服务详情 / 访问方法** 获取集群外部访问方法。
随后填写。请使用集群 **外部** 访问方法。
在 **添加连接** 弹出窗口中，填写：
`{{Cluster External URL}}/v1`

点击右侧图标以验证连接。成功后，点击保存。返回聊天页面以选择现有的推理服务进行使用。

### 4. 使用推理服务

进入聊天页面，选择上传的推理服务，探索更多功能，例如：

- 语音输入
- 多模态输入
- 外部工具
