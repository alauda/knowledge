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

在 Alauda Container Platform 集群中，节点上运行了客户自行维护的 FRR 服务。MetalLB 安装后，Speaker Pod 默认会启动 MetalLB 自带的 FRR 容器。两套 FRR 共用节点网络命名空间，可能发生冲突。

当 MetalLB 当前不需要使用 BGP 模式时，可以先关闭 MetalLB 自带的 FRR 容器。

## 环境

- Alauda Container Platform 4.2.x、4.3.x 或 4.4.x。
- 已安装 MetalLB 插件。
- 一个或多个节点上以 systemd 单元的方式运行客户自行维护的 FRR 服务。

## 根本原因

MetalLB Speaker 使用 `hostNetwork: true`。未设置 `spec.bgpBackend` 时，MetalLB 默认使用 `frr` 后端，并在每个 Speaker Pod 中运行 `frr`、`reloader` 和 `frr-metrics` 容器。这些容器中的 FRR 进程与主机上的 FRR 服务共享节点网络命名空间，可能同时修改路由和 FRR 状态。

## 解决方案

通过 `ResourcePatch` 将 MetalLB 后端设置为 `native`，由 MetalLB Operator 重新生成 Speaker DaemonSet，并移除 MetalLB 自带的 FRR 容器。此方案只用于关闭 MetalLB 自带的 FRR；如果 MetalLB 还需要 BGP 宣告，请先评估适用的 backend 方案。

### 1. 确认当前 MetalLB 配置

MetalLB 资源默认位于 `metallb-system` 命名空间，名称为 `metallb`。执行以下命令确认资源名称和当前 Speaker 容器：

```bash
kubectl -n metallb-system get metallb
kubectl -n metallb-system get metallb metallb \
  -o jsonpath='{.spec.bgpBackend}{"\n"}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
```

如果 `bgpBackend` 为空，表示当前使用默认的 `frr` 后端。容器列表中如果包含 `frr`，表示 MetalLB 自带的 FRR 正在运行。

### 2. 创建 ResourcePatch 关闭 MetalLB FRR

创建以下 `ResourcePatch`。其中 `release` 使用 MetalLB 插件的 release 标识；如果资源名称不同，请同步替换 `target.name`。

```yaml
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  name: metallb-disable-frr
spec:
  release: metallb-system/metallb
  target:
    apiVersion: metallb.io/v1beta1
    kind: MetalLB
    name: metallb
    namespace: metallb-system
  jsonPatch:
    - op: add
      path: /spec/bgpBackend
      value: native
```

```bash
kubectl apply -f metallb-disable-frr.yaml
```

`ResourcePatch` 生效后，Operator 会滚动更新 Speaker DaemonSet。该操作不会停止或重新配置主机上的 FRR systemd 服务。

### 3. 验证 FRR 已关闭

等待 Speaker 更新完成：

```bash
kubectl -n metallb-system rollout status daemonset/speaker
```

确认 MetalLB 使用 `native` 后端，并且 Speaker 只保留主容器：

```bash
kubectl -n metallb-system get metallb metallb \
  -o jsonpath='{.spec.bgpBackend}{"\n"}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
kubectl -n metallb-system get pods -l app=metallb,component=speaker -o wide
```

第一条命令应返回 `native`。容器列表中不应包含 `frr`、`reloader` 或 `frr-metrics`，所有 Speaker Pod 都应处于 `Running` 和 `Ready` 状态。

:::warning
通过 `ResourcePatch` 修改的配置可能在平台升级后丢失。升级后请重新检查 `spec.bgpBackend` 和 Speaker 容器列表；如果恢复为 `frr`，请重新应用本方案。
:::
