---
kind:
  - BestPractices
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500006
sourceSHA: b97baeb64a7e0a5f5061af938c005251577702927336511f5b4869057b9f3b7e
---

# 使用 CoreDNS 缓存指令减少 ACP 的上游 DNS 查询负载

## 问题

在 Alauda Container Platform 上，集群 DNS 由 CoreDNS 提供，内置的 CoreDNS `cache` 插件是唯一的集群内 DNS 缓存层；Kubernetes 社区的 NodeLocal DNSCache 附加组件在该平台上并不存在作为单独的缓存机制。在安装包 v4.3.4 中，集群 DNS 从容器镜像 `registry.alauda.cn:60080/tkestack/coredns:1.14.2-v4.3.4` 在 `kube-system` 命名空间中运行，其 `cache` 行为在 `cpaas-coredns` Corefile 中定义。当缓存设置得较为保守时，来自 Pods 的相同且重复失败的查询会比必要时更频繁地转发到上游解析器，从而增加集群向外部递归解析器施加的查询负载。

## 根本原因

CoreDNS `cache` 插件决定了在发出新的上游查询之前，响应被保留的时间长度，而缓存生命周期决定了重复查询被合并的程度。在本地缓存生效的情况下，来自同一节点的多个 Pods 发起的相同 DNS 查询会在缓存生命周期内从本地缓存中获取答案，而不是每个都产生自己的上游查询，这减少了转发到上游解析器的负载。负面响应则是单独管理的：当负面缓存被禁用时，每个失败的 (NXDOMAIN) 查询都会产生一个新的上游查询，而不是从本地提供服务。

## 解决方案

在 ACP 中，缓存行为通过 `cpaas-coredns` Corefile 中的 `cache` 指令进行控制，而不是通过命名的正向/负向 TTL 字段。该指令携带一个单一的位置 TTL 值，并使用 `disable` 子指令按响应类别和区域关闭缓存；标准形式在位置 TTL 下进行缓存，同时禁用集群内区域的成功和拒绝缓存。Corefile 片段如下所示：

```text
cache 30 {
    disable success cluster.local
    disable denial cluster.local
}
```

负面 (NXDOMAIN) 响应的缓存通过 `disable denial` 子指令按区域进行控制。在交付的 Corefile 中，唯一列出的区域是 `cluster.local`，因此集群内区域的负面缓存被关闭，每个对 `cluster.local` 的失败查询都会产生一个新的上游查询，而不是从本地缓存中提供服务。对于未包含在 `disable denial` 中的区域，负面响应将由 `cache` 插件在位置缓存生命周期内保存；CoreDNS 保持负面缓存的普遍理由是，在缓存窗口内重复失败的查询可以在本地回答，而不必上游查询，但请注意，当前配置并未对 `cluster.local` 进行此操作——它已被禁用。

## 诊断步骤

确认当前生效的缓存层：CoreDNS 是集群 DNS，内置的 `cache` 插件是唯一的缓存层，集群范围内没有单独的节点本地 DNS 缓存 DaemonSet。检查正在运行的 CoreDNS 配置以读取活动的 `cache` 指令：

```bash
kubectl get configmap cpaas-coredns -n kube-system \
  -o jsonpath='{.data.Corefile}'
```

读取集群 DNS 镜像标签以确认正在运行的版本：

```bash
kubectl get deploy coredns -n kube-system \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

当前配置将位置 TTL 设置为 `30` 在 `cache` 指令上，因此正向响应在该生命周期内被保留；实时 Corefile 显示 `cache 30`，而不是 `cache 0`，因此在这里不执行 TTL 为 `0` 的行为，并且未对此集群进行断言。通过检查 `disable denial` 下列出的区域来检查负面响应是否被缓存：如果某个区域存在于此，则不会进行负面缓存，因此对它的失败查询在每次尝试时都会到达上游解析器。
