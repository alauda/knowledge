---
kind:
  - Solution
products:
  - Alauda DevOps
ProductsVersion:
  - 4.x
id: KB251200005
sourceSHA: dd594960618f0858d798834f4fe932e4ef0a986adfcec105580d156b974c8d1d
---

# 如何为 SonarQube 执行灾难恢复

## 问题

本解决方案描述了如何基于 PostgreSQL 的灾难恢复能力构建 SonarQube 的灾难恢复解决方案。该解决方案实现了 **热数据，冷计算** 架构，其中数据通过 PostgreSQL 灾难恢复机制持续同步到备用集群。当主集群发生故障时，部署备用 SonarQube 实例，备用 SonarQube 将快速开始使用灾难恢复数据并提供服务。该解决方案主要关注数据灾难恢复处理，用户需要实现自己的 SonarQube 访问地址切换机制。

## 环境

SonarQube Operator: >=v2025.1.0

## 术语

| 术语                               | 描述                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **主 SonarQube**                   | 处理正常业务操作和用户请求的活动 SonarQube 实例。该实例完全可操作，所有组件均在运行。                                                                                     |
| **备用 SonarQube**                 | 计划在不同集群/地域中部署的备用 SonarQube 实例，保持待命状态，直到在灾难恢复场景中被激活。                                                                                  |
| **主 PostgreSQL**                  | 处理所有数据事务的活动 PostgreSQL 数据库集群，并作为数据复制到备用数据库的源。                                                                                          |
| **备用 PostgreSQL**                | 接收来自主数据库的实时数据复制的热备用 PostgreSQL 数据库。在故障转移期间可以提升为主角色。                                                                                  |
| **恢复点目标 (RPO)**               | 可接受的最大数据丢失量，以时间衡量（例如，5 分钟，1 小时）。它定义了在灾难发生时可以丢失多少数据，直到变得不可接受。                                                        |
| **恢复时间目标 (RTO)**             | 可接受的最大停机时间，以时间衡量（例如，15 分钟，2 小时）。它定义了在灾难发生后系统必须多快恢复。                                                                          |
| **故障转移**                       | 当主系统不可用或故障时，从主系统切换到备用系统的过程。                                                                                                                |
| **数据同步**                       | 从主系统到备用系统持续复制数据的过程，以保持一致性并启用灾难恢复。                                                                                                    |
| **热数据，冷计算**                 | 一种架构模式，其中数据持续同步（热），而计算资源保持非活动状态（冷），直到发生故障转移。                                                                                  |

## 架构

SonarQube 灾难恢复解决方案为 SonarQube 服务实现了 **热数据，冷计算架构**。该架构通过近实时数据同步和手动 SonarQube 服务故障转移操作步骤提供灾难恢复能力。该架构由两个部署在不同集群或地域的 SonarQube 实例组成，备用 SonarQube 实例在灾难场景中被激活之前不会提前部署，而数据库层保持持续同步。

### 数据同步策略

该解决方案通过 PostgreSQL 流复制确保主数据库和备用数据库之间的实时事务日志同步，包括所有 SonarQube 应用数据。

### 灾难恢复配置

1. **部署主 SonarQube**：配置域访问，连接到主 PostgreSQL 数据库。
2. **准备备用 SonarQube 部署环境**：配置备用实例所需的 Secret 资源，以便在发生灾难时能够快速恢复。

### 故障转移操作步骤

当发生灾难时，以下步骤确保切换到备用环境：

1. **验证主故障**：确认所有主 SonarQube 组件不可用。
2. **提升数据库**：使用数据库故障转移操作步骤将备用 PostgreSQL 提升为主。
3. **部署备用 SonarQube**：使用灾难恢复数据快速部署备用集群中的 SonarQube 实例。
4. **更新路由**：切换外部访问地址以指向备用 SonarQube 实例。

## SonarQube 灾难恢复配置

::: warning

为了简化配置过程并降低配置难度，建议在主环境和备用环境中使用一致的信息，包括：

- 一致的数据库实例名称和密码
- 一致的 SonarQube 实例名称
- 一致的命名空间名称

:::

### 前提条件

1. 提前准备一个主集群和一个灾难恢复集群（或包含不同地域的集群）。
2. 完成 `Alauda 对 PostgreSQL 的支持` 灾难恢复配置的部署。

### 使用 `Alauda 对 PostgreSQL 的支持` 构建 PostgreSQL 灾难恢复集群

参考 `PostgreSQL 热备用集群配置指南` 使用 `Alauda 对 PostgreSQL 的支持` 构建灾难恢复集群。

确保主 PostgreSQL 和备用 PostgreSQL 在不同的集群（或不同的地域）中。

