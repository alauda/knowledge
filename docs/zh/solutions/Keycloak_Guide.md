---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
id: KB260200005
sourceSHA: fc2ad51ab4141170dc763f4b2f2615a97d451e517851775a2fa9e71da36a8b58
---

# Keycloak 概述

Keycloak 是一个开源的企业级身份和访问管理（IAM）解决方案，由 Red Hat 主导。它为应用程序、API 和微服务提供统一的身份认证、授权和用户管理能力，支持多种主流身份认证协议。其核心设计理念强调集中身份控制、高安全性、可扩展性和云原生适应能力。

## 主要特性

- **架构**：采用模块化、微服务友好的架构，支持集群部署和横向扩展，具备完整的高可用设计和数据同步机制。
- **身份认证协议**：全面支持 OpenID Connect (OIDC)、SAML 2.0 和 OAuth 2.0 等主流身份协议，兼容各种客户端应用（Web、移动、API）。
- **安全性**：内置多因素认证（MFA）、单点登录（SSO）、身份联合和细粒度权限控制；支持密码策略管理、LDAP/Active Directory 集成、密钥轮换和加密存储。
- **集成能力**：提供丰富的 API 和客户端适配器，便于与 Java、Python 和 Node.js 等各种技术栈的应用集成；支持自定义身份认证流程和用户存储适配器。
- **云原生支持**：与 Docker/Kubernetes 深度集成，支持容器化部署；提供官方 Operator 简化在 Kubernetes 环境中的部署、操作、维护和扩展。

## 典型用例

- **企业级单点登录（SSO）**：为 ERP、CRM 和 OA 等内部企业系统提供统一的身份认证，实现“一次登录多系统访问”，提升用户体验和管理效率。
- **云原生应用身份控制**：为 Kubernetes 微服务和无服务器应用提供 API 授权和服务间身份认证，确保微服务架构的安全通信。
- **外部用户身份管理**：为 B2C 电子商务平台和 B2B 合作伙伴门户提供用户注册、登录和权限管理，支持社交登录（Google、Facebook 等）和第三方身份联合。
- **遗留系统身份现代化**：替换传统过时的身份认证系统，为遗留应用提供标准化的身份认证接口，平滑迁移到现代身份管理架构。

# Keycloak 与 Red Hat 单点登录（RH-SSO）比较

