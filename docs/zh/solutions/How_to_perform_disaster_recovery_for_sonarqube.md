---
kind:
   - Solution
products:
  - Alauda DevOps
ProductsVersion:
   - 4.x
id: TODO
---

# 如何为 SonarQube 执行灾难恢复

## 问题

本解决方案描述了如何基于 PostgreSQL 的灾难恢复能力构建 SonarQube 灾难恢复解决方案。该解决方案实现了**热数据、冷计算**架构，其中数据通过 PostgreSQL 灾难恢复机制持续同步到备用集群，当主集群发生故障时部署备用 SonarQube 实例，备用 SonarQube 会使用容灾数据快速启动并提供服务。该解决方案主要关注数据灾难恢复处理，用户需要自行实现 SonarQube 访问地址切换机制。

## 环境

SonarQube Operator: >=v2025.1.0

## 术语

| 术语                    | 描述                                                                 |
|-------------------------|-----------------------------------------------------------------------------|
| **主 SonarQube**      | 处理正常业务操作和用户请求的活跃 SonarQube 实例。该实例完全运行，所有组件都在运行。 |
| **备用 SonarQube**    | 计划部署在不同集群/区域的备用 SonarQube 实例，在灾难恢复场景激活之前保持休眠状态。 |
| **主 PostgreSQL**  | 处理所有数据事务的活跃 PostgreSQL 数据库集群，作为数据复制到备用数据库的源。 |
| **备用 PostgreSQL**| 从主数据库接收实时数据复制的热备用 PostgreSQL 数据库。它可以在故障转移期间提升为主角色。 |
| **恢复点目标 (RPO)** | 以时间衡量的最大可接受数据丢失量（例如，5 分钟，1 小时）。它定义了在灾难发生前可以丢失多少数据才变得不可接受。 |
| **恢复时间目标 (RTO)** | 以时间衡量的最大可接受停机时间（例如，15 分钟，2 小时）。它定义了系统在灾难后必须恢复的速度。 |
| **故障转移**            | 当主系统变得不可用或失败时，从主系统切换到备用系统的过程。 |
| **数据同步**| 从主系统到备用系统持续复制数据以保持一致性并启用灾难恢复的过程。 |
| **热数据，冷计算**| 一种架构模式，其中数据持续同步（热），而计算资源保持非活动状态（冷），直到故障转移。 |

## 架构

SonarQube 灾难恢复解决方案为 SonarQube 服务实现了**热数据、冷计算架构**。这种架构通过准实时数据同步和手动 SonarQube 服务故障转移程序提供灾难恢复能力。架构由部署在不同集群或区域的两个 SonarQube 实例组成，备用 SonarQube 并不会提前部署，直到在灾难场景中激活，而数据库层保持持续同步。

### 数据同步策略

该解决方案通过 PostgreSQL 流式复制确保主数据库和备用数据库之间的实时事务日志同步，包括所有 SonarQube 应用程序数据

### 灾难恢复配置

1. **部署主 SonarQube**：配置域名访问，连接到主 PostgreSQL 数据库
2. **准备备用 SonarQube 部署环境**：配置备用实例所需要的 secret 资源，以便于灾难发生时快速恢复

### 故障转移程序

当发生灾难时，以下步骤确保转换到备用环境：

1. **验证主故障**：确认所有主 SonarQube 组件都不可用
2. **提升数据库**：使用数据库故障转移程序将备用 PostgreSQL 提升为主
3. **部署备用 SonarQube**：在备集群使用灾备数据快速部署 SonarQube 实例
4. **更新路由**：将外部访问地址切换到指向备用 SonarQube 实例

## SonarQube 容灾配置

::: warning

为了简化配置过程，降低配置难度，推荐主备两个环境中使用一致的信息，包括：

- 一致的数据库实例名称和密码
- 一致的 SonarQube 实例名称
- 一致的命名空间名称

:::

### 前置条件

1. 提前准备一个主集群和一个灾难恢复集群（或包含不同区域的集群）。
2. 完成 `Alauda support for PostgreSQL` 灾难恢复配置的部署。

### 使用 `Alauda support for PostgreSQL` 构建 PostgreSQL 灾难恢复集群

参考 `PostgreSQL 热备用集群配置指南`，使用 `Alauda support for PostgreSQL` 构建灾难恢复集群。

确保主 PostgreSQL 和备用 PostgreSQL 位于不同的集群（或不同的区域）。

