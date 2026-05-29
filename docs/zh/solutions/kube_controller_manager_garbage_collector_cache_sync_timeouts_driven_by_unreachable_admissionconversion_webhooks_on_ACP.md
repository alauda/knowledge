---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500447
sourceSHA: 5cc64ebf569345e7d13985ced06cccb74e5120281896a86364d65a36695a5992
---

# kube-controller-manager 垃圾收集器缓存同步超时由无法访问的 admission/conversion webhook 驱动

## 问题

在 Alauda 容器平台 (Kubernetes `v1.34.5`，kube-controller-manager 镜像标签 `v1.34.5`) 中，`kube-controller-manager` 作为 kubelet 管理的静态 Pod `kube-controller-manager-<nodeIP>` 运行在 `kube-system` 命名空间中；该二进制文件内置的垃圾收集器控制器在启动和协调期间记录 `Waiting for caches to sync for garbage collector`（上游源 `shared_informer.go`，确切的源行因构建而异）。

当垃圾收集器控制器的依赖图构建器无法在其等待窗口内完成同步时，同样的 kube-controller-manager 静态 Pod 会发出 `Unhandled Error err="unable to sync caches for garbage collector" logger="UnhandledError"`，随后是来自 `garbagecollector.go` 发射器的 `Unhandled Error err="timed out waiting for dependency graph builder sync during GC sync (attempt <N>)" logger="UnhandledError"`。同一二进制文件内的 pod-garbage-collector 子控制器在进行 Pod 垃圾收集时独立发出 `"Garbage collecting pods" logger="pod-garbage-collector-controller" numPods=<N>` 和每个 Pod 的 `"PodGC is force deleting Pod" logger="pod-garbage-collector-controller" pod="<ns>/<name>"` 行，因此在读取静态 Pod 的日志流时可以并排观察到这两个记录器。

诊断此故障模式的入口点是检查 `kube-system` 中的 kube-controller-manager 静态 Pod 以及上述 GC 日志行——这些日志行来自任何运行此 kube-controller-manager 构建的合规 Kubernetes 集群中可观察到的相同 `garbagecollector.go` / `gc_controller.go` / `shared_informer.go` 发射器，检查相邻的 admission 和 conversion-webhook 状态。

## 根本原因

这些缓存同步超时的最常见原因是 kube-apiserver 在处理垃圾收集器的依赖图构建器发出的列表/监视请求时必须调用的无法访问的 admission 或 conversion webhook。当注册的 `CustomResourceDefinition` 声明 `spec.conversion.strategy: Webhook` 且其目标 webhook 服务没有就绪端点时，kube-apiserver 的存储缓存器/反射器记录 `failed to list <group>/<version>, Kind=<Kind>: conversion webhook for <group>/<otherVersion>, Kind=<Kind> failed: Post "https://<svc>.<ns>.svc:443/convert?timeout=30s": no endpoints available for service "<svc>"`，来自上游的 `storage/cacher.go` 和 `reflector.go` 源，并重新初始化缓存器。今天，ACP 至少有四个 CRD 配置了 `spec.conversion.strategy: Webhook`（`argocds.argoproj.io`，`clusterclasses.cluster.x-k8s.io`，`monitordashboards.ait.alauda.io`，`opentelemetrycollectors.opentelemetry.io`），其中任何一个都可能在其后端 webhook 服务失去端点时驱动此路径。

kube-apiserver 对无法访问的 webhook 服务的每次 conversion-webhook 调用都会阻塞受影响 CRD 的 apiserver 列表/监视路径，并增加每次调用的延迟，直到每个 webhook 的 `timeoutSeconds`（在 conversion 调用中的 `?timeout=30s` 查询参数中反映的默认值）。这种延迟会传播到每个控制器——包括 kube-controller-manager 垃圾收集器及其领导选举续订——需要读取受影响的资源，这就是为什么即使控制器本身是健康的，GC 依赖图构建器同步也可能超时。相同的情况适用于 admission webhooks：`admissionregistration.k8s.io/v1` 中的 `MutatingWebhookConfiguration` 和 `ValidatingWebhookConfiguration` 类型定义了每个 webhook 的 `timeoutSeconds`（整数 1-30，默认 10）和 `failurePolicy`（枚举 `{Fail, Ignore}`），而一个 `failurePolicy: Fail` 的 webhook，其后端服务没有就绪端点，会阻塞 admission，直到超时到期。

