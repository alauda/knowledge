---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.x,4.3.x,4.4.x'
id: KB260900002
sourceSHA: 0c082a1f1caf2d725ac9994af28353b14ccc032f44435c49c26a88c7b72a8ca2
---

# 禁用 MetalLB FRR 以避免与主机 FRR 冲突

## 问题

在裸金属的 Alauda 容器平台集群中，客户管理的 FRR 服务作为 systemd 单元在节点上运行，并已建立 BGP 会话。在安装 MetalLB 插件后，MetalLB Speaker Pods 启动自己的 FRR 进程，主机的主要路由表可能会丢失 BGP 路由。这两个 FRR 实例也可能会干扰彼此的 BGP 会话。

当主机 FRR 服务和 MetalLB Speakers 在同一节点上运行时，此解决方案适用。

## 环境

- Alauda 容器平台 4.2.x、4.3.x 或 4.4.x。
- 已安装并配置 MetalLB 插件以进行 BGP 广播。
- 客户管理的 FRR 服务作为 systemd 单元在一个或多个节点上运行。

## 根本原因

MetalLB Speakers 使用 `hostNetwork: true`。在 `frr` BGP 后端下，每个 Speaker Pod 还运行 MetalLB 管理的 `frr`、`reloader` 和 `frr-metrics` 容器。这些进程与 systemd 管理的 FRR 服务共享节点网络命名空间，因此两个 FRR 实例都可以修改主机路由表并管理重叠的 BGP 状态。

当 `spec.bgpBackend` 未设置时，MetalLB 使用 `frr` 后端。MetalLB 的 `MetalLB` 自定义资源支持 `native` 后端，该后端在不部署 MetalLB FRR 容器的情况下建立 BGP 会话。

## 解决方案

首先禁用 MetalLB 管理的 FRR。仅在 MetalLB 也需要使用 BGP 模式时考虑将后端切换到系统 FRR。

:::warning
`kubectl patch` 更改可能在平台升级后丢失。升级后请重新检查 `spec.bgpBackend`，如果不再是 `native`，请重复步骤 2。
:::

### 1. 确认当前 MetalLB 后端

该插件默认在 `metallb-system` 命名空间中创建名为 `metallb` 的 `MetalLB` 资源。在更改之前运行以下命令：

```bash
kubectl -n metallb-system get metallb
kubectl -n metallb-system get metallb metallb \
  -o jsonpath='{.spec.bgpBackend}{"\n"}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
```

如果 `bgpBackend` 输出为空，则操作员默认使用 `frr`。如果容器列表中包含 `frr`，则 MetalLB FRR 进程在 Speaker Pod 中运行。如果资源名称不同，请在命令中替换 `metallb`。

### 2. 禁用 MetalLB FRR

当 MetalLB 不需要使用 BGP 模式时，平台管理员可以将后端设置为 `native` 以禁用 MetalLB 管理的 FRR 容器：

```bash
kubectl -n metallb-system patch metallb metallb \
  --type=merge \
  -p '{"spec":{"bgpBackend":"native"}}'
```

该命令应报告 `metallb.metallb.io/metallb patched`。操作员随后会滚动 Speaker DaemonSet 并移除 MetalLB 管理的 FRR 容器。它不会停止或重新配置主机 FRR systemd 服务。

如果 MetalLB 还需要使用 BGP 模式，则不要仅执行此步骤。根据实际网络设计，进一步评估将后端切换到系统 FRR 的必要性。

### 3. 验证结果

等待 Speaker 部署完成：

```bash
kubectl -n metallb-system rollout status daemonset/speaker
```

确认后端为 `native`，并且 Speaker 模板不再包含 MetalLB FRR 容器：

```bash
kubectl -n metallb-system get metallb metallb \
  -o jsonpath='{.spec.bgpBackend}{"\n"}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
kubectl -n metallb-system get pods -l app=metallb,component=speaker -o wide
```

第一个命令必须返回 `native`。容器列表中不得包含 `frr`、`reloader`、`frr-metrics` 或 `metrics-auth-proxy-frr`。所有 Speaker Pods 应处于 `Running` 和 `Ready` 状态。