您可以在 [Alauda Knowledge](https://cloud.alauda.io/knowledges#/) 上搜索 `PostgreSQL 热备用集群配置指南` 来获取它。

:::warning

`PostgreSQL 热备用集群配置指南` 是一份描述如何使用 `Alauda support for PostgreSQL` 构建灾难恢复集群的文档。使用此配置时，请确保与相应的 ACP 版本兼容。

:::

### 设置主 SonarQube

按照 SonarQube 实例部署指南部署主 SonarQube 实例。配置域名访问，连接到主 PostgreSQL 数据库。

配置示例（仅包含了容灾关注的配置项，完整配置项见产品文档）：

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: Sonarqube
metadata:
  name: <SONARQUBE_NAME>
  namespace: <SONARQUBE_NAMESPACE>
spec:
  externalURL: http://dr-sonar.alaudatech.net # 配置域名并解析到主集群
  helmValues:
    ingress:
      enabled: true
      hosts:
        - name: dr-sonar.alaudatech.net
    jdbcOverwrite:
      enable: true
      jdbcSecretName: sonarqube-pg
      jdbcUrl: jdbc:postgresql://sonar-dr.sonar-dr:5432/sonar_db? # 连接到主 PostgreSql
      jdbcUsername: postgres
```

### 设置备用 SonarQube

:::warning
当 PostgreSQL 处于备用状态时，备用数据库无法接受写操作，因此备集群的 SonarQube 无法部署成功。

如需验证备集群 SonarQube 是否可以部署成功，可以临时将备集群的 PostgreSQL 提升为主集群，测试完成后再设置回备用状态。同时需要将测试过程中创建的 SonarQube 资源都删除。
:::

1. 创建备 SonarQube 使用的 Secret
2. 备份主 SonarQube 实例 YAML

#### 创建备 SonarQube 使用的 Secret

备 SonarQube 需要两个 secret，分别保存数据库连接 (连接到备 PostgreSQL) 和 root 密码。参考 [SonarQube 部署文档](https://docs.alauda.cn/alauda-build-of-sonarqube/2025.1/install/02_sonarqube_credential.html#pg-credentials) 创建（Secret 名称保持和主 SonarQube 配置时使用的名称一致）。

示例:

```bash
apiVersion: v1
stringData:
  host: sonar-dr.sonar-dr
  port: "5432"
  username: postgres
  jdbc-password: xxxx
  database: sonar_db
kind: Secret
metadata:
  name: sonarqube-pg
  namespace: $SONARQUBE_NAMESPACE
type: Opaque
---
apiVersion: v1
stringData:
  password: xxxxx
kind: Secret
metadata:
  name: sonarqube-root-password
  namespace: $SONARQUBE_NAMESPACE
type: Opaque
```

#### 备份主 SonarQube 实例 YAML

```bash
kubectl -n "$SONARQUBE_NAMESPACE" get sonarqube "$SONARQUBE_NAME" -oyaml > sonarqube.yaml
```

根据容灾环境实际情况修改 `sonarqube.yaml` 中的信息，包括 PostgreSQL 连接地址等。

:::warning
`SonarQube` 资源**不需要**立即创建在容灾环境，只需要在灾难发生时，执行容灾切换时创建到备集群即可。
:::

:::warning
如需进行容灾演练，可以按照 [灾难场景中的主备切换程序](#灾难切换) 中的步骤进行演练。演练完毕后需要在容灾环境完成以下清理操作：

- 将容灾环境中的 `SonarQube` 实例删除
- 将 PostgreSQL 集群切换为备用状态

:::

### 恢复目标

#### 恢复点目标 (RPO)

RPO 表示在灾难恢复场景中最大可接受的数据丢失。在此 SonarQube 灾难恢复解决方案中：

- **数据库层**：由于 PostgreSQL 热备用流式复制，数据丢失接近零
- **总体 RPO**：总体 RPO 接近零，取决于 PostgreSQL 流式复制的延迟

#### 恢复时间目标 (RTO)

RTO 表示在灾难恢复期间最大可接受的停机时间。此解决方案提供：

- **手动组件**：SonarQube 服务激活和外部路由更新需要手动干预
- **典型 RTO**：完整服务恢复需要 7-20 分钟

**RTO 分解：**

- 数据库故障转移：1-2 分钟（手动）
- SonarQube 服务激活：5-15 分钟（手动）
- 外部路由更新：1-3 分钟（手动，取决于 DNS 传播）

## 灾难切换

1. **确认主 SonarQube 故障**：确认所有主 SonarQube 组件都处于非工作状态，否则先停止所有主 SonarQube 组件。

2. **提升备用 PostgreSQL**：将备用 PostgreSQL 提升为主 PostgreSQL。参考 `PostgreSQL 热备用集群配置指南` 的切换程序。

3. **部署备用 SonarQube**：恢复备份的 `sonarqube.yaml` 到容灾环境同名命名空间中。SonarQube 会利用容灾数据自动启动。

4. **验证 SonarQube 组件**：验证所有 SonarQube 组件正在运行且健康。测试 SonarQube 功能（项目访问、代码分析、用户认证）以验证 SonarQube 是否正常工作。

5. **切换访问地址**：将外部访问地址切换到备用 SonarQube。

## 使用其他 PostgreSQL 构建 SonarQube 灾难恢复解决方案

操作步骤与使用 `Alauda support for PostgreSQL` 构建 SonarQube 灾难恢复解决方案类似。只需将 PostgreSQL 替换为其他支持灾难恢复的 PostgreSQL 解决方案。

:::warning
确保所选 PostgreSQL 解决方案支持灾难恢复能力，并在生产环境使用前进行充分的容灾演练。
:::