间歇性的 GC 缓存同步超时也可能由集群中注册的 API 资源/CRD 的总数量非常大驱动，因为垃圾收集器的依赖图构建器必须发现并监视每种资源类型，然后才能声明缓存已同步；成本随数量增加而增加。独立地，kube-controller-manager 通过 `kube-system/kube-controller-manager` Lease 对象（`coordination.k8s.io/v1`）续订其领导租约，并在其静态 Pod 命令行上设置 `--leader-elect=true`，当对该租约端点的 API 调用因相同的上游 apiserver 延迟而减慢时，它记录 `error retrieving resource lock kube-system/kube-controller-manager: Get "<apiserver-url>/apis/coordination.k8s.io/v1/namespaces/kube-system/leases/kube-controller-manager?timeout=<N>s": net/http: request canceled (Client.Timeout exceeded while awaiting headers)` 或 `: context deadline exceeded`，来自 `leaderelection.go`——同一发射器，apiserver-URL 主机部分反映集群控制平面端点解析的内容。

## 解决方案

将 webhook 的后端 Pod 恢复到就绪状态，以便目标服务再次具有就绪端点；这消除了 `no endpoints available for service` 拒绝，并允许 webhook 调用成功而不超时，从而使垃圾收集器的依赖图构建器完成同步，apiserver 列表/监视路径恢复正常延迟。

或者，当 webhook 的后端工作负载无法及时恢复且该 webhook 对集群的操作不是必需时，删除有问题的 admission webhook 配置对象——删除它消除了 webhook 为 kube-apiserver admission 和列表/监视路径增加的每次调用延迟：

```bash
kubectl delete mutatingwebhookconfiguration <name>
kubectl delete validatingwebhookconfiguration <name>
```

对于与 CRD 关联的无法访问的 conversion webhook，相应的解除阻塞方法是恢复后端服务端点，因为 conversion-webhook clientConfig 是 CRD 规格的一部分，而 `apiextensions.k8s.io/v1` 的 `ServiceReference` 形状（`name` 必需，`namespace` 必需，`path` 可选，`port` 默认 443）与标准形式字节相同。

## 诊断步骤

在 `kube-system` 中读取 kube-controller-manager 静态 Pod 日志流，查找 `garbage-collector-controller` 和 `pod-garbage-collector-controller` 记录器——上游的 `shared_informer.go`、`garbagecollector.go` 和 `gc_controller.go` 发射器都记录在这些记录器上，因此单次日志获取会显示 GC 启动、缓存同步和 Pod 垃圾收集的行：

```bash
kubectl get pods -n kube-system | grep kube-controller-manager
kubectl logs -n kube-system kube-controller-manager-<nodeIP> \
  | grep -E 'garbage|GC|garbagecollector|gc_controller|shared_informer'
```

在同一流中查找领导选举前的 `error retrieving resource lock kube-system/kube-controller-manager` 行——它与 GC 缓存同步错误同时出现，指向上游 apiserver 延迟，而不是控制器本地问题，因为租约续订在控制器使用的同一客户端上运行：

```bash
kubectl get lease -n kube-system kube-controller-manager -o yaml
```

列出 kube-apiserver 在 admission 期间将调用的 admission webhooks，以及 apiserver 存储缓存器在处理列表/监视时将调用的 conversion webhooks——列出 `MutatingWebhookConfiguration` 和 `ValidatingWebhookConfiguration`（在 `admissionregistration.k8s.io/v1` 中为集群范围）并检查每个的目标服务和 `clientConfig` / `failurePolicy`，以识别候选的有问题 webhook：

```bash
kubectl get mutatingwebhookconfiguration
kubectl get validatingwebhookconfiguration
kubectl describe mutatingwebhookconfiguration <name>
```

将每个 webhook 配置的目标服务与其命名空间中的当前端点进行交叉引用——一个 `clientConfig.service` 指向没有就绪端点的服务的 webhook 是候选，适合服务端恢复（解决方案 `c11_b`）或 webhook 配置删除（解决方案 `c11_a`）：

```bash
kubectl -n <webhook-svc-namespace> get endpoints <webhook-svc-name> -o yaml
```

对于经过 conversion webhook 的 CRD，列出那些 `spec.conversion.strategy: Webhook` 的 CRD，并检查每个的 `spec.conversion.webhook.clientConfig.service` 与匹配的服务端点——conversion-webhook clientConfig 遵循上游 `apiextensions.k8s.io/v1` 的 `ServiceReference` 形状（`name` 必需，`namespace` 必需，`path` 可选，`port` 默认 443），因此相同的端点检查适用：

```bash
kubectl get crd \
  -o jsonpath='{range .items[?(@.spec.conversion.strategy=="Webhook")]}{.metadata.name}{"\n"}{end}'
kubectl get crd <name> \
  -o jsonpath='{.spec.conversion.webhook.clientConfig.service}{"\n"}'
```

当注册的 CRD 和 API 资源的总数量异常庞大时，将其纳入缓存同步超时窗口——垃圾收集器的依赖图构建器必须发现并监视每种类型，然后才能同步缓存，成本随数量增加而增加：

```bash
kubectl api-resources | wc -l
kubectl get crd | wc -l
```
