---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500502
sourceSHA: 91c560473c762b7cdff7518cb0a434582678f1771599c3cb13a75202050de6eb
---

# OLM catalog-operator 因命名空间 ResourceQuota 导致 CatalogSource 注册表 pod 启动缓慢

## 问题

在 Alauda Container Platform（`marketplace` chart `v4.3.7`）上，OLM `catalog-operator` 部署运行在 `cpaas-system` 命名空间中，并通过确保存在一个管理的注册表服务器 pod（命名为 `<catalogsource>-<random-suffix>`）来协调每个 `sourceType: grpc` 的 `CatalogSource`，该 pod 的 `spec.image` 被指定。ACP 平台的 CatalogSources（`cpaas-system` 中的 `platform`、`system`、`custom`）使用 `sourceType: grpc` 和 `spec.address=olm-registry-<lib>.cpaas-system.svc:50051`，并且没有 `spec.image`，因此它们没有管理的注册表 pod，无法表现出这种故障模式；这里描述的症状适用于用户创建的 `spec.image` 风格的 `CatalogSource` 对象，这些对象被放置在具有强制 `requests.memory` 的 `ResourceQuota` 的命名空间中。

当这样的用户创建的 `CatalogSource` 位于一个 `ResourceQuota` 会因注册表 pod 的 `requests.memory` 而超出的命名空间时，注册表 pod 的入场请求会被 kube-apiserver 拒绝，`catalog-operator` 无法完成对该 `CatalogSource` 的协调。对于外部观察者来说，`catalog-operator` 看起来启动相应的注册表 pod 缓慢，因为排队的工作无法超越被阻塞的项目，因为控制器的工作队列在重试同一个被阻塞的 `CatalogSource` 项目时优先于后续项目，而不是完全并行地进行。

## 根本原因

`catalog-operator` 的工作队列以串行而非完全并行的方式处理其一些 `CatalogSource` 同步项，因此单个无法被接纳的注册表 pod 的 `CatalogSource` 会在同一工作线程上阻塞后续的同步工作。阻塞信号来自上游 Kubernetes 入场：core/v1 `ResourceQuota` 入场插件拒绝 pod 创建，消息为 `pods "<pod>" is forbidden: exceeded quota: <quota>, requested: requests.memory=<N>, used: requests.memory=<U>, limited: requests.memory=<L>`，当 `used + requested > limited` 时，这个拒绝是由 kube-apiserver 产生的，而不是 OLM，因此在任何符合标准的 Kubernetes 集群（包括 ACP）上都是相同的。

当 `catalog-operator` 无法拨打已经在列出的 `CatalogSource` 的 gRPC 注册表服务时，它会发出 `queueinformer_operator.go` 同步错误，形式为 `failed to list bundles: rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial tcp <ip>:50051: connect: connection refused"` — `queueinformer_operator.go:<line>] sync ... failed: ...` 发射器包装器遵循 ACP 上的标准上游 catalog-operator 格式（仅在源构建之间的行号漂移），拨号失败的内容形状与上游相似，因为该镜像是未更改的 operator-framework/olm 构建，由 Alauda 重新打包。

## 解决方案

有两种等效的选项可以解除被拒绝的注册表 pod 入场请求，以便 `catalog-operator` 可以完成对受影响的 `CatalogSource` 的协调，并且串行工作队列可以超越之前被阻塞的项目。

**选项 A — 提高命名空间 `ResourceQuota` 限制。** 增加命名空间的 `ResourceQuota` 中报告资源的限制值（通常是 `requests.memory`，与入场拒绝中命名的范围匹配），使得 `used + requested <= limited`；这允许注册表服务器 pod 在重试时成功入场：

```bash
kubectl -n <catalogsource-namespace> edit resourcequota <quota-name>
```

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: <quota-name>
  namespace: <catalogsource-namespace>
spec:
  hard:
    requests.memory: <new-larger-value>
```

**选项 B — 移除命名空间的 `ResourceQuota`。** 当命名空间不需要配额时，删除 `ResourceQuota` 对象可以消除该命名空间的 kube-apiserver 入场门，并允许创建注册表服务器 pod：

```bash
kubectl -n <catalogsource-namespace> delete resourcequota <quota-name>
```

在任一更改后，受影响的 `CatalogSource` 的下一个协调将允许注册表服务器 pod 的入场，工作队列将超越之前被阻塞的项目。

## 诊断步骤

查看 `catalog-operator` pod 日志，以显示可能包裹注册表拨号失败的任何 `queueinformer_operator.go` 同步错误；解释为什么新注册表 pod 无法创建的 `ResourceQuota` 入场拒绝最好从 kube-apiserver 入场响应中检查（例如，通过对同一命名空间进行 `kubectl create` 干运行），而不是从 `catalog-operator` 日志中挖掘：

```bash
kubectl -n cpaas-system get pods -l app=catalog-operator
kubectl -n cpaas-system logs deploy/catalog-operator
```

查找 `queueinformer_operator.go` 同步错误，拨号失败的形状为 `failed to list bundles: rpc error: code = Unavailable ... dial tcp <ip>:50051: connect: connection refused`，针对已经列出的 CatalogSources，这表明这些源的注册表服务不可达，而队列正在重试被阻塞的项目。

同时查找 kube-apiserver 入场拒绝 `pods "<pod>" is forbidden: exceeded quota: <quota>, requested: requests.memory=<N>, used: requests.memory=<U>, limited: requests.memory=<L>` — 这一行命名了违规的配额、将要创建的 pod 以及 `used` / `limited` 值，这直接识别了需要在解决方案中调整的命名空间和 `ResourceQuota`。

识别受影响的用户创建的 `spec.image` 风格的 `CatalogSource` 对象（`cpaas-system` 中的平台 CatalogSources 是 `spec.address` 风格，不受此故障模式影响），并检查创建注册表 pod 的命名空间中的 `ResourceQuota`：

```bash
kubectl get catalogsource -A \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"\t"}{.spec.sourceType}{"\t"}{.spec.image}{"\n"}{end}'
kubectl -n <catalogsource-namespace> get resourcequota -o yaml
```

`ResourceQuota` 的 `spec.hard` 块列出了限制的范围（例如 `requests.memory`、`requests.cpu`、`limits.memory`、`limits.cpu`、`pods`）；将入场拒绝中命名的范围与需要提高或移除的 `spec.hard` 条目进行交叉引用。