| 类别                      | Keycloak                                                                                                 | Red Hat 单点登录（RH-SSO）                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **维护者**                | Community（Red Hat 工程师 + 社区贡献者）                                                               | Red Hat 商业团队                                                                                                               |
| **发布周期**              | 快速迭代和频繁更新，优先支持新技术特性                                                                  | 缓慢迭代，严格测试以满足企业级标准，专注于稳定性                                                                                 |
| **支持生命周期**          | 短（通常每个版本支持 6-12 个月）                                                                        | 提供长达 7 年以上的商业支持（包括安全补丁和错误修复）                                                                           |
| **稳定性**                | 可能包含实验性功能，某些场景下的稳定性需要用户验证                                                      | 企业级稳定性，在多种场景中经过验证，兼容主流企业系统                                                                             |
| **功能**                  | 涵盖核心身份管理功能，包括一些实验性功能                                                                | 选择稳定功能并附加企业级增强功能（例如，先进监控、专属支持工具）                                                               |
| **文档与支持**            | 社区文档，没有官方 SLA 保证，问题依赖社区讨论解决                                                        | Red Hat 官方文档和知识库，提供 SLA 级别的商业支持和技术咨询                                                                     |
| **许可证**                | Apache License 2.0（开源且免费）                                                                         | 需要 Red Hat 商业订阅                                                                                                          |
| **参考**                  | [Keycloak 官方文档](https://www.keycloak.org/documentation)                                            | [Red Hat 单点登录官方文档](https://docs.redhat.com/en/documentation/red_hat_single_sign-on/7.6)                             |

# 快速开始

本章提供的配置仅适用于**开发/测试环境**，仅支持在 Kubernetes 集群内或通过端口转发访问。对于生产环境，需要额外配置入口主机信息和 TLS 加密，以确保访问安全。

## 核心描述

- Keycloak 部署依赖于数据库（以 PostgreSQL 为例），下面将提供与数据库相关的资源和 Keycloak 实例的 YAML 配置；
- 有关详细的数据库配置，请参阅官方文档：[Keycloak 数据库配置指南](https://www.keycloak.org/server/db)；
- 有关基本的 Keycloak 部署，请参阅官方文档：[Keycloak Operator 基本部署指南](https://www.keycloak.org/operator/basic-deployment)。

## 配置列表

### PostgreSQL 数据库

```yaml
# PostgreSQL Secret
apiVersion: v1
kind: Secret
metadata:
  name: keycloak-db-secret
stringData:
  username: "kc-user"
  password: "testpassword"
type: Opaque
---
# PostgreSQL StatefulSet
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql-db
spec:
  serviceName: postgres-db
  selector:
    matchLabels:
      app: postgresql-db
  replicas: 1
  template:
    metadata:
      labels:
        app: postgresql-db
    spec:
      containers:
        - name: postgresql-db
          image: quay.io/sclorg/postgresql-15-c9s:latest
          volumeMounts:
            - mountPath: /var/lib/pgsql/data
              name: cache-volume
          env:
            - name: POSTGRESQL_USER
              valueFrom:
                secretKeyRef:
                  key: username
                  name: keycloak-db-secret
            - name: POSTGRESQL_PASSWORD
              valueFrom:
                secretKeyRef:
                  key: password
                  name: keycloak-db-secret
            - name: POSTGRESQL_DATABASE
              value: keycloak
      volumes:
        - name: cache-volume
          # WARNING: emptyDir will lose all data on pod restart/deletion.
          # For production, use a PersistentVolumeClaim instead.
          emptyDir: {}
---
# PostgreSQL StatefulSet Service
apiVersion: v1
kind: Service
metadata:
  name: postgres-db
spec:
  selector:
    app: postgresql-db
  ports:
  - port: 5432
    targetPort: 5432
```

### Keycloak 实例

```yaml
apiVersion: k8s.keycloak.org/v2alpha1
kind: Keycloak
metadata:
  name: example-kc
spec:
  instances: 1
  db:
    vendor: postgres
    host: postgres-db
    usernameSecret:
      name: keycloak-db-secret
      key: username
    passwordSecret:
      name: keycloak-db-secret
      key: password
  http:
    httpEnabled: true
  ingress:
    enabled: false
  additionalOptions:
    - name: metrics-enabled
      value: "true"
    - name: hostname-strict
      value: 'false'
  unsupported:
    podTemplate:
      spec:
        containers:
          - securityContext:
              allowPrivilegeEscalation: false
              runAsNonRoot: true
              capabilities:
                drop:
                  - ALL
              seccompProfile:
                type: RuntimeDefault
```

### 部署说明

1. 按上述顺序执行 YAML 配置（先部署 PostgreSQL，然后部署 Keycloak）；
2. 出于调试和开发目的，您可以使用端口转发直接连接到 Keycloak 服务。例如，运行以下命令：

```bash
kubectl port-forward service/example-kc-service 8080:8080
```

3. 通过浏览器访问管理控制台，地址为 `http://localhost:8080`。
4. 生产环境适配：启用入口并配置主机和 TLS 加密。示例如下（根据实际环境进行调整）：

```yaml
apiVersion: k8s.keycloak.org/v2alpha1
kind: Keycloak
metadata:
  name: example-kc
spec:
  instances: 1
  db:
    vendor: postgres
    host: postgres-db
    usernameSecret:
      name: keycloak-db-secret
      key: username
    passwordSecret:
      name: keycloak-db-secret
      key: password
  http:
    tlsSecret: example-tls-secret
  ingress:
    className: nginx
    tlsSecret: example-tls-secret
  additionalOptions:
    - name: metrics-enabled
      value: "true"
  hostname:
    hostname: test.keycloak.org
  proxy:
    headers: xforwarded # default nginx ingress sets x-forwarded
  unsupported:
    podTemplate:
      spec:
        containers:
          - securityContext:
              allowPrivilegeEscalation: false
              runAsNonRoot: true
              capabilities:
                drop:
                  - ALL
              seccompProfile:
                type: RuntimeDefault
```

## 访问管理控制台

在部署 Keycloak 时，Operator 会生成一个随机的初始管理员用户名和密码，并将这些凭据存储为基本认证类型的 Secret 对象，该对象与 Keycloak 自定义资源（CR）位于同一命名空间。

要获取初始管理员凭据，您需要读取并解码相应的 Secret 对象。该 Secret 的名称由 Keycloak CR 名称加上固定后缀 `-initial-admin` 组成。要获取名为 `example-kc` 的 CR 的管理员用户名和密码，请运行以下命令：

```bash
kubectl get secret example-kc-initial-admin -o jsonpath='{.data.username}' | base64 --decode
kubectl get secret example-kc-initial-admin -o jsonpath='{.data.password}' | base64 --decode
```

您可以使用这些凭据访问 Keycloak 管理控制台或管理 REST API。

# Red Hat SSO (RH-SSO) 迁移指南至 Keycloak

## 迁移概述

Red Hat 单点登录（RH-SSO）7.x 是由 Red Hat 基于 **Keycloak 社区版** 开发的商业发行版，两者在核心数据模型和存储结构上 **完全兼容**。

此迁移解决方案采用 **官方推荐的导出/导入机制**，实现以下数据的完整迁移：

- 领域配置
- 用户（包括凭据和状态）
- 领域角色 / 客户端角色
- 客户端及其权限映射
- 复合角色和内置管理权限

### 整体迁移流程

```
RH-SSO (OpenShift)
   ↓ 导出为 JSON 文件
本地服务器
   ↓ 复制迁移文件
Keycloak (Kubernetes)
   ↓ 导入 JSON 文件
迁移完成
```

### 步骤

#### 从 RH-SSO（OpenShift 环境）进行完整数据导出

```bash
## 进入 RH-SSO Pod
oc rsh <RH-SSO-Pod-Name>
## 执行导出命令
/opt/eap/bin/standalone.sh -c standalone-openshift.xml -Dkeycloak.migration.action=export -Dkeycloak.migration.provider=singleFile -Dkeycloak.migration.file=/tmp/sso-export.json -Dkeycloak.migration.usersExportStrategy=REALM_FILE -Djboss.socket.binding.port-offset=502
```

#### 跨集群复制迁移文件

```bash
oc cp <RH-SSO-Pod-Name>:/tmp/sso-export.json /tmp/sso-export.json
kubectl cp /tmp/sso-export.json <namespace>/<keycloak-pod>:/tmp/sso-export.json
```

#### 数据导入到 Keycloak

```bash
## 进入运行中的 Keycloak Pod
kubectl exec -it <Keycloak-Pod-Name> -n <Target-Namespace> -- /bin/bash
## 执行导入命令
/opt/keycloak/bin/kc.sh import --file /tmp/sso-export.json --override true
```

### 注意事项

- 导入成功标准：执行 Keycloak 导入命令后，日志打印 `Realm 'xxxxxx' imported`，表示数据导入完成。最后提示 `ERROR: Address already in use` 是端口冲突，不会影响数据导入结果。
- 数据完整性验证：导入完成后，登录 Keycloak 管理控制台，验证领域列表、用户数量、客户端配置、角色权限等数据与源 RH-SSO 一致。

## 参考文档

- [RH-SSO 7.6 迁移文档](https://docs.redhat.com/en/documentation/red_hat_single_sign-on/7.6/html/server_administration_guide/assembly-exporting-importing_server_administration_guide)
- [Keycloak 迁移文档](https://www.keycloak.org/server/importExport)
