---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500194
sourceSHA: 9739e2bbe66c961f54018db330695b8250c108965ed79f8d113eab70bdb8ebbf
---

# 控制平面运行多个副本时，误导性的 istiod webhook 更新错误

## 问题

在 Alauda 容器平台 (Kubernetes `v1.34.5`) 上，当通过 Alauda 服务网格路径安装 Istio 控制平面时——例如通过 `asm-operator` 包 (PackageManifest `asm-operator`，当前 CSV `asm.v4.3.3`，频道 `alpha`) 或 `servicemesh-operator2` 包，使用 `asm-global` ModulePlugin (chart `asm/chart-global-asm` v4.3.1) 在集群级别注册 Istio——`istio-system` 命名空间中的 istiod 部署未更改地打包上游 Istio。在多副本控制平面配置中，跟踪 istiod 日志的操作员会看到成对的错误行，报告无法满足 `istio-validator-<rev>` ValidatingWebhookConfiguration 的更新。这些行看起来像是真正的验证控制器失败，但实际上源于标准 kube-apiserver 的乐观并发检查，而不是格式错误的 webhook 更新。

## 根本原因

每个 istiod pod 运行其自己的验证控制器，每个控制器独立尝试更新相同的集群范围 `istio-validator-<rev>` ValidatingWebhookConfiguration 对象。当 istiod 部署的副本数量超过一个时，多个控制器在重叠的协调周期中竞争写入相同的对象。

kube-apiserver 在每个更新调用上强制执行乐观并发：如果请求体携带的 `metadata.resourceVersion` 与对象当前的 resourceVersion 不再匹配，则请求会被拒绝，并返回以 `Operation cannot be fulfilled on <resource>.<group> "<name>":` 开头，以 `the object has been modified, please apply your changes to the latest version and try again` 结尾的标准错误字符串。此行为是内置于 apiserver 接纳堆栈中的，并适用于整个通用 `admissionregistration.k8s.io/v1` 系列（MutatingWebhookConfiguration、ValidatingWebhookConfiguration 和 ValidatingAdmissionPolicy(Binding) 形状），这在 ACP 上是相同的形状。

当两个或更多 istiod 副本在同一循环中协调验证器 webhook 时，只有每轮中的第一个更新会成功；其余的携带过时的 resourceVersion，并根据该规则被 apiserver 拒绝。失败的协调器在 istiod 的日志中以一对行的形式显示拒绝——一条验证控制器消息，形式为 `error validationController failed to updated: Operation cannot be fulfilled on validatingwebhookconfigurations.admissionregistration.k8s.io "istio-validator-istio-system"`，后面跟着标准的过时 resourceVersion 尾部和 `resource version=<N>` 令牌，紧接着是来自控制器层的 `error controllers error handling istio-validator-istio-system, retrying (retry count: 1): fail to update webhook: Operation cannot be fulfilled ... controller=validation` 行，指示协调器将在下一个循环中重试。

## 解决方案

将这些日志行视为在多个 istiod 副本对单个共享 ValidatingWebhookConfiguration 对象运行时的预期产物——它们是应用于多写入者 Istio 控制平面的通用 apiserver 并发规则的一个突现属性，而不是 webhook 配置错误。无需对验证器 webhook、istiod 部署清单或 apiserver 进行任何更改，验证管道本身将继续正常工作。

为了彻底消除噪音，当工作负载不需要控制平面的水平扩展时，使用单个副本运行 istiod 部署。只有一个写入者时，不会对 `istio-validator-<rev>` 进行并发更新，因此不会出现乐观并发拒绝。

当出于可用性或容量原因需要多个 istiod 副本时，保持部署扩展，并从 istiod 日志警报中过滤成对的行（验证控制器加上控制器/验证重试），以便无害的并发拒绝不会生成操作员页面。底层的 ACP 打包——`asm-operator` 包 (CSV `asm.v4.3.3`) 或 `servicemesh-operator2`，通过 `asm-global` ModulePlugin (chart `asm/chart-global-asm` v4.3.1) 在集群中显示——将上游 istiod 与标准验证控制器一起打包；一旦实例化了 Istio 控制平面，相同的日志形状将适用。

## 诊断步骤

确认 Istio 控制平面命名空间中的 istiod 副本数量（约定为 `istio-system`）；副本数量大于一是导致并发更新竞争的前提条件，这会产生日志噪音：

```bash
kubectl get deployment -n istio-system -l app=istiod \
 -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.replicas}{"\n"}{end}'
```

检查 istiod 日志中成对的验证控制器和控制器/验证行。第一条消息标识了针对集群范围 ValidatingWebhookConfiguration 的失败更新；第二条确认协调器将其视为可重试错误：

```bash
kubectl logs -n istio-system -l app=istiod --tail=2000 \
 | grep -E 'validationController failed to updated|controllers error handling istio-validator'
```

验证目标对象是单个集群范围的 ValidatingWebhookConfiguration，其名称与 Istio 修订版相同（默认修订版：`istio-validator-istio-system`），在通用 `admissionregistration.k8s.io/v1` 形状下——这是任何符合标准的 Kubernetes 集群（包括 ACP）上可用的相同原语：

```bash
kubectl get validatingwebhookconfiguration \
 -l app=istiod -o name
```

如果集群尚未实例化 Istio 控制平面——例如，当 `asm-operator` 和 `servicemesh-operator2` 仅作为 PackageManifests 可用时，`asm-global` ModulePlugin 已注册，但未创建 `ClusterPluginInstance` 和 Istio 控制平面 CR——则 istiod 部署不存在，这些日志行无法出现。首先创建 Istio 控制平面实例，然后再查看 istiod 日志以查找成对的错误模式。
