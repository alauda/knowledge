---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.x,4.3.x,4.4.x'
---

# 关闭 MetalLB FRR 以避免与主机 FRR 冲突

## 问题

在裸金属 Alauda Container Platform 集群中，客户自行维护的 FRR 服务以 systemd 单元的方式运行在节点上，并且已经建立 BGP 会话。安装 MetalLB 插件后，MetalLB Speaker Pod 会启动自身的 FRR 进程，可能导致主机主路由表中的 BGP 路由丢失。两套 FRR 实例还可能相互干扰 BGP 会话。

当主机 FRR 服务与 MetalLB Speaker 运行在相同节点上时，适用本解决方案。

## 环境

- Alauda Container Platform 4.2.x、4.3.x 或 4.4.x。
- 已安装 MetalLB 插件，并已配置 BGP 宣告。
- 一个或多个节点上以 systemd 单元的方式运行客户自行维护的 FRR 服务。

## 根本原因

MetalLB Speaker 使用 `hostNetwork: true`。当 BGP 后端为 `frr` 时，每个 Speaker Pod 还会运行由 MetalLB 管理的 `frr`、`reloader` 和 `frr-metrics` 容器。这些进程与 systemd 管理的 FRR 服务共享节点网络命名空间，因此两套 FRR 实例都可能修改主机路由表并管理相互重叠的 BGP 状态。

如果未设置 `spec.bgpBackend`，MetalLB 默认使用 `frr` 后端。MetalLB 自定义资源支持 `native` 后端；该后端建立 BGP 会话时不会部署 MetalLB FRR 容器。

## 解决方案

先关闭 MetalLB 自带的 FRR。只有 MetalLB 也需要使用 BGP 模式时，才考虑将 backend 切换为系统 FRR。

:::warning
通过 `kubectl patch` 修改的配置可能在平台升级后丢失。升级后请重新检查 `spec.bgpBackend`；如果不再是 `native`，请重新执行步骤 2。
:::

### 1. 确认当前 MetalLB 后端

插件默认会在 `metallb-system` 命名空间中创建名为 `metallb` 的 `MetalLB` 资源。在修改资源前执行以下命令：

```bash
kubectl -n metallb-system get metallb
kubectl -n metallb-system get metallb metallb \
  -o jsonpath='{.spec.bgpBackend}{"\n"}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
```

如果 `bgpBackend` 输出为空，表示 Operator 默认使用 `frr`。如果容器列表中包含 `frr`，表示 MetalLB FRR 进程正在 Speaker Pod 中运行。如果资源名称不同，请在后续命令中将 `metallb` 替换为实际资源名。

### 2. 关闭 MetalLB FRR

当 MetalLB 不需要使用 BGP 模式时，平台管理员可以将 backend 设置为 `native`，以停用 MetalLB 管理的 FRR 容器：

```bash
kubectl -n metallb-system patch metallb metallb \
  --type=merge \
  -p '{"spec":{"bgpBackend":"native"}}'
```

命令应返回 `metallb.metallb.io/metallb patched`。随后 Operator 会滚动更新 Speaker DaemonSet，并移除由 MetalLB 管理的 FRR 容器。该操作不会停止或重新配置主机上的 FRR systemd 服务。

如果 MetalLB 也需要使用 BGP 模式，请不要只执行本步骤；应根据实际网络方案，进一步评估将 backend 切换为系统 FRR。

### 3. 验证结果

等待 Speaker 滚动更新完成：

```bash
kubectl -n metallb-system rollout status daemonset/speaker
```

确认后端为 `native`，并且 Speaker 模板中不再包含 MetalLB FRR 容器：

```bash
kubectl -n metallb-system get metallb metallb \
  -o jsonpath='{.spec.bgpBackend}{"\n"}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
kubectl -n metallb-system get pods -l app=metallb,component=speaker -o wide
```

第一条命令必须返回 `native`。容器列表中不得包含 `frr`、`reloader`、`frr-metrics` 或 `metrics-auth-proxy-frr`。所有 Speaker Pod 都应处于 `Running` 和 `Ready` 状态。
