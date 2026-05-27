---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500247
sourceSHA: 218f072f7f84485d5ca9013b1ee70bec37a37555e0898e3ba9283d2db2392c35
---

# 通过不安全的 Sysctls 在 ACP 中禁用 Pod 内的 IPv6

## 问题

在 Alauda 容器平台上，工作负载需要在其自身的网络命名空间中关闭 IPv6，这通过在 Pod 上设置内核 sysctls 来实现。Sysctls 是通过 `.spec.securityContext.sysctls` 逐个 Pod 配置的，包含 `{name, value}` 条目的列表，其中 `name` 和 `value` 都是字符串。禁用 IPv6 的两个 sysctls — `net.ipv6.conf.all.disable_ipv6` 和 `net.ipv6.conf.default.disable_ipv6` — 超出了 kubelet 默认允许的集合，因此请求它们的 Pod 会被拒绝，除非节点首先被配置为允许它们。

## 根本原因

只有命名空间的 sysctls 可以在单个 Pod 上独立设置；节点级别（非命名空间）的 sysctls 不能通过 Pod API 从 Kubernetes 内部设置。`net.*` 组中的大多数 sysctls 是命名空间的，尽管具体哪些是命名空间的取决于内核版本和发行商。在 ACP 的 Kubernetes v1.34.5 中，kubelet 默认只允许它认为安全的 sysctls，任何超出该安全集合的 sysctl 都被视为不安全。Pod 请求的不安全 sysctl 会被拒绝，除非它在节点的 kubelet 上首先被启用。

## 解决方案

启用不安全的 sysctl 是一个逐节点操作：sysctl 名称被添加到 kubelet 的 allowed-unsafe-sysctls 列表中，该列表在 kubelet 配置中作为 `allowedUnsafeSysctls` 字段暴露。默认情况下，该字段在节点上未设置，因此 kubelet 仅允许安全的白名单并拒绝不安全的请求。将两个 IPv6 sysctl 名称添加到每个必须运行工作负载的节点上的 kubelet 配置中的 `allowedUnsafeSysctls`，因为允许列表是逐节点独立评估的。

```yaml
# 每个节点应用的 kubelet 配置片段
allowedUnsafeSysctls:
  - "net.ipv6.conf.all.disable_ipv6"
  - "net.ipv6.conf.default.disable_ipv6"
```

一旦在节点上允许不安全的 sysctls，通过在 Pod 的 `securityContext.sysctls` 下设置 `net.ipv6.conf.all.disable_ipv6=1` 和 `net.ipv6.conf.default.disable_ipv6=1`，IPv6 就会在 Pod 内部被禁用。每个条目都是一个 `{name, value}` 对，包含必需的 `name` 和必需的字符串 `value`。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: ipv6-disabled
spec:
  securityContext:
    sysctls:
      - name: net.ipv6.conf.all.disable_ipv6
        value: "1"
      - name: net.ipv6.conf.default.disable_ipv6
        value: "1"
  containers:
    - name: app
      image: <image>
```

## 诊断步骤

在部署之前确认节点的 kubelet 允许列表：当 `allowedUnsafeSysctls` 未设置时 — 这是在节点上观察到的默认值 — kubelet 仅强制执行安全白名单，因此请求任何 IPv6 sysctl 的 Pod 会被拒绝。因此，只有在将这些 sysctl 的名称添加到 kubelet 的 `allowedUnsafeSysctls` 列表后，携带这些 sysctls 的 Pod 才能被允许。

```bash
# 检查已调度 Pod 的配置 sysctls
kubectl get pod ipv6-disabled \
  -o jsonpath='{.spec.securityContext.sysctls}'
```

验证值的形状 — 每个配置的 sysctl 是一个 `{name, value}` 条目，其中 `value` 是字符串，例如 `"1"`。
