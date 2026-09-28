---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3,4.4'
id: KB260900044
sourceSHA: 36173e57537b146458bee1bf6fd6ac3c8b25aa545221b1c6d13c279f6b5d948b
---

<!--
  Authoring model (oss-operator-factory): this guide is authored ONCE by hand. On later
  EDP Keycloak Operator releases, only the slots fenced with `factory:auto:*` markers below are
  updated by the factory pipeline (version, supported versions, known limitations).
  Do NOT hand-edit inside a factory:auto block — those are regenerated from component.yaml /
  release evidence. Prose outside the markers is human-owned and preserved across releases.
-->

# EDP Keycloak Operator — 安装指南

## 概述

**EDP Keycloak Operator** 是来自 KubeRocketCI 项目的开源
[EDP Keycloak Operator](https://github.com/epam/edp-keycloak-operator)，
在 Alauda Cloud 市场上列出，并可以从 ACP OperatorHub 安装。

它允许您将 Keycloak 服务器的 **配置** 作为 Kubernetes 资源进行管理，以便应用程序所需的身份设置可以与应用程序本身一起存储在 Git 中：

- **领域**，包括令牌生命周期、事件设置和用户配置策略。
- **客户端** — 公共、机密和服务账户客户端，以及它们的角色和重定向 URI。
- **用户、组和角色**，包括组成员资格和角色分配。
- **身份提供者**（GitHub、其他 OIDC 提供者等）及其映射器。
- **客户端范围、身份验证流程、领域组件和组织。**

每当您创建或更改资源时，Operator 会将其应用于 Keycloak，因此资源是进行更改的地方。通过 Keycloak 管理控制台手动进行的编辑不会立即被还原：它会保留，直到下次应用资源时 — 当您更改资源或 Operator 重启时。

> **它需要一个现有的 Keycloak 25 或更高版本，并且不会自行部署一个。** 首先安装 Keycloak —
> 例如 **Alauda Application Services 身份管理 E1** — 然后将此 Operator 指向它。 [与身份管理 E1 一起使用](#use-it-with-alauda-application-services-identity-management-e1)
> 逐步介绍整个设置过程。

### 支持的版本

<!-- factory:auto:supported-versions BEGIN -->

| 项目                           | 版本                  |
| ------------------------------ | ---------------------- |
| ACP                            | 4.1, 4.2, 4.3, 4.4     |
| 架构                          | amd64 (x86_64), arm64 |
| 网络                          | IPv4, IPv6             |
| EDP Keycloak Operator (bundle) | v1.35.0                |
| EDP Keycloak Operator          | 1.35.0                 |
| 可管理的 Keycloak 服务器      | 25 或更高              |
| 许可证                        | Apache-2.0             |

<!-- factory:auto:supported-versions END -->

## 先决条件

- 一个支持上述版本的 ACP 集群，以及对目标业务集群的 `cluster-admin` 访问权限。
- 一个 **Keycloak 25 或更高版本**，该集群可以访问。本文其余部分使用
  **Alauda Application Services 身份管理 E1**；任何 Keycloak 25+ 的工作方式相同，只要您拥有其 URL 和管理员凭证。
- 集群的 OperatorHub 中可用的 **EDP Keycloak Operator** 插件。如果尚未上传，管理员可以使用 `violet` CLI 推送：
  ```bash
  violet push edp-keycloak-operator.<version>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- 针对目标集群配置的 `kubectl`。

## 安装 Operator

1. 在 ACP 控制台中，转到 **管理员 > 市场 > OperatorHub**，选择目标集群，找到 **EDP Keycloak Operator**，然后点击 **安装**。
2. 保持默认通道（`alpha`）和 **集群** 安装模式（所有命名空间）。对于 **安装位置**，建议的命名空间是 **`edp-keycloak-operator`**。
3. 确认安装。

一个 Operator 服务整个集群：您在使用它们的应用程序的命名空间中创建其资源，而不是在 Operator 自身的命名空间中。

### 验证 Operator

```bash
kubectl -n edp-keycloak-operator get csv | grep edp-keycloak-operator
kubectl -n edp-keycloak-operator get deploy
```

预期：条目 `edp-keycloak-operator.v<version>` 达到状态 `Succeeded`，并且 Operator 的
Deployment 显示 `1/1` 准备就绪。

## 两种不同的资源被称为 `Keycloak`

此 Operator 和身份管理 E1 都定义了一种类型为 `Keycloak` 的资源，在不同的 API 组中：

| 资源                           | 所属                   | 说明                                                         |
| ------------------------------ | ---------------------- | ------------------------------------------------------------ |
| `keycloaks.k8s.keycloak.org`  | 身份管理 E1           | **一个 Keycloak 服务器** — 创建一个会部署 Keycloak         |
| `keycloaks.v1.edp.epam.com`   | EDP Keycloak Operator  | **一个连接** 到现有的 Keycloak — 一个 URL 加上一个凭证     |

这两者可以存在于同一个集群中，甚至共享一个名称。但是一旦两者都安装，裸 `kubectl get keycloak` 只列出其中一种类型 — 在 ACP 上，它列出 Keycloak 服务器，并默默省略 EDP 连接。因此 **始终使用完整的资源名称**：

```bash
kubectl get keycloaks.k8s.keycloak.org -A     # Keycloak 服务器
kubectl get keycloaks.v1.edp.epam.com -A      # EDP 连接
```

身份管理 E1 文档使用短形式 `kubectl get keycloak`；在同时运行此 Operator 的集群上，请输入完整名称。

## 与 Alauda Application Services 身份管理 E1 一起使用

本节在名为 `sso` 的命名空间中设置：

1. 来自身份管理 E1 的 Keycloak 服务器；
2. 此 Operator 与该服务器的连接；
3. 一个领域、一个客户端、一个组、一个角色和一个用户 — 所有这些都是作为 Kubernetes 资源；
4. 检查用户是否可以实际登录。

### 1. 创建 Keycloak 服务器

安装 **Alauda Application Services 身份管理 E1** 并按照其文档创建一个 Keycloak 实例：

- [安装](https://docs.alauda.io/keycloak/26.7/install.html)
- [创建实例](https://docs.alauda.io/keycloak/26.7/functions/10-create_instance.html)

在本演练中，实例名为 `sso-kc`，位于命名空间 `sso`，并启用了集群内 HTTP 监听器：

```yaml
apiVersion: k8s.keycloak.org/v2beta1
kind: Keycloak
metadata:
  name: sso-kc
  namespace: sso
spec:
  instances: 1
  db:
    vendor: postgres
    host: postgres-db                     # 您的 PostgreSQL 服务
    database: keycloak
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
    - name: hostname-strict
      value: "false"
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

等待直到它准备就绪：

```bash
kubectl -n sso wait keycloaks.k8s.keycloak.org/sso-kc --for=condition=Ready --timeout=10m
```

身份管理 E1 然后提供此 Operator 使用的两个内容：

| 对象   | 名称                                                   | 用于                                       |
| ------ | ------------------------------------------------------ | ------------------------------------------ |
| 服务   | `sso-kc-service`，端口 `8080`                          | Operator 与之通信的 URL                   |
| 密钥   | `sso-kc-initial-admin`，键 `username` 和 `password` | Operator 以此身份登录的管理员             |

### 2. 将 Operator 连接到它

```yaml
apiVersion: v1.edp.epam.com/v1
kind: Keycloak
metadata:
  name: sso-kc
  namespace: sso
spec:
  url: http://sso-kc-service.sso.svc:8080
  auth:
    passwordGrant:
      username:
        secretKeyRef:
          name: sso-kc-initial-admin
          key: username
      passwordRef:
        name: sso-kc-initial-admin
        key: password
```

```bash
kubectl apply -f connection.yaml
kubectl -n sso get keycloaks.v1.edp.epam.com sso-kc
```

预期：`CONNECTED` 显示 `true`，在一分钟内。Operator 仅在成功登录 Keycloak 后才会设置它，因此 `true` 意味着 URL 和凭证都是正确的。

- URL 按照原样使用。Keycloak 25+ 在根路径提供服务，因此没有 `/auth` 后缀。
- 密钥必须与此资源位于同一命名空间。
- `sso-kc-initial-admin` 是 Keycloak 在首次启动时创建的引导管理员。它适合于入门；对于长期设置，请切换到专用客户端，如 [使用专用服务账户连接](#connect-with-a-dedicated-service-account) 中所述。

### 3. 创建一个领域

```yaml
apiVersion: v1.edp.epam.com/v1
kind: KeycloakRealm
metadata:
  name: demo
  namespace: sso
spec:
  realmName: demo
  keycloakRef:
    kind: Keycloak
    name: sso-kc
  userProfileConfig:
    unmanagedAttributePolicy: ADMIN_EDIT   # 需要自定义用户属性，请参见已知限制
```

```bash
kubectl apply -f realm.yaml
kubectl -n sso get keycloakrealms.v1.edp.epam.com demo \
  -o jsonpath='{.status.available}/{.status.value}{"\n"}'
```

预期：`true/OK`。

### 4. 创建一个客户端、一个组、一个角色和一个用户

```yaml
apiVersion: v1.edp.epam.com/v1
kind: KeycloakClient
metadata:
  name: demo-app
  namespace: sso
spec:
  realmRef:
    kind: KeycloakRealm
    name: demo
  clientId: demo-app
  directAccess: true                  # 允许第 5 步中的检查从命令行登录
  standardFlowEnabled: true
  redirectUris:
    - https://demo-app.example.com/*
  webUrl: https://demo-app.example.com
---
apiVersion: v1.edp.epam.com/v1
kind: KeycloakRealmRole
metadata:
  name: developer
  namespace: sso
spec:
  realmRef:
    kind: KeycloakRealm
    name: demo
  name: developer
  description: 开发人员角色
---
apiVersion: v1.edp.epam.com/v1
kind: KeycloakRealmGroup
metadata:
  name: developers
  namespace: sso
spec:
  realmRef:
    kind: KeycloakRealm
    name: demo
  name: developers
  realmRoles:
    - developer
---
apiVersion: v1.edp.epam.com/v1
kind: KeycloakRealmUser
metadata:
  name: alice
  namespace: sso
spec:
  realmRef:
    kind: KeycloakRealm
    name: demo
  username: alice
  email: alice@example.com
  firstName: Alice
  lastName: Example
  enabled: true
  emailVerified: true
  groups:
    - developers
  passwordSecret:
    name: alice-password
    key: password
```

用户的密码来自一个密钥，因此它永远不会出现在资源中。首先创建它：

```bash
kubectl -n sso create secret generic alice-password --from-literal=password='<choose-a-password>'
kubectl apply -f app.yaml
kubectl -n sso get keycloakclients.v1.edp.epam.com,keycloakrealmroles.v1.edp.epam.com,keycloakrealmgroups.v1.edp.epam.com,keycloakrealmusers.v1.edp.epam.com \
  -o custom-columns='KIND:.kind,NAME:.metadata.name,STATUS:.status.value'
```

预期：每一行都显示 `OK`。

`demo-app` 是一个机密客户端。Operator 生成了其客户端密钥并将其存储在密钥 `keycloak-client-demo-app-secret` 中：

```bash
kubectl -n sso get secret keycloak-client-demo-app-secret -o jsonpath='{.data.clientSecret}' | base64 -d
```

要提供您自己的密钥，请创建一个密钥并在 `KeycloakClient` 中使用 `secret: "$<secret-name>:<key>"` 引用它。

### 5. 检查用户是否可以登录

转发 Keycloak 服务并通过 `demo-app` 请求 `alice` 的令牌：

```bash
kubectl -n sso port-forward svc/sso-kc-service 8080:8080 &

CLIENT_SECRET=$(kubectl -n sso get secret keycloak-client-demo-app-secret -o jsonpath='{.data.clientSecret}' | base64 -d)
TOKEN=$(curl -s http://localhost:8080/realms/demo/protocol/openid-connect/token \
  -d grant_type=password -d client_id=demo-app -d client_secret="$CLIENT_SECRET" \
  -d scope=openid -d username=alice -d password='<the-password-you-chose>' \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

curl -s http://localhost:8080/realms/demo/protocol/openid-connect/userinfo \
  -H "Authorization: Bearer $TOKEN"
```

预期：第二个命令打印 `alice` 的个人资料 — `"preferred_username":"alice"` 和她的电子邮件。
这证明领域、客户端及其生成的密钥，以及用户及其密码都能协同工作。空 `TOKEN` 意味着登录被拒绝；单独运行第一个 `curl` 以查看原因。
在令牌请求中保持 `scope=openid`：没有它，Keycloak 会以 `403` 响应第二个调用。
您还可以使用 `sso-kc-initial-admin` 凭证登录到管理控制台，地址为 `http://localhost:8080`，查看领域 `demo`。

`directAccess: true` 仅用于使此命令行检查成为可能。基于浏览器的应用程序使用标准流程登录，不需要它；确认设置后可以将其删除。

## 使用专用服务账户连接

`sso-kc-initial-admin` 中的引导管理员用于 Keycloak 的首次启动。对于长期连接，请为 Operator 在 `master` 领域中创建自己的客户端，并让其使用该客户端的凭证登录。

在 Keycloak pod 内部使用 Keycloak 管理 CLI 创建客户端。它会询问引导管理员的密码：

```bash
kubectl -n sso exec -it sso-kc-0 -- bash -c '
  set -e
  KC=/opt/keycloak/bin/kcadm.sh
  CFG="--config /tmp/kcadm.config"
  $KC config credentials $CFG --server http://localhost:8080 --realm master --user temp-admin
  ID=$($KC create clients $CFG -r master -i \
        -s clientId=edp-keycloak-operator -s publicClient=false \
        -s serviceAccountsEnabled=true -s standardFlowEnabled=false -s directAccessGrantsEnabled=false)
  $KC add-roles $CFG -r master --uusername service-account-edp-keycloak-operator --rolename admin
  $KC get clients/$ID/client-secret $CFG -r master --fields value
  rm -f /tmp/kcadm.config'
```

`temp-admin` 是存储在 `sso-kc-initial-admin` 中的用户名；使用
`kubectl -n sso get secret sso-kc-initial-admin -o jsonpath='{.data.username}' | base64 -d` 检查它。
最后一条命令打印新客户端的密钥，格式为 `{ "value" : "<secret>" }`。将其存储在一个密钥中并切换连接：

```bash
kubectl -n sso create secret generic edp-keycloak-operator-client \
  --from-literal=clientId=edp-keycloak-operator \
  --from-literal=clientSecret='<the-printed-secret>'
```

```yaml
apiVersion: v1.edp.epam.com/v1
kind: Keycloak
metadata:
  name: sso-kc
  namespace: sso
spec:
  url: http://sso-kc-service.sso.svc:8080
  auth:
    clientCredentials:
      clientId:
        secretKeyRef:
          name: edp-keycloak-operator-client
          key: clientId
      clientSecretRef:
        name: edp-keycloak-operator-client
        key: clientSecret
```

在 `kubectl apply` 后，`CONNECTED` 应该返回 `true`，并且演练中的领域、客户端和用户保持 `OK`。

### 在多个命名空间之间共享一个连接

`Keycloak` 连接仅服务于其自身的命名空间。要让多个命名空间使用相同的 Keycloak，请创建一个集群范围的 `ClusterKeycloak`。其密钥必须位于 **Operator 的** 命名空间 `edp-keycloak-operator` 中：

```bash
kubectl -n edp-keycloak-operator create secret generic edp-keycloak-operator-client \
  --from-literal=clientId=edp-keycloak-operator \
  --from-literal=clientSecret='<the-printed-secret>'
```

```yaml
apiVersion: v1.edp.epam.com/v1alpha1
kind: ClusterKeycloak
metadata:
  name: sso-kc
spec:
  url: http://sso-kc-service.sso.svc:8080
  auth:
    clientCredentials:
      clientId:
        secretKeyRef:
          name: edp-keycloak-operator-client
          key: clientId
      clientSecretRef:
        name: edp-keycloak-operator-client
        key: clientSecret
---
apiVersion: v1.edp.epam.com/v1alpha1
kind: ClusterKeycloakRealm
metadata:
  name: shared
spec:
  clusterKeycloakRef: sso-kc
  realmName: shared
```

任何命名空间中的资源都可以通过 `realmRef: {kind: ClusterKeycloakRealm, name: shared}` 指向该领域。

## 身份管理 E1 的资源，还是此 Operator？

身份管理 E1 还提供了一些自己的声明式配置。它们可以并行使用；根据您需要管理的内容进行选择：

| 您需要…                                                                                                                | 使用                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 部署、扩展和升级 Keycloak 服务器                                                                               | 身份管理 E1 (`keycloaks.k8s.keycloak.org`)                                                          |
| 从完整的领域导出中 **一次** 种子一个新领域                                                                         | 身份管理 E1 `KeycloakRealmImport` — 它创建领域，之后不会更新或删除它 |
| 保持 OIDC 客户端与 Keycloak 实例保持一致                                                                 | 身份管理 E1 `KeycloakOIDCClient`（在 26.7 中新增；与 Keycloak 实例位于同一命名空间）             |
| 保持领域、用户、组、角色、身份提供者、客户端范围或身份验证流程保持一致                     | **EDP Keycloak Operator**                                                                                      |
| 从应用程序自己的命名空间管理配置，或针对未由身份管理 E1 部署的 Keycloak 进行管理 | **EDP Keycloak Operator**                                                                                      |

请勿从两侧管理相同的对象 — 例如，通过 `KeycloakOIDCClient` 和 `KeycloakClient` 管理相同的客户端。每个在应用其自身时都会覆盖对方的更改。

## 删除资源的作用

删除此 Operator 的资源 **会删除 Keycloak 中的匹配对象**：删除 `KeycloakRealm` 会删除该领域及其所有用户和客户端。要在 Kubernetes 资源消失时保留 Keycloak 对象，请先对资源进行注释：

```yaml
metadata:
  annotations:
    edp.epam.com/preserve-resources-on-deletion: "true"
```

按以下顺序删除，以便在删除过程中每个资源仍然可以访问 Keycloak：

1. 领域内容 — `KeycloakClient`、`KeycloakRealmUser`、`KeycloakRealmGroup`、`KeycloakRealmRole` 等
2. `KeycloakRealm` / `ClusterKeycloakRealm`
3. `Keycloak` / `ClusterKeycloak`

要删除演练：

```bash
kubectl -n sso delete keycloakrealmusers.v1.edp.epam.com,keycloakrealmgroups.v1.edp.epam.com,keycloakrealmroles.v1.edp.epam.com,keycloakclients.v1.edp.epam.com --all
kubectl -n sso delete keycloakrealms.v1.edp.epam.com demo
kubectl -n sso delete keycloaks.v1.edp.epam.com sso-kc
```

## 已知限制

<!-- factory:auto:known-limitations BEGIN -->

- **自定义用户属性会被静默丢弃，除非领域允许它们。** Keycloak 24 及更高版本会拒绝未声明的用户属性。具有 `attributesV2` 的 `KeycloakRealmUser` 仍然报告 `OK`，但 Keycloak 不会存储任何属性。在 `KeycloakRealm` 上设置 `userProfileConfig.unmanagedAttributePolicy: ADMIN_EDIT`（如演练中所示），或在领域的用户配置中声明属性。
- **删除资源会删除 Keycloak 对象。** 请参见
  [删除资源的作用](#what-deleting-a-resource-does)；使用
  `edp.epam.com/preserve-resources-on-deletion` 注释以保留它。
- **每个对象只能由一方拥有。** 如果客户端或领域也由身份管理 E1 资源管理或在管理控制台中编辑，则在 Operator 下次应用资源时，这些更改会被覆盖 — 这可能会很晚，因此冲突很容易被忽视。
- **移除 Operator 会在集群中留下其资源定义。** 卸载不会删除 `*.v1.edp.epam.com` 资源类型；您的 Keycloak 配置不受影响。
- **较旧的 `1.23.0` 版本不会自动升级到此版本。** 列出在 ACP 4.0 的 `1.23.0` 条目是早期社区提供的构建；此版本在 ACP 4.1 或更高版本上单独安装。

<!-- factory:auto:known-limitations END -->

## 卸载

首先按顺序删除您创建的资源，顺序见
[删除资源的作用](#what-deleting-a-resource-does)。然后从 **管理员 > 市场 > OperatorHub** 卸载 Operator，或：

```bash
kubectl -n edp-keycloak-operator delete subscription edp-keycloak-operator
kubectl -n edp-keycloak-operator delete csv -l operators.coreos.com/edp-keycloak-operator.edp-keycloak-operator
```

> 最后卸载 Operator **。** 它会在删除其资源时从 Keycloak 中移除每个对象；如果 Operator 首先消失，则资源无法完成删除，其命名空间会挂起在 `Terminating` 状态。

## 常见问题

**问：`CONNECTED` 保持为 `false`。**
在 Operator 的日志中查找原因：

```bash
kubectl -n edp-keycloak-operator logs deploy/keycloak-operator-controller-manager | grep -i "unable to connect"
```

通常原因：URL 以 `/auth` 结尾（移除它），密钥与 `Keycloak` 资源不在同一命名空间，凭证错误，或 Keycloak 服务器尚未准备好。

**问：`kubectl get keycloak` 不显示我创建的连接。**
两种资源类型共享该名称，短形式仅列出 Keycloak 服务器。使用 `kubectl get keycloaks.k8s.keycloak.org` 获取服务器，使用 `kubectl get keycloaks.v1.edp.epam.com` 获取连接。请参见
[两种不同的资源被称为 `Keycloak`](#two-different-resources-are-called-keycloak)。

**问：创建第二个领域资源被拒绝，提示“已被 KeycloakRealm 使用”。**
两个资源不能在同一个 Keycloak 上管理同一个领域。请编辑现有的 `KeycloakRealm`，或为新的 `KeycloakRealm` 提供不同的 `realmName`。

**问：创建了用户，但其属性在 Keycloak 中为空。**
领域的用户配置拒绝未声明的属性。请参见 [已知限制](#known-limitations) 下的第一项。

**问：我可以管理 `master` 领域吗？**
可以，但要小心：删除 `master` 的 `KeycloakRealm` 会尝试删除 `master` 领域。始终在此类资源上添加注释 `edp.epam.com/preserve-resources-on-deletion: "true"`。

**问：我该如何升级？**
从市场升级 Operator。您的资源和它们管理的 Keycloak 配置保持不变。
