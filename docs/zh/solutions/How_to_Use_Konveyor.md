---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
id: KB260100023
sourceSHA: 986b9b0d5648d8648b27487418da8454b121df6b232f4ad72ca51ad0e34d344b
---

# 如何部署和使用 Konveyor

## 概述

Konveyor 是一个 CNCF（云原生计算基金会）项目，提供了一个模块化的平台用于应用现代化。它支持现代化的整个生命周期：发现、评估、分析和执行。本指南涵盖了部署 Konveyor Hub（Tackle）平台及其核心组件。

## 先决条件

- 具有 kubectl 访问权限的 Kubernetes 集群
- 支持 ReadWriteMany (RWX) 访问模式的 StorageClass
- 用于 RWO 卷（数据库）的 StorageClass
- （可选）用于外部访问的 LoadBalancer 或 Ingress Controller

## 安装 Konveyor Operator

从 [Alauda Cloud Console](https://cloud.alauda.io/) Marketplace 下载 Konveyor Operator 插件，并按照 [上架软件包](https://docs.alauda.io/container_platform/4.2/extend/upload_package.html) 指南将插件上传到集群。

## 部署 Konveyor Hub (Tackle)

### 创建 Tackle 实例

通过创建 Tackle CR 部署 Tackle 平台。Tackle 实例必须在与 konveyor-operator 相同的命名空间中部署。

```yaml
cat << EOF | kubectl create -f -
apiVersion: tackle.konveyor.io/v1alpha1
kind: Tackle
metadata:
  name: tackle
  namespace: konveyor-tackle
spec:
  feature_auth_required: true
  feature_isolate_namespace: true
  feature_analysis_archiver: true
  hub_database_volume_size: 5Gi
  hub_bucket_volume_size: 100Gi
  rwx_supported: true
  hub_bucket_storage_class: nfs        # 替换为您的 RWX StorageClass
  rwo_storage_class: sc-topolvm         # 替换为您的 RWO StorageClass
  cache_storage_class: nfs
  cache_data_volume_size: 100Gi
EOF
```

### 验证部署

检查 `konveyor-tackle` 命名空间中的 pod 状态：

```bash
kubectl get pods -n konveyor-tackle
```

确保所有 pod 都处于 `Running` 或 `Completed` 状态，然后再继续。

> \[!WARNING]
> Tackle 实例必须在与 `konveyor-operator` 相同的命名空间中部署。如果您在不同的命名空间中部署，操作员创建的一些资源（如 PersistentVolumeClaims、ConfigMaps、Secrets 和 ServiceAccounts）在删除 Tackle 自定义资源时可能不会自动删除。在这种情况下，您必须手动清理受影响命名空间中的这些资源，例如：
>
> ```bash
> # 删除标记为 Tackle 实例的公共资源
> kubectl delete pvc,configmap,secret,sa -l app.kubernetes.io/instance=tackle -n konveyor-tackle
> ```

### 配置选项

| 名称                                      | 默认值  | 描述                                                          |
| ----------------------------------------- | ------- | ------------------------------------------------------------- |
| `spec.feature_auth_required`              | `true`  | 启用 Keycloak 身份验证（设置为 `false` 以实现单用户/无身份验证） |
| `spec.feature_isolate_namespace`          | `true`  | 通过网络策略启用命名空间隔离                                  |
| `spec.feature_analysis_archiver`          | `true`  | 在创建新分析报告时自动归档旧的分析报告                      |
| `spec.rwx_supported`                      | `true`  | 集群是否支持 RWX 卷                                          |
| `spec.hub_database_volume_size`           | `5Gi`   | 请求的 Hub 数据库卷大小                                      |
| `spec.hub_bucket_volume_size`             | `100Gi` | 请求的 Hub 存储桶卷大小                                      |
| `spec.keycloak_database_data_volume_size` | `1Gi`   | 请求的 Keycloak 数据库卷大小                                  |
| `spec.cache_data_volume_size`             | `100Gi` | 请求的 Tackle 缓存卷大小                                      |
| `spec.cache_storage_class`                | N/A     | 请求的 Tackle 缓存卷的 StorageClass                          |
| `spec.hub_bucket_storage_class`           | N/A     | 请求的 Tackle Hub 存储桶卷的 StorageClass（RWX）             |
| `spec.rwo_storage_class`                  | N/A     | 请求的 RWO 数据库卷的 StorageClass                            |

## 访问 Tackle UI

### 通过端口转发快速访问

1. 设置端口转发：

   ```bash
   kubectl -n konveyor-tackle port-forward service/tackle-ui 8080:8080
   ```

2. 在浏览器中打开 <http://127.0.0.1:8080>。

### 初始化管理员账户

内置的 Keycloak 在启动时生成一个随机密码。这是 Keycloak 的根密码，存储在 `tackle-keycloak-sso` secret 中。

1. 检索 Keycloak 管理员凭据：

   ```bash
   # 获取用户名（默认：admin）
   kubectl -n konveyor-tackle get secret tackle-keycloak-sso -o jsonpath='{.data.username}' | base64 -d

   # 获取密码
   kubectl -n konveyor-tackle get secret tackle-keycloak-sso -o jsonpath='{.data.password}' | base64 -d
   ```

2. 登录到 Keycloak 管理控制台 <http://127.0.0.1:8080/auth/admin/>

3. 重置 Tackle 管理员密码：
   - 从下拉菜单中选择 **tackle** Realm（而不是 Master Realm）
   - 在左侧菜单中点击 **Users**
   - 找到并选择 **admin** 用户
   - 点击 **Credentials** 标签
   - 输入新密码（例如，`admin@123`）
   - 禁用 **Temporary** 切换
   - 点击 **Reset Password**

4. 使用管理员用户和新密码登录 Tackle，地址为 <http://127.0.0.1:8080>。

### 通过 Ingress 安全访问（生产环境）

端口转发仅用于临时访问。对于生产环境，请配置带有 TLS 的 Ingress。

#### Ingress 先决条件

- 一个域名（例如，`tackle.example.com`）
- 部署的 LoadBalancer 服务（请参见 [ALB 部署指南](https://docs.alauda.io/container_platform/4.1/configure/networking/how_to/alb/deploy_alb.html)）
- 安装 cert-manager

#### 创建 TLS 证书

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: tackle-ssl-cert
  namespace: konveyor-tackle
spec:
  commonName: tackle.example.com
  dnsNames:
    - tackle.example.com
  issuerRef:
    kind: ClusterIssuer
    name: cpaas-ca              # 替换为您的 Issuer
  secretName: tackle-tls-secret
  usages:
    - server auth
    - client auth
```

#### 创建 Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: HTTP
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
  name: tackle-ui-tls-ingress
  namespace: konveyor-tackle
spec:
  ingressClassName: nginx    # 替换为您的 Ingress Class
  rules:
    - host: tackle.example.com
      http:
        paths:
          - backend:
              service:
                name: tackle-ui
                port:
                  number: 8080
            path: /
            pathType: Prefix
  tls:
    - hosts:
        - tackle.example.com
      secretName: tackle-tls-secret
```

> \[!NOTE]
> 将 `tackle.example.com` 替换为您的实际域名。

通过 `https://tackle.example.com` 访问 Tackle。

## 启用 KAI（Konveyor AI）

KAI 使用 AI 服务提供 AI 驱动的代码迁移辅助。它支持多个提供商和模型。

### 支持的提供商和模型

| 提供商 (`kai_llm_provider`) | 模型 (`kai_llm_model`)                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| `openai`                    | `gpt-4`、`gpt-4o`、`gpt-4o-mini`、`gpt-3.5-turbo`                              |
| `azure_openai`              | `gpt-4`、`gpt-35-turbo`                                                        |
| `bedrock`                   | `anthropic.claude-3-5-sonnet-20241022-v2:0`、`meta.llama3-1-70b-instruct-v1:0` |
| `google`                    | `gemini-2.0-flash-exp`、`gemini-1.5-pro`                                       |
| `ollama`                    | `llama3.1`、`codellama`、`mistral`                                             |
| `groq`                      | `llama-3.1-70b-versatile`、`mixtral-8x7b-32768`                                |
| `anthropic`                 | `claude-3-5-sonnet-20241022`、`claude-3-haiku-20240307`                        |

### 在 Tackle 中启用 KAI

1. 更新 Tackle 配置：

   ```yaml
   apiVersion: tackle.konveyor.io/v1alpha1
   kind: Tackle
   metadata:
     name: tackle
     namespace: konveyor-tackle
   spec:
     kai_solution_server_enabled: true
     kai_llm_provider: openai              # 选择您的提供商
     kai_llm_model: gpt-4o-mini            # 选择您的模型
   ```

2. 创建 API 凭据 secret：

   **对于 OpenAI：**

   ```bash
   kubectl create secret generic kai-api-keys -n konveyor-tackle \
     --from-literal=OPENAI_API_BASE='https://api.openai.com/v1' \
     --from-literal=OPENAI_API_KEY='<YOUR_OPENAI_KEY>'
   ```

   **对于 Google：**

   ```bash
   kubectl create secret generic kai-api-keys -n konveyor-tackle \
     --from-literal=GOOGLE_API_KEY='<YOUR_GOOGLE_API_KEY>'
   ```

3. 强制操作员进行调和并获取新凭据：

   ```bash
   kubectl patch tackle tackle -n konveyor-tackle --type=merge -p \
     '{"metadata":{"annotations":{"konveyor.io/force-reconcile":"'"$(date +%s)"'"}}}'
   ```

## Konveyor 组件概述

Konveyor 提供了一个模块化架构用于应用现代化：

| 组件                     | 描述                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Konveyor Hub**        | 提供统一应用清单、评估模块（风险评估）和分析模块（静态代码分析）的中央控制平面。实现了带有管理员、架构师和迁移者角色的 RBAC。                                                                 |
| **Kantra & Analyzer-LSP** | CLI 工具用于离线静态分析。Analyzer-LSP 通过语言服务器协议集成到 IDE（VSCode）中，以实时检测迁移问题。                                                                                                 |
| **Konveyor AI (KAI)**   | 基于 RAG 的 AI 助手，用于自动化代码修复。使用已解决事件存储进行上下文感知的代码补丁生成。                                                                                                                   |
| **Move2Kube**           | 自动化从 Cloud Foundry/OpenShift 转换到 Kubernetes。三个阶段：收集、计划、转换。生成 Dockerfile、K8s 清单、Helm Charts 和 Tekton Pipelines。                                                              |
| **Forklift**            | 用于将虚拟机从 VMware vSphere、oVirt 或 OpenStack 迁移到 KubeVirt 的虚拟机迁移工具。                                                                                                                                 |
| **Crane**               | 用于集群升级或跨分发迁移的 Kubernetes 到 Kubernetes 迁移工具。使用 Restic 或 VolSync 处理 PV 数据同步。                                                                                                     |

## 参考

- [Konveyor 官方文档](https://konveyor.io/docs/konveyor/)
- [Konveyor 管理任务](https://konveyor.io/docs/konveyor/admintasks/)
- [Konveyor Operator 仓库](https://github.com/konveyor/operator)