您可以在 [Alauda 知识](https://cloud.alauda.io/knowledges#/) 上搜索 `PostgreSQL 热备用集群配置指南` 以获取该文档。

:::warning

`PostgreSQL 热备用集群配置指南` 是一份描述如何使用 `Alauda 对 PostgreSQL 的支持` 构建灾难恢复集群的文档。请确保在使用此配置时与适当的 ACP 版本兼容。

:::

### 设置主 SonarQube

通过遵循 SonarQube 实例部署指南来部署主 SonarQube 实例。配置域访问，连接到主 PostgreSQL 数据库。

配置示例（仅包括与灾难恢复相关的配置项，完整配置项请参见产品文档）：

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: Sonarqube
metadata:
  name: <SONARQUBE_NAME>
  namespace: <SONARQUBE_NAMESPACE>
spec:
  externalURL: http://dr-sonar.alaudatech.net # 配置域并解析到主集群
  helmValues:
    ingress:
      enabled: true
      hosts:
        - name: dr-sonar.alaudatech.net
    jdbcOverwrite:
      enable: true
      jdbcSecretName: sonarqube-pg
      jdbcUrl: jdbc:postgresql://sonar-dr.sonar-dr:5432/sonar_db? # 连接到主 PostgreSQL
      jdbcUsername: postgres
```

### 设置备用 SonarQube

:::warning
当 PostgreSQL 处于备用状态时，备用数据库无法接受写操作，因此备用集群中的 SonarQube 无法成功部署。

如果您需要验证备用集群中的 SonarQube 是否可以成功部署，您可以暂时将备用集群的 PostgreSQL 提升为主，并在测试完成后将其恢复为备用状态。同时，您需要删除测试期间创建的 `sonarqube` 资源。
:::

1. 创建备用 SonarQube 使用的 Secrets。
2. 备份主 SonarQube 实例 YAML。

#### 创建备用 SonarQube 使用的 Secrets

备用 SonarQube 需要两个 secrets，一个用于数据库连接（连接到备用 PostgreSQL），一个用于 root 密码。参考 [SonarQube 部署文档](https://docs.alauda.cn/alauda-build-of-sonarqube/2025.1/install/02_sonarqube_credential.html#pg-credentials) 创建它们（保持 Secret 名称与主 SonarQube 配置中使用的一致）。

示例：

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

根据灾难恢复环境的实际情况修改 `sonarqube.yaml` 中的信息，包括 PostgreSQL 连接地址等。

:::warning
在灾难恢复环境中 **不需要** 立即创建 `sonarqube` 资源。仅在发生灾难并执行灾难恢复切换时，才需要在备用集群中创建它。
:::

:::warning
如果您需要进行灾难恢复演练，可以按照 [灾难场景中的主-备用切换操作步骤](#disaster-switchover) 进行演练。演练完成后，您需要在灾难恢复环境中执行以下清理操作：

- 删除灾难恢复环境中的 `sonarqube` 实例
- 将 PostgreSQL 集群切换为备用状态

:::

### 恢复目标

#### 恢复点目标 (RPO)

RPO 表示在灾难恢复场景中可接受的最大数据丢失。 在此 SonarQube 灾难恢复解决方案中：

- **数据库层**：由于 PostgreSQL 热备用流复制，数据丢失几乎为零。
- **整体 RPO**：整体 RPO 接近零，取决于 PostgreSQL 流复制的延迟。

#### 恢复时间目标 (RTO)

RTO 表示在灾难恢复期间可接受的最大停机时间。该解决方案提供：

- **手动组件**：SonarQube 服务激活和外部路由更新需要手动干预。
- **典型 RTO**：完整服务恢复需要 5-20 分钟。

**RTO 细分：**

- 数据库故障转移：1-2 分钟（手动）
- SonarQube 服务激活：3-15 分钟（手动）
- 外部路由更新：1-3 分钟（手动，取决于 DNS 传播）

## 灾难切换

1. **确认主 SonarQube 故障**：确认所有主 SonarQube 组件处于非工作状态，否则首先停止所有主 SonarQube 组件。

2. **提升备用 PostgreSQL**：将备用 PostgreSQL 提升为主 PostgreSQL。参考 `PostgreSQL 热备用集群配置指南` 中的切换操作步骤。

3. **部署备用 SonarQube**：将备份的 `sonarqube.yaml` 恢复到灾难恢复环境中，使用相同的命名空间名称。SonarQube 将自动开始使用灾难恢复数据。

4. **验证 SonarQube 组件**：验证所有 SonarQube 组件是否正常运行并健康。测试 SonarQube 功能（项目访问、代码分析、用户认证）以验证 SonarQube 是否正常工作。

5. **切换访问地址**：切换外部访问地址到备用 SonarQube。

## 使用其他 PostgreSQL 构建 SonarQube 灾难恢复解决方案

操作步骤与使用 `Alauda 对 PostgreSQL 的支持` 构建 SonarQube 灾难恢复解决方案类似。只需将 PostgreSQL 替换为其他支持灾难恢复的 PostgreSQL 解决方案。

:::warning
确保所选 PostgreSQL 解决方案支持灾难恢复能力，并在生产环境中使用之前进行充分的灾难恢复演练。
:::
