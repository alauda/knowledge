---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3'
id: KB260700092
sourceSHA: 5cc9b1e24329d5352482e5c66592bf0df712c6204dc123cebdec30061b3a9c96
---

# Alauda 对 Debezium 的支持 — 安装指南

## 概述

**Alauda 对 Debezium 的支持** 是 Alauda Application Services (S2, certified) 打包的
[Debezium](https://debezium.io/) — Apache-2.0 变更数据捕获 (CDC) 引擎，能够将行级数据库更改流式传输到消息和流系统 — 在 Alauda Cloud 市场上列出，并可以从 ACP OperatorHub 安装。

该插件将官方 Debezium Operator（基于其上游的 `debezium/debezium-operator` Helm chart 构建）打包为可安装的市场 Operator。安装和使用它有 **两个层级**，在开始之前值得了解：

1. 您从市场安装 **Operator**（创建 CSV）。
2. 您创建一个单独的 **`Debezium`** 自定义资源。这将安装 **Debezium Operator** 本身（`debezium-operator` 部署）并使用默认设置注册 **`DebeziumServer`** CRD。
3. 然后您创建一个或多个 **`DebeziumServer`** 自定义资源。Debezium Operator 将每个资源协调为一个独立的 **Debezium Server** 实例，该实例从源数据库捕获更改并将其流式传输到可配置的接收端。

```
市场安装 → CSV
   └─ Debezium (debezium-operator.alauda.io/v1)      ← 您只需创建一次；部署操作员
        └─ DebeziumServer (debezium.io/v1alpha1)     ← 每个 CDC 管道创建一个
             └─ Debezium Server pod  →  源数据库 ⇒ 接收端 (Kafka / Redis / Pulsar / HTTP / …)
```

本指南描述了如何从 ACP 市场安装 **Alauda 对 Debezium 的支持**，启动 Debezium Operator，并端到端运行 CDC 管道。

### 支持的版本

<!-- factory:auto:supported-versions BEGIN -->

| 项目                                 | 版本                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| ACP                                  | 4.1, 4.2, 4.3                                                                                      |
| 架构                                 | amd64 (x86_64), arm64                                                                             |
| Alauda 对 Debezium 的支持（包）      | v3.6.0                                                                                             |
| Debezium Operator 镜像              | `quay.io/debezium/operator:3.6.0` (multi-arch)                                                     |
| Debezium Server 镜像                | `quay.io/debezium/server:3.6.0.Final` (multi-arch)                                                 |
| 上游 chart                           | `debezium/debezium-operator` `debezium-operator-3.6.0.tgz` (发布资产，appVersion 3.6.0.Final) |

<!-- factory:auto:supported-versions END -->

> **网络:** 此版本在 IPv4 和 IPv6 集群上均已验证。验证覆盖了
> ACP 4.3 在 amd64/IPv6 上，ACP 4.2 + 4.1 在 arm64/IPv4 上，以及 ACP 4.1 在 amd64/IPv4 上 — 完整的
> 两个架构 × 两个 IP 栈矩阵，针对每种组合进行了实时 PostgreSQL → Debezium Server → HTTP 接收端 CDC
> 往返测试。预计双栈集群可以正常工作，但未进行测试。

## 先决条件

- 一个在上述支持版本之一的 ACP 集群，并且对目标业务集群具有 `cluster-admin` 访问权限。
- 集群的 OperatorHub 中可用的 **Alauda 对 Debezium 的支持** 插件。如果尚未上传，管理员可以使用 `violet` CLI 推送它（从 **App Store >
  App Onboarding** 下载，匹配目标平台版本）：
  ```bash
  violet push <debezium-operator-plugin-package>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- 已针对目标集群配置的 `kubectl`。
- 一个 **可以从集群访问的源数据库**，并且其 CDC 先决条件已到位。Debezium 的要求是特定于连接器的；对于 PostgreSQL（在下面的快速入门中使用），这意味着
  `wal_level = logical` 和一个可以创建复制槽和发布的角色。

## 安装 Alauda 对 Debezium 的支持

1. 在 ACP 控制台中，转到 **管理员 > 市场 > OperatorHub**，选择目标集群，找到 **Alauda 对 Debezium 的支持**，然后单击 **安装**。
2. 保持默认通道（`alpha`），选择目标命名空间（插件的默认命名空间为 `debezium`），并确认安装。平台创建一个 `Subscription` 并批准 `InstallPlan`。

### 验证 Operator

```bash
# CSV 应该达到 Succeeded 阶段
kubectl -n <operator-namespace> get csv | grep debezium-operator
```

预期：CSV `debezium-operator.v3.6.0` 达到阶段 `Succeeded`。

## 快速入门

### 1. 部署 Debezium Operator（`Debezium` CR）

创建一个 `Debezium` 资源。一个空的 `spec` 就足够了 — 这将安装 Debezium Operator
（`debezium-operator` 部署）并使用默认设置。（`spec` 反映了上游 chart 的 `values.yaml` 中的 `app.*`；请参见 [配置](#configuration)。）

```yaml
apiVersion: debezium-operator.alauda.io/v1
kind: Debezium
metadata:
  name: debezium
  namespace: debezium
spec: {}
```

```bash
kubectl create namespace debezium 2>/dev/null || true
kubectl apply -f debezium.yaml
```

等待操作员部署变为就绪：

```bash
kubectl -n debezium rollout status deployment/debezium-operator --timeout=600s
```

> 第一次滚动更新可能需要几分钟 — 插件安装 Debezium Operator，具有冷启动。允许最多 \~10 分钟的时间，然后将尚未就绪的部署视为失败。

预期：`debezium-operator` 部署为 `1/1` 可用，并且 `DebeziumServer` CRD
（`debeziumservers.debezium.io`）已注册：

```bash
kubectl get crd debeziumservers.debezium.io
```

### 2. 运行 CDC 管道（`DebeziumServer` CR）

每个 `DebeziumServer` 是一个独立的 CDC 管道：一个 **源** 连接器读取数据库，一个
**接收端** 流式传输更改事件。下面的示例使用 `pgoutput` 逻辑解码插件捕获来自 PostgreSQL 数据库的更改，并将其流式传输到 Redis。根据您的环境调整 `source`
和 `sink`。

```yaml
apiVersion: debezium.io/v1alpha1
kind: DebeziumServer
metadata:
  name: pg-to-redis
  namespace: debezium
spec:
  image: quay.io/debezium/server:3.6.0.Final
  runtime:
    api:
      enabled: true          # 暴露服务器的状态/健康 API
  source:
    class: io.debezium.connector.postgresql.PostgresConnector
    offset:
      memory: {}             # 仅用于演示；在生产中使用持久的偏移存储（见说明）
    schemaHistory:
      memory: {}
    config:
      database.hostname: <postgres-host>
      database.port: 5432
      database.user: <cdc-user>
      database.password: <cdc-password>
      database.dbname: <database>
      topic.prefix: demo
      schema.include.list: public
      plugin.name: pgoutput
  sink:
    type: redis
    config:
      address: "<redis-host>:6379"
```

```bash
kubectl apply -f debeziumserver.yaml
kubectl -n debezium get debeziumserver pg-to-redis
kubectl -n debezium rollout status deployment/pg-to-redis --timeout=300s
```

### 3. 验证更改事件流

在源数据库中进行更改并确认它到达接收端：

```bash
# 在源 PostgreSQL 中:  INSERT INTO <table> ...  /  UPDATE ...  /  DELETE ...
# 然后确认 Debezium Server 捕获到它（上面启用了服务器 API）：
kubectl -n debezium logs deploy/pg-to-redis | grep -i 'Snapshot ended\|Streaming\|captured'
```

预期：Debezium Server 日志显示快照完成和流式传输开始，您的接收端（Redis 流、Kafka 主题、HTTP 端点等）接收到每行更改的一个更改事件，按顺序且持久。

> \[!重要]
> **HTTP 接收端的具体要求。** 如果您使用 `sink.type: http`，Debezium Server 需要显式的
> 记录格式 — 在 `DebeziumServer` 上设置 `spec.format: json`（或 `cloudevents`），否则 HTTP 接收端无法启动。还要注意接收端 URL 键是 `url`（操作员将其前缀添加到
> `debezium.sink.http.url`），**而不是** `http.url`。

## 配置

`Debezium` CR 的 `spec` 反映了上游 chart 的 `values.yaml` 设置（您的值会覆盖 chart 默认值）。常见的调节项：

| 组            | CR 路径 (`Debezium.spec`)                                           | 备注                                                                                        |
| -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 操作员镜像    | `app.image`                                                         | 插件固定为 `quay.io/debezium/operator:3.6.0`；仅在私有镜像中覆盖                          |
| 探针          | `app.startupProbe.*`, `app.livenessProbe.*`, `app.readinessProbe.*` | 调整操作员探针阈值                                                                         |
| 资源          | `app.resources.{requests,limits}`                                   | 操作员容器资源                                                                             |

**`DebeziumServer`** CR 是上游 Debezium 自己的 API (`debezium.io/v1alpha1`) — 完整的源/接收端连接器目录及其 `config` 键在
[Debezium Server 参考](https://debezium.io/documentation/reference/stable/operations/debezium-server.html) 中有文档。支持的接收端包括 Apache Kafka、Redis、Apache Pulsar、NATS、Google Cloud Pub/Sub、Amazon Kinesis 和 HTTP。

> \[!注意]
> **偏移量和模式历史存储。** 快速入门使用 `memory` 偏移/模式历史存储以简化 — 这些在
> Debezium Server 重启时不会存活，因此在重启时服务器会重新快照。对于生产环境，请通过连接器
> `config` 配置持久存储（例如 Kafka 主题或 Redis 流）。请参见上面的 Debezium Server 参考。

## 已知限制

<!-- factory:auto:known-limitations BEGIN -->

- **首次发布包含 Debezium Operator 3.6.0.Final。** 更新的上游 Debezium 版本将在稍后发布到市场的插件版本中获取。Operator 及其 `DebeziumServer` API 将作为一个单元一起发布。
- **源数据库的 CDC 先决条件由用户负责。** Debezium 读取源数据库的事务日志；源必须配置为 CDC（例如 PostgreSQL `wal_level =
  logical` + 一个能够复制的角色，MySQL binlog `ROW` 格式等），才能从中流式传输 `DebeziumServer`。这超出了插件的范围。
- **发布验证使用了 PostgreSQL 源和 HTTP/Redis 接收端。** 验证测试了 PostgreSQL 连接器（`pgoutput`）到 HTTP 和 Redis 接收端的完整架构 × IP 栈矩阵。Debezium 支持其他连接器和接收端，但在此版本的验证中未进行测试。

<!-- factory:auto:known-limitations END -->

## 清理

```bash
# 删除 CDC 管道，然后删除操作员实例，最后删除命名空间
kubectl -n debezium delete debeziumserver --all
kubectl -n debezium delete debezium debezium
kubectl delete namespace debezium
# 从管理员 > 市场 > OperatorHub > 已安装中卸载操作员，或：
kubectl -n <operator-namespace> delete subscription debezium-operator
kubectl -n <operator-namespace> delete csv debezium-operator.v3.6.0
```

> \[!注意]
> 在仍存在 `Debezium` CR 的情况下删除命名空间可能会挂起：一旦正在删除管理它的操作员，资源的清理将无法完成。**首先** 删除 `DebeziumServer` 和 `Debezium` 资源，等待它们清除，然后删除命名空间。

## 常见问题

**问：创建 `Debezium` CR 后，`debezium-operator` 部署从未变为就绪。**
检查插件的操作员（控制器）pod 日志和 `Debezium` CR 状态。一个常见原因是某个镜像在隔离集群上无法拉取 — 请参见下一个问题。

**问：一个 pod 卡在 `ImagePullBackOff`。**
这很不寻常，因为插件包是 **自包含的**：它捆绑了所需的镜像，并且将包上传到您的集群会将它们加载到集群的镜像注册表中 — 包括在 **离线/隔离集群** 上，这正是该包的目的。因此，如果 pod 无法拉取镜像，最可能的原因是插件包未完成上传（部分上传可能会导致缺少镜像） — 重新上传并确认完成。然后运行
`kubectl -n <namespace> describe pod <pod>` 并查看事件以获取确切的注册表错误。

**问：我的 `DebeziumServer` 启动但接收端没有出现更改事件。**
确认源数据库已配置为 CDC（对于 PostgreSQL：`wal_level = logical`，并且 `database.user` 可以创建复制槽 + 发布），`plugin.name: pgoutput` 与您的设置匹配，并且 `schema.include.list` / `table.include.list` 实际上覆盖了您正在更改的表。对于 HTTP 接收端，请记住 `spec.format: json` 是必需的，并且接收端键是 `url`。

**问：Debezium Server 重启后事件从头开始重放。**
快速入门使用内存偏移存储。为生产环境在连接器 `config` 中配置持久偏移存储（Kafka/Redis），以便服务器从其上次提交的位置恢复。

**问：如何升级 Debezium？**
从市场升级操作员到新版本；它将 `Debezium` CR 协调到匹配的 Debezium 版本，`DebeziumServer` 资源将获取新的 Server 镜像。新的 Debezium 版本在认证后发布到市场。
