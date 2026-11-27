---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.0'
  - '4.2'
  - '4.3'
  - '4.4'
  - '4.5'
id: KB261100030
sourceSHA: 88366b74485331db056bda740675941ec00cb3a01abf071a300b8bbfc63bd82c
---

<!--
  Authoring model (oss-operator-factory): this guide is authored ONCE by hand. On later
  DocumentDB releases, only the slots fenced with `factory:auto:*` markers below are updated by
  the factory pipeline (version, supported versions, known limitations).
  Do NOT hand-edit inside a factory:auto block — those are regenerated from component.yaml /
  release evidence. Prose outside the markers is human-owned and preserved across releases.
-->

# DocumentDB — 安装指南

## 概述

**DocumentDB** 是一个开源的、与 MongoDB 兼容的文档数据库，基于 PostgreSQL 构建
([DocumentDB](https://github.com/documentdb/documentdb))，通过
[DocumentDB Kubernetes Operator](https://github.com/documentdb/documentdb-kubernetes-operator) 部署和管理。
应用程序通过标准的 MongoDB 驱动程序和工具（`mongosh`、`mongodump`、`mongorestore`）通过 MongoDB 线协议连接，而数据则存储在 PostgreSQL 中，使用 DocumentDB 扩展并由捆绑的 CloudNativePG operator 管理。

该软件包以 **社区支持 (S0)** 级别提供：它按原样打包上游社区版本，没有 CVE 修复 SLA 或自定义功能开发。修复将跟随上游社区版本。

```text
DocumentDB Operator (命名空间: documentdb-operator)
CloudNativePG Operator + CNPG-I Sidecar Injector (命名空间: cnpg-system)
        │
        ▼
DocumentDB 集群 (应用命名空间)
  └─ PostgreSQL Pod (PostgreSQL 18 + DocumentDB 扩展，组合镜像)
       └─ 网关 sidecar  ◄──  MongoDB 客户端 (端口 10260, TLS)
```

### 支持的版本

<!-- factory:auto:supported-versions BEGIN -->

| 项目                           | 版本                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| ACP                            | 4.0, 4.2, 4.3, 4.4, 4.5 (在 ACP 4.0.12, 4.2.6, 4.3.3, 4.4.0, 4.5.0 上验证) |
| 架构                          | amd64 (x86_64) 验证；多架构 amd64/arm64 镜像                      |
| 网络                          | IPv4 (在 ACP 4.2.6 和 4.5.0 上验证的双栈 IPv4/IPv6)                  |
| DocumentDB Operator (捆绑)   | v1.2.2                                                                       |
| DocumentDB Kubernetes Operator | 1.2.1                                                                        |
| DocumentDB 引擎              | 1.0.1 (PostgreSQL 18 组合镜像)                                         |
| 捆绑的 CloudNativePG Operator | 1.29.1 (chart 0.28.3)                                                        |
| 升级自                       | 无 (初始发布)                                                       |
| 许可证                        | MIT                                                                          |

<!-- factory:auto:supported-versions END -->

## 先决条件

| 要求                           | 详细信息                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 平台                           | ACP `4.0`, `4.2`–`4.5` (Kubernetes `1.30`–`1.36`) 需要 `cluster-admin` 访问                                                                                                                                                                                                               |
| 容器运行时                     | `containerd` (在 ACP `4.0.12` 和 `4.2`–`4.5` 上验证)；`docker` 由于设计兼容，因为 `combined` 镜像模式不需要 Kubernetes `ImageVolume`，但未单独测试                                                                                             |
| `cert-manager`                 | **必需。** 集群必须提供 `cert-manager.io/v1` API (`Issuer` 和 `Certificate`)。在 ACP `4.0`–`4.5` 上，`cert-manager` 是预安装的。如果缺失，Kubernetes API 服务器将拒绝安装，并显示 `no matches for kind "Issuer" in version "cert-manager.io/v1"`。 |
| 存储                          | 动态提供的 `StorageClass` (例如，TopoLVM)                                                                                                                                                                                                                             |
| CloudNativePG 互斥           | **每个集群只能存在一个 CloudNativePG operator。** 见下文。                                                                                                                                                                                                                       |
| OperatorHub 插件              | 上传到目标集群的 OperatorHub 的 **DocumentDB** (`documentdb-operator`) 包                                                                                                                                                                                             |

### CloudNativePG 互斥

DocumentDB `1.2.1` 打包了 CloudNativePG (`1.29.1`, chart `0.28.3`) 及其集群范围的 CRDs
(`postgresql.cnpg.io`)。它 **不能与** 同一集群中的另一个 CloudNativePG operator 共存（包括 Alauda CloudNativePG 包）。

- 安装图表包括一个内置的共存保护：如果集群中已经存在未管理的 `postgresql.cnpg.io`
  CRDs，安装将被拒绝，并显示明确的错误。
- 如果您稍后需要在同一集群中安装另一个 CloudNativePG 服务，**请先卸载
  DocumentDB**。

### 验证先决条件

```bash
kubectl version                                    # 服务器版本: v1.30.x – v1.36.x
kubectl api-resources --api-group=cert-manager.io  # 必须列出证书和发行者
kubectl get crd clusters.postgresql.cnpg.io        # 新集群必须返回 NotFound
kubectl get storageclass                           # 确认目标 StorageClass 存在
```

## 离线镜像列表

当您使用 `violet push` 上传插件包时，所有所需的镜像会自动同步到集群的注册表中。为了参考或预先审核，软件包包含五个多架构（`amd64` / `arm64`）运行时镜像（压缩总大小约为 600 MiB）：

| 目的                               | 上游镜像                                                                   | 近似大小 (`amd64`) |
| ------------------------------------- | -------------------------------------------------------------------------------- | ---------------------- |
| DocumentDB Operator                   | `ghcr.io/documentdb/documentdb-kubernetes-operator/operator:1.2.1`               | 305 MiB                |
| CNPG-I Sidecar Injector               | `ghcr.io/documentdb/documentdb-kubernetes-operator/sidecar:1.2.1`                | 25 MiB                 |
| 数据库 (PostgreSQL 18 + DocumentDB) | `ghcr.io/documentdb/documentdb-kubernetes-operator/documentdb-combined:18-1.0.1` | 172 MiB                |
| MongoDB 线协议网关                   | `ghcr.io/documentdb/documentdb-kubernetes-operator/gateway:1.0.1`                | 64 MiB                 |
| CloudNativePG Operator                | `ghcr.io/cloudnative-pg/cloudnative-pg:1.29.1`                                   | 35 MiB                 |

- `documentdb-combined` 和 `gateway` 在运行时由 DocumentDB operator 选择，并且不会出现在静态部署清单中，但两者都包含在捆绑的 `relatedImages`
  中，必须存在于集群注册表中。
- 从市场插件包安装时，运行时镜像库会自动解析为集群的本地注册表 — **不需要手动镜像覆盖**。
- 如果您的内部注册表需要身份验证，请在
  `documentdb-operator`、`cnpg-system` 和每个应用命名空间中配置 `imagePullSecrets`
  (`DocumentDB` 资源上的 `spec.imagePullSecrets`)。

## 安装 Operator

1. **上传插件包**（如果尚未存在于 OperatorHub 中）：
   ```bash
   violet push documentdb-operator.alpha.ALL.v1.2.2.tgz \
     --platform-address="https://<acp-console>" \
     --platform-username="<user>" --platform-password="<password>" \
     --clusters="<target-cluster>"
   ```
2. **从 OperatorHub 安装**：
   在 ACP 控制台中，转到 **管理员 > 市场 > OperatorHub**，选择目标集群，找到 **DocumentDB**，然后点击 **安装**。
   - 保持默认通道（`alpha`）和 **所有命名空间** 安装模式。
   - 使用建议的命名空间 **`documentdb-operator`**。
   - 等待 CSV `documentdb-operator.v1.2.2` 达到 `Succeeded` 阶段。
3. **创建 `DocumentDBOperator` 资源**：
   从 OperatorHub 安装 Operator 并不会立即部署 DocumentDB 和 CloudNativePG
   控制器。在 `documentdb-operator` 中创建一个单一的 `DocumentDBOperator` 资源，使用默认的空 `spec: {}`：
   ```yaml
   apiVersion: documentdb-operator.alauda.io/v1
   kind: DocumentDBOperator
   metadata:
     name: documentdb
     namespace: documentdb-operator
   spec: {}
   ```

> **提示：** 在上传或重新上传插件包后，刚创建的订阅可能会短暂报告 `no operators found in package`，这段时间是目录刷新。确认版本在 OperatorHub 中可见，然后重新创建订阅或在目录更新后重试。

### 验证安装

```bash
kubectl -n documentdb-operator get csv | grep documentdb-operator
kubectl -n documentdb-operator get deploy documentdb-operator
kubectl -n cnpg-system get deploy
kubectl get certificate -A | grep -E 'documentdb-operator|cnpg-system'
```

预期结果：

- `documentdb-operator.v1.2.2` 处于 `Succeeded` 阶段。
- `documentdb-operator`（在 `documentdb-operator` 中）和 `cloudnative-pg` + `sidecar-injector`
  （在 `cnpg-system` 中）均为 `Available`，重启次数为 `0`。
- 所有三个 `cert-manager` 证书报告 `READY=True`。

## 快速开始：创建并连接到 DocumentDB 实例

### 1. 创建凭证 Secret

Secret 键必须命名为 `username` 和 `password`：

```bash
kubectl create namespace <app-namespace>
kubectl -n <app-namespace> create secret generic documentdb-credentials \
  --from-literal=username=<admin-user> \
  --from-literal=password='<strong-password>'
```

### 2. 创建 `DocumentDB` 资源

下面的示例部署一个 3 实例高可用集群（1 个主节点，2 个备用节点）：

```yaml
apiVersion: documentdb.io/v1
kind: DocumentDB
metadata:
  name: <instance-name>
  namespace: <app-namespace>
spec:
  nodeCount: 1
  instancesPerNode: 3
  exposeViaService:
    serviceType: ClusterIP                    # 必需：必须显式设置
  resource:
    storage:
      pvcSize: 200Gi
      storageClass: <storageclass-name>
      persistentVolumeReclaimPolicy: Retain   # 默认；对于一次性测试实例设置为 Delete
  # imagePullSecrets:                         # 如果您的注册表需要身份验证，请取消注释
  #   - name: <pull-secret-name>
```

> **重要：** 始终显式设置 `spec.exposeViaService.serviceType`（`ClusterIP` 或
> `LoadBalancer`）。在上游 DocumentDB Operator `1.2.1` 中，省略此字段会导致
> operator 写入一个空值，导致验证失败，使资源陷入 `Failed to add finalizer` 循环。

检查集群准备情况：

```bash
kubectl -n <app-namespace> get documentdb <instance-name>
```

等待 `STATUS` 报告 `Cluster in healthy state`（对于 3 实例集群大约需要 6 分钟）。operator 在 `combined` 镜像模式下运行（operator 日志中显示 `Using combined image mode`），这是在 Kubernetes `1.30` / `1.31` 上所需的。

### 3. 连接

operator 通过服务
`documentdb-service-<instance-name>.<app-namespace>.svc` 在端口 **`10260`** 上公开当前主节点，并启用 **TLS**：

```text
mongodb://<admin-user>:<strong-password>@documentdb-service-<instance-name>.<app-namespace>.svc:10260/?tls=true&directConnection=true
```

- 默认情况下，网关使用由 `cert-manager` 签发的自签名 TLS 证书。为了快速测试，您可以传递 `tlsAllowInvalidCertificates=true`；对于生产环境，请在客户端上配置 CA 或通过 `spec.tls.gateway` 提供您自己的证书。

## 高可用性和故障转移

在 ACP `4.0.12` 上验证（`nodeCount: 1`，`instancesPerNode: 3`，Pods 分布在 3 个工作节点上），在持续的 1 次写入/秒流量中删除主 Pod 产生了：

- **约 8 秒的写入中断**，之后 CloudNativePG 提升了一个备用节点，流量通过 `documentdb-service-<instance-name>` 自动恢复。
- **在受控 Pod 删除测试期间，确认写入没有丢失**。

操作注意事项：

- 在应用程序驱动程序中配置客户端重新连接和可重试写入。
- CloudNativePG 默认使用 **异步复制**。在节点突然故障期间，最近确认的少量写入可能会丢失。如果您的工作负载要求严格的 RPO = 0，请评估上游文档中的同步复制设置，并在生产发布前在负载下验证它们。

## 已知限制

<!-- factory:auto:known-limitations BEGIN -->

- **每个集群只能有一个 CloudNativePG operator。** 此包捆绑了 CloudNativePG `1.29.1`，并且不能与另一个 CloudNativePG operator（例如 Alauda CloudNativePG）共存。如果存在未管理的 `postgresql.cnpg.io` CRDs，安装将被阻止。
- **每个集群只能有一个 DocumentDB operator。** 每个集群只能创建一个 `DocumentDBOperator` 资源。
- **`spec.exposeViaService.serviceType` 是强制性的。** 不设置该字段会因上游 `1.2.1` 验证错误而阻止协调。
- **不支持 `collation`。** 依赖于 MongoDB `collation` 的查询、索引或集合将失败（`collation is not supported in the find command yet`）。
- **组合镜像模式。** 此包使用 `combined` 镜像模式以兼容 Kubernetes `1.30`–`1.36`（无需 `ImageVolume`）。目标侧变更流（`wal_level=logical` 与单独的变更流镜像）在此模式下未经验证。
- **ACP 4.1 镜像重写说明。** 在较旧的 ACP `4.1` 补丁版本中，其市场镜像接纳政策早于更新的 Alauda 注册表域，默认的 `ImageWhiteList` 可能会在额外的 `/3rdparty/` 前缀下重写捆绑镜像。要么升级到受支持的 ACP 版本（`4.2+`），要么在 `cpaas-system` 中的 `documentdb-operator` `ImageWhiteList` 上添加匹配的 `rewriteRules` 条目。
- **默认 PV 回收策略为 `Retain`。** 删除 `DocumentDB` 资源会使其持久卷处于 `Released` 状态，直到手动回收。仅对一次性测试实例设置 `persistentVolumeReclaimPolicy: Delete`。
- **仅提供社区支持 (S0)。** 没有 CVE SLA 或自定义修复；升级跟随上游社区发布。

<!-- factory:auto:known-limitations END -->

## 卸载

1. 删除应用命名空间中的所有 `DocumentDB` 实例：
   ```bash
   kubectl -n <app-namespace> delete documentdb <instance-name>
   ```
   验证 `Released` 持久卷是否需要备份或手动删除（在默认 `Retain` 策略下）。
2. 删除 `DocumentDBOperator` 资源以移除 DocumentDB 和 CloudNativePG
   控制器：
   ```bash
   kubectl -n documentdb-operator delete documentdboperator documentdb-operator
   ```
3. 从 OperatorHub 卸载 **DocumentDB**。

为了防止意外数据丢失，卸载 Operator 会保留 `postgresql.cnpg.io`
（10 个 CRDs）和 `documentdb.io`（3 个 CRDs）自定义资源定义。仅在确认没有 `clusters.postgresql.cnpg.io` 或 `dbs.documentdb.io` 资源仍然存在后，才删除它们：

```bash
kubectl get crd -o name | grep -E '(postgresql\.cnpg\.io|documentdb\.io)$'
```

## 常见问题

**DocumentDB 在隔离环境中是否发送外部遥测？**
在 ACP `4.0.12` 上验证，OpenTelemetry 导出默认情况下是禁用的
（`request_metrics_enabled: false`，仅环回 `localhost:4317`），在环境变量或日志中未观察到出站使用遥测。对于严格的出口控制，应用一个拒绝公共出口的 `NetworkPolicy`。

**如何将现有的 MongoDB 工作负载迁移到 DocumentDB？**
请参阅本文档部分中的配套指南 *如何从 MongoDB 迁移到 DocumentDB*，其中包含迁移前的兼容性检查、经过验证的 `mongodump`/`mongorestore` 基准、容量规划、一致性检查和回滚程序。

**上游文档在哪里？**

- [DocumentDB Kubernetes Operator 文档](https://documentdb.io/documentdb-kubernetes-operator/)
- [DocumentDB Kubernetes Operator 在 GitHub 上](https://github.com/documentdb/documentdb-kubernetes-operator)
- [DocumentDB 引擎在 GitHub 上](https://github.com/documentdb/documentdb)
- [CloudNativePG 文档](https://cloudnative-pg.io/documentation/)
