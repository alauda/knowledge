---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500472
sourceSHA: 5dd6af5dd10e9f5ce50d7350a10a3610f38701e67afe914db60f43c9a9ab5a20
---

# 一个不健康的 CatalogSource 阻止通过 OLM 在 ACP 上安装每个 operator

## 问题

在 Alauda Container Platform（`marketplace` chart `v4.3.7`，`catalog-operator` 镜像 `registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.1`）上，OLM 控制平面在 `cpaas-system` 命名空间中运行，`catalog-operator` 在那里协调 `CatalogSource` 对象。当任何单个 `CatalogSource` 对解析器可见且变得不健康时，所有待处理的 `Subscription`（其解析涉及该命名空间）将停止进展以进行安装，即使它请求的包位于一个无关的、健康的目录中。

当 `catalog-operator` 无法访问 `CatalogSource` 的 gRPC 注册端点时，其日志可能会发出类似 `failed to populate resolver cache from source <name>/<namespace>: ...` 的行，后面跟着一个 `rpc error` 变体；在此构建（`registry.alauda.cn:60080/3rdparty/operator-framework/olm:v4.3.1`）中，底层发射器是上游的 `operator-framework/olm` 二进制文件，它会显示 `code = Unavailable desc = connection error: ... connect: connection refused`（当拨号被拒绝时）或 `code = DeadlineExceeded desc = context deadline exceeded`（当拨号超时时），具体取决于不健康源的故障模式。在此条件持续存在时，受影响的 `Subscription` 资源记录 `status.conditions` 条目 `type=CatalogSourcesUnhealthy`，每个源的 `status.catalogHealth[]` 数组为失败的目录携带 `healthy: false` 条目；OLM 不会提交 operator 安装更改，直到不健康的目录被移除或其端点再次可达。

## 根本原因

OLM 依赖解析器会咨询在其考虑的命名空间中可见的每个 `CatalogSource`，而不管该 `Subscription` 是否声明对该目录中包的显式依赖。如果这些可见的 `CatalogSource` 对象中的任何一个在解析器列出其包时返回错误，解析器会中止整个 `Subscription` 的解析，而不是继续处理那些响应的目录。

这种中止错误的行为是设计使然：由于可用包的视图不完整，解析器可能会选择错误的安装候选项，因此它会停止，直到目录集再次一致。因此，每个受影响的 `Subscription` 上的 `status.conditions[type=CatalogSourcesUnhealthy]` 条目保持存在，并且在不健康的 `CatalogSource` 被移除或其注册表再次可达之前，不会提交进一步的安装计划。

## 解决方案

恢复目录健康，以便解析器的视图变得一致，待处理的 `Subscription` 解析可以完成。有两条路径。

**选项 A — 修复不健康的 `CatalogSource`。** 修复失败源上的连接或健康问题，使其 gRPC 服务再次在 `<address>:50051` 上响应。一旦解析器能够从中列出包，阻塞的依赖解析将在下一个协调中清除，待处理的 `Subscription` 将继续安装：

```bash
kubectl -n cpaas-system get catalogsource
kubectl -n cpaas-system get catalogsource <name> -o yaml
```

**选项 B — 删除不健康的 `CatalogSource`。** 移除损坏的 `CatalogSource` 资源，使其不再对解析器可见。一旦该源从列出的集合中消失，解析器将不再因其错误而中止，待处理的 `Subscription` 对象（其所需包可从健康目录中获得）完成解析：

```bash
kubectl -n cpaas-system delete catalogsource <name>
```

ACP 上的三个默认平台 `CatalogSource` 资源（`platform`、`system`、`custom` 在 `cpaas-system` 中）使用 `sourceType: grpc`，其 `spec.address=olm-registry-<lib>.cpaas-system.svc:50051`。支持这些地址的注册表 pod（`olm-registry-{platform,system,custom}` 部署在 `cpaas-system` 中）是长期运行的，并由 `marketplace` chart 提供，而不是由 `catalog-operator` 从 `CatalogSource` 上的 `spec.image` 引导；本文中的故障模式适用于 `catalog-operator` 直接管理的 `sourceType: grpc` 的用户创建的 `CatalogSource` 资源。没有与上游 `OperatorHub` 协调器等效的 ACP 级别聚合禁用切换，但删除默认的 `CatalogSource` 可能会在 `marketplace` chart 的 helm 协调器的后续运行中被协调回来——更安全的是将选项 B 限定为用户创建的 `CatalogSource` 资源，并在它们被创建的命名空间中删除它们。

## 诊断步骤

跟踪 `catalog-operator` pod 日志，以显示哪个 `CatalogSource` 无法访问以及 `failed to populate resolver cache` 错误字符串，解释为什么一个本应有效的 `Subscription` 没有进展到安装：

```bash
kubectl -n cpaas-system get pods -l app=catalog-operator
kubectl -n cpaas-system logs deploy/catalog-operator
```

检查待处理的 `Subscription` 资源，并阅读其 `status.conditions` 和 `status.catalogHealth[]`，以准确识别解析器认为不健康的 `CatalogSource`；`type=CatalogSourcesUnhealthy` 条件和每个源的 `healthy: false` 条目在 `status.catalogHealth[]` 中直接命名失败的目录及其最后评估的时间：

```bash
kubectl -n <subscription-namespace> get subscription <name> -o yaml
```

一个代表性的健康条目如下所示；不健康的目录将相同条目翻转为 `healthy: false`，而 `CatalogSourcesUnhealthy` 条件报告 `status: True`，并带有非 `AllCatalogSourcesHealthy` 的原因：

```yaml
status:
  catalogHealth:
  - catalogSourceRef:
      name: <catalog-name>
      namespace: cpaas-system
    healthy: true
    lastUpdated: "2026-05-13T05:47:51Z"
  conditions:
  - type: CatalogSourcesUnhealthy
    status: "False"
    reason: AllCatalogSourcesHealthy
```

将 `Subscription` 条件中命名的目录与 `kubectl -n cpaas-system get catalogsource` 中的条目进行交叉引用，以定位有问题的 `CatalogSource`，然后应用解决方案选项之一以清除阻塞。
