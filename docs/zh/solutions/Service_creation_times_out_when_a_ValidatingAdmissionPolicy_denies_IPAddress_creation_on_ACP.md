---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500458
sourceSHA: 356287c2e75f7cdc388a8a7c3bd2b0cc5828f9b14e714775c3cef7899e757210
---

# 当 ValidatingAdmissionPolicy 拒绝 IPAddress 创建时，服务创建超时

## 问题

在使用 kube-apiserver `v1.34.5`（镜像 `registry.alauda.cn:60080/tkestack/kube-apiserver:v1.34.5`，kube-apiserver 静态 Pod 运行在 `kube-system`）的 Alauda 容器平台上，`admissionregistration.k8s.io/v1` 的 `ValidatingAdmissionPolicy`（VAP）和 `ValidatingAdmissionPolicyBinding`（VAPB）类型内置于 apiserver 中，并且标准的 CEL 评估管道生效。当请求匹配 VAP+binding 对并且策略的 CEL 表达式评估为拒绝时——或者在 `failurePolicy=Fail` 下评估为运行时错误——kube-apiserver 会拒绝请求，形状为 `<resource> "<name>" is forbidden: ValidatingAdmissionPolicy '<policy>' with binding '<binding>' denied request: expression '<expr>' resulted in error: <message>`。

在多 ServiceCIDR 功能下，kube-apiserver 通过其内部 `ipallocator` 创建一个 `IPAddress`（`networking.k8s.io/v1`）对象来分配服务 ClusterIP；在该集群上，`ServiceCIDR` `kubernetes` 与 `CIDRS=10.4.0.0/16` 连接，每个活动的 `IPAddress` 都携带 `ipaddress.kubernetes.io/managed-by=ipallocator.k8s.io` 标签，以及指向拥有服务的 `spec.parentRef` 为 `{resource: services, namespace: <svc-ns>, name: <svc-name>}`。由于服务创建依赖于后端 `IPAddress` 创建，因此拒绝 `IPAddress` 创建的 VAP 阻止了 apiserver 的内部 ipallocator 步骤，因此服务创建调用无法完成其 ClusterIP 分配。

## 根本原因

一个 `ValidatingAdmissionPolicy` 的 CEL 表达式解引用了在入场请求对象上不存在的字段——例如，一个引用 `request.namespace` 的策略，而匹配的资源是集群范围的，如 `IPAddress`——在策略引用在评估资源上不存在的字段时，会出现文档形式的 CEL 运行时错误 `no such key: <key>`。在 `failurePolicy=Fail` 下，CEL 运行时错误导致请求被拒绝，因此拒绝以上游 apiserver 形状浮现 `ValidatingAdmissionPolicy '<policy>' with binding '<binding>' denied request: expression '<expr>' resulted in error: no such key: <key>`。

当 ipallocator 的 `IPAddress` 创建以这种方式被拒绝时，apiserver 的服务 ClusterIP 分配步骤无法完成，因为后端 `IPAddress` 对象从未到达 apiserver 的存储。故障在于集群中的有缺陷策略，而不是在 `IPAddress` 或 `Service`；`ValidatingAdmissionPolicy` 和 `ValidatingAdmissionPolicyBinding` 是上游 Kubernetes 入场原语，位于 `admissionregistration.k8s.io/v1`，在这里的操作是相同的。

## 解决方案

实际的补救措施是先删除绑定，然后删除策略。`ValidatingAdmissionPolicyBinding` 是激活 `ValidatingAdmissionPolicy` 对匹配请求的对象（`spec.policyName` 命名策略，`spec.validationActions` 包含 `Deny`）；首先删除绑定停止策略的强制执行，然后删除策略本身移除有缺陷的 CEL 表达式，以便未来的绑定无法重新附加它。这两个对象都是位于 `admissionregistration.k8s.io/v1` 的普通 Kubernetes 资源，因此删除操作作为普通的 `kubectl delete` 命令运行，没有平台包装。

```bash
kubectl delete validatingadmissionpolicybindings <binding-name>
kubectl delete validatingadmissionpolicy <policy-name>
```

在绑定和策略被删除后，kube-apiserver 的 ipallocator 不再被拒绝的 `IPAddress` 创建路径阻塞；后续的服务创建通过标准 apiserver 代码路径完成其 ClusterIP 分配，超时停止。

## 诊断步骤

列出集群上的 `ValidatingAdmissionPolicy` 和 `ValidatingAdmissionPolicyBinding` 对象，以通过名称找出有问题的策略；在这个 kube-apiserver 构建中，这两种类型作为内置 apiserver 资源提供，因此命令可以逐字执行，无需任何 CRD 安装步骤：

```bash
kubectl get validatingadmissionpolicy
kubectl get validatingadmissionpolicybinding
```

读取 kube-apiserver Pod 日志，以捕获服务创建超时的后果和解释为什么无法分配 ClusterIP 的底层入场拒绝。kube-apiserver 静态 Pod 位于 `kube-system` 命名空间，名为 `kube-apiserver-<control-plane-IP>`；其日志流发出标准的上游 klog 行：

```bash
kubectl -n kube-system get pods -l component=kube-apiserver
kubectl -n kube-system logs kube-apiserver-<control-plane-IP>
```

要 grep 的日志形状是 ipallocator 拒绝行，形式为 `ipallocator.go:<line>] can not create IPAddress <ip>: ipaddresses.networking.k8s.io "<ip>" is forbidden: ValidatingAdmissionPolicy '<policy>' with binding '<binding>' denied request: expression '<expr>' resulted in error: <message>`。这是从 `pkg/registry/core/service/ipallocator/` 发出的上游 apiserver 源代码；在健康集群中，兄弟发射器 `cidrallocator.go:277] updated ClusterIP allocator for Service CIDR <cidr>` 在同一 kube-apiserver 日志流中可见，并确认分配器已连接，即使没有拒绝行出现。当拒绝行出现时，它命名需要在解决方案下删除的策略和绑定。

在客户端，apiserver 可能会在服务创建调用时返回超时错误，而后端 `IPAddress` 分配仍然被 VAP 阻塞；该客户端可见的症状与 apiserver 端的 `can not create IPAddress` 日志行配对，可以从 `kube-system` 中的 kube-apiserver Pod 读取。
