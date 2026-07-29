---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3'
id: KB260700098
sourceSHA: e6fa8d9dab0a749335fba63410ec2af40c9360c6de55cdc63c8d74c1850af93c
---

# Alauda 对 Konveyor 的支持 — 安装指南

## 概述

**Alauda 对 Konveyor 的支持** 是 Alauda Application Services (S2，认证) 的打包版本，基于上游的 [Konveyor](https://www.konveyor.io/) 应用现代化平台，已在 Alauda Cloud 市场上列出，并可从 ACP OperatorHub 安装。

Konveyor 是一个 CNCF 项目，帮助团队将现有应用迁移到 Kubernetes。它允许您：

- **清点和评估** 应用 — 记录其业务服务、所有者和依赖关系，然后回答评估问卷以识别风险。
- **分析源代码**，支持 Java、Python、Node.js 和 C#，以查找迁移障碍，并对每个发现进行工作量估算。
- **发现应用实际使用的技术**。
- **规划迁移波次** 并导出报告。

在 Alauda Container Platform (ACP) 上，该平台作为 Operator 提供，您可以从市场中安装。创建一个 `Tackle` 资源即可启动整个平台 — 一个 REST API（hub）、一个 Web 控制台（ui）以及分析附加组件，并在此后保持其一致性。

### 支持的版本

<!-- factory:auto:supported-versions BEGIN -->

| 项目                                   | 版本                    |
| -------------------------------------- | ---------------------- |
| ACP                                    | 4.1, 4.2, 4.3          |
| 架构                                   | amd64 (x86_64), arm64  |
| 网络                                   | IPv4, IPv6             |
| Alauda 对 Konveyor 的支持（捆绑）     | v0.9.2                 |
| Konveyor 平台                          | v0.9.2                 |
| 许可证                                 | Apache-2.0             |

<!-- factory:auto:supported-versions END -->

## 先决条件

- 一个支持上述版本的 ACP 集群，并且对目标业务集群具有 `cluster-admin` 访问权限。
- 集群的 OperatorHub 中可用的 **Alauda 对 Konveyor 的支持** 插件。如果尚未上传，管理员可以使用 `violet` CLI 推送：
  ```bash
  violet push alauda-support-for-konveyor.<version>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- 针对目标集群配置的 `kubectl`。
- **一个支持 ReadWriteOnce 卷的 StorageClass。** 该平台请求两个卷，并且没有一个卷时将无法启动。如果您的集群没有将 StorageClass 标记为默认，您必须在 `Tackle` 资源中显式命名它 — 请参见 [首先规划存储](#plan-storage-first)。

## 首先规划存储

这是安装看似挂起的最常见原因，因此在安装之前请先决定。

`Tackle` 资源请求两个 ReadWriteOnce 卷：

| 卷                   | 声明名称                             | 存储内容                               | 上游默认         | 控制台表单中预填充的内容                                                                    |
| -------------------- | ------------------------------------ | -------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| 应用数据库           | `tackle-hub-database-volume-claim`  | 应用、评估、问卷                       | 10Gi             | <!-- factory:auto:default-db-size BEGIN -->5Gi<!-- factory:auto:default-db-size END -->          |
| 文件存储             | `tackle-hub-bucket-volume-claim`    | 分析报告、上传的档案                   | **100Gi**        | <!-- factory:auto:default-bucket-size BEGIN -->10Gi<!-- factory:auto:default-bucket-size END --> |

遵循两个规则：

1. **如果您从控制台表单创建 `Tackle` 资源，** 它会预填充上述较小的大小，大多数集群可以满足。
2. **如果您手动编写 YAML 并省略大小字段，** 您将获得上游默认值 — 包括一个 **100Gi** 的文件存储，许多集群无法绑定。始终显式设置 `hub_database_volume_size` 和 `hub_bucket_volume_size`。

将 `rwo_storage_class` 和 `hub_bucket_storage_class` 设置为真实的 StorageClass 名称，除非您的集群有默认值。请使用以下命令检查：

```bash
kubectl get storageclass
```

## 安装 Operator

1. 在 ACP 控制台中，转到 **管理员 > 市场 > OperatorHub**，选择目标集群，找到 **Alauda 对 Konveyor 的支持**，然后点击 **安装**。
2. 保持默认通道（`alpha`）。对于 **安装位置**，保持建议的命名空间 **`konveyor-tackle`** — 该平台设计为在与 Operator 相同的命名空间中运行。
3. 确认安装。

### 验证 Operator

```bash
kubectl -n konveyor-tackle get csv | grep konveyor
kubectl -n konveyor-tackle get deploy
```

预期：条目 `alauda-support-for-konveyor.v<version>` 达到 `Succeeded` 阶段，Operator 自身的 Deployment 显示 `1/1` 准备就绪。

## 快速开始：启动平台

### 1. 创建 Tackle 资源

从控制台中，打开已安装的 Operator 并创建一个 **Tackle** 实例 — 表单已预填充有效值。要从命令行执行此操作：

```yaml
apiVersion: tackle.konveyor.io/v1alpha1
kind: Tackle
metadata:
  name: tackle
  namespace: konveyor-tackle
spec:
  # ── 存储 ───────────────────────────────────────────────────────────
  rwo_storage_class: ""             # 数据库卷；仅在集群有默认值时留空
  hub_bucket_storage_class: ""      # 文件存储；仅在集群有默认值时留空
  hub_database_volume_size: "5Gi"
  hub_bucket_volume_size: "10Gi"    # 上游默认为 100Gi — 明确设置此值
  rwx_supported: false              # 仅在您有 ReadWriteMany StorageClass 时设置为 true

  # ── 访问 ────────────────────────────────────────────────────────────
  ui_ingress_class_name: "none"     # "none" = 无 Ingress，通过其 Service 访问控制台；
                                    # 否则使用集群的真实类，例如 "alb"

  # ── 身份验证 ────────────────────────────────────────────────────
  feature_auth_required: "false"    # 在此版本中必须保持为 false — 请参见已知限制
```

```bash
kubectl apply -f tackle.yaml
```

> `Tackle` 直接在 `spec` 下接受任何平台的配置键。如果您使用 `kubectl apply` 并且键未在 CRD 中列出，请添加 `--validate=false`。

### 2. 等待平台启动

```bash
kubectl -n konveyor-tackle get deploy tackle-hub tackle-ui
kubectl -n konveyor-tackle get pvc
```

预期：两个 Deployment 达到 `1/1`，并且两个卷声明为 `Bound`。

> **首次启动需要几分钟。** Hub 没有就绪探针，因此在准备数据库完成之前，它会报告可用。请等待 API 响应（下一步），而不是仅依赖 Deployment 状态。

### 3. 验证 API 和附加组件

```bash
kubectl -n konveyor-tackle exec deploy/tackle-hub -- \
  curl -s -o /dev/null -w '%{http_code}\n' http://tackle-hub.konveyor-tackle.svc.cluster.local:8080/applications
# -> 200

kubectl -n konveyor-tackle get addons.tackle.konveyor.io
kubectl -n konveyor-tackle get extensions.tackle.konveyor.io
```

预期：API 返回 `200`，并且分析器 / 发现 / 平台附加组件和语言提供者扩展已注册。

### 4. 打开 Web 控制台

如果您将 `ui_ingress_class_name` 设置为真实类，则可以通过平台创建的 Ingress 访问控制台：

```bash
kubectl -n konveyor-tackle get ingress
```

否则，转发控制台的 Service：

```bash
kubectl -n konveyor-tackle port-forward svc/tackle-ui 8080:8080
# 然后打开 http://localhost:8080
```

从那里，您可以注册您的第一个应用，运行分析，并组织迁移波次。有关如何使用每个功能，请参见 [上游 Konveyor 文档](https://konveyor.io/docs/)。

## 已知限制

<!-- factory:auto:known-limitations BEGIN -->

- **此版本中无法启用身份验证。** 保持 `feature_auth_required: "false"`。启用它将启动 Keycloak 服务器及其数据库，其容器镜像仅发布于 amd64，并未包含在此包中 — 它们在 arm64 集群上无法启动，并且在没有互联网访问的集群上根本不可用。控制台可以在没有登录的情况下访问；如果需要，请在网络层（Ingress 规则，NetworkPolicy）限制访问。
- **实验性的 AI 辅助迁移功能不可用。** 由于同样的原因，请保持 `experimental_deploy_kai` 未设置。
- **`ui_ingress_class_name` 默认值为 `nginx`。** 如果您的集群没有运行具有该类的 Ingress 控制器，平台仍然会安装，但它创建的 Ingress 永远不会路由。设置集群的真实类，或设置为 `none` 以跳过创建，并通过其 Service 访问控制台。
- **运行端到端源分析不在验证的安装路径中。** 此版本验证平台的安装、API 和控制台的服务、附加组件的注册，以及在数据完整的情况下的重启。分析真实应用还需要可访问的源代码库和足够的备用容量以容纳分析 Pod。
- **没有从较旧的社区 `konveyor-operator` 目录条目（0.6.0-beta.1）升级的路径。** 这是一个单独的新发布包。请全新安装；不要期望旧条目升级到此版本。

<!-- factory:auto:known-limitations END -->

## 卸载

```bash
kubectl -n konveyor-tackle delete tackle tackle
kubectl -n konveyor-tackle get pvc          # 删除资源时会移除两个声明
```

删除 `Tackle` 资源将移除 hub、控制台和 **两个卷**，因此请先备份您需要的任何内容。然后从 **管理员 > 市场 > OperatorHub** 卸载 Operator，或：

```bash
kubectl -n konveyor-tackle delete subscription alauda-support-for-konveyor
kubectl -n konveyor-tackle delete csv -l operators.coreos.com/alauda-support-for-konveyor.konveyor-tackle
```

## 常见问题解答

**问：卷声明保持 `Pending`，且没有任何内容启动。**
集群要么没有默认的 StorageClass，要么请求的大小无法满足。运行 `kubectl -n konveyor-tackle describe pvc` 查看原因。将 `rwo_storage_class` 和 `hub_bucket_storage_class` 设置为真实类名，并检查 `hub_bucket_volume_size` — 手写的 YAML 如果省略此项则请求 100Gi。

**问：`tackle-hub` 显示可用，但控制台报告错误。**
Hub 没有就绪探针，因此在首次启动时，它在准备数据库完成之前被标记为可用。请等待 `GET /applications` 返回 `200`（如上面的第 3 步）。

**问：控制台无法访问，但所有 Pod 都在运行。**
检查 `kubectl -n konveyor-tackle get ingress`。如果为空，则 `ui_ingress_class_name` 为 `none` — 使用 `port-forward`。如果存在 Ingress 但不路由，则其类与集群中的任何 Ingress 控制器不匹配；设置集群的真实类。

**问：我可以将平台移动到不同的命名空间吗？**
不可以。Operator 以 own-namespace 范围安装，平台设计为与其一起运行，在 `konveyor-tackle` 中。

**问：我该如何升级？**
从市场中升级 Operator。它将平台组件滚动到匹配的版本，并保留现有卷。
