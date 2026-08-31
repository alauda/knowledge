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

MetalLB Speaker 使用 `hostNetwork: true`。MetalLB 默认使用 `frr` 后端，并在每个 Speaker Pod 中运行 `frr`、`reloader` 和 `frr-metrics` 容器。这些容器中的 FRR 进程与主机上的 FRR 服务共享节点网络命名空间，可能同时修改路由和 FRR 状态。

## 解决方案

通过 `ResourcePatch` 移除 Speaker DaemonSet 中 MetalLB 自带的 FRR 容器和初始化容器。此方案不会修改 `MetalLB` 资源的 backend；如果 MetalLB 还需要 BGP 宣告，请单独评估 backend 方案。

### 1. 确认当前 MetalLB 配置

Speaker DaemonSet 默认位于 `metallb-system` 命名空间，名称为 `speaker`。执行以下命令确认当前容器顺序：

```bash
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
```

默认容器顺序为 `speaker`、`frr`、`reloader`、`frr-metrics`，初始化容器顺序为 `cp-frr-files`、`cp-reloader`、`cp-metrics`、`frr-volume-permissions`。如果实际顺序不同，请根据实际顺序调整步骤 2 中的 JSON Patch 路径。

### 2. 创建 ResourcePatch 关闭 MetalLB FRR

创建以下 `ResourcePatch`。其中 `release` 使用 MetalLB 插件的 release 标识。示例按默认顺序从后向前移除 FRR 相关容器、初始化容器和卷，避免数组下标变化；如果实际顺序不同，请先调整路径。

```yaml
apiVersion: operator.alauda.io/v1alpha1
kind: ResourcePatch
metadata:
  name: metallb-disable-frr
spec:
  release: metallb-system/metallb
  target:
    apiVersion: apps/v1
    kind: DaemonSet
    name: speaker
    namespace: metallb-system
  jsonPatch:
    - op: remove
      path: /spec/template/spec/containers/3
    - op: remove
      path: /spec/template/spec/containers/2
    - op: remove
      path: /spec/template/spec/containers/1
    - op: remove
      path: /spec/template/spec/initContainers/3
    - op: remove
      path: /spec/template/spec/initContainers/2
    - op: remove
      path: /spec/template/spec/initContainers/1
    - op: remove
      path: /spec/template/spec/initContainers/0
    - op: remove
      path: /spec/template/spec/volumes/6
    - op: remove
      path: /spec/template/spec/volumes/5
    - op: remove
      path: /spec/template/spec/volumes/4
    - op: remove
      path: /spec/template/spec/volumes/3
    - op: remove
      path: /spec/template/spec/volumes/2
    - op: remove
      path: /spec/template/spec/containers/0/volumeMounts/1
```

```bash
kubectl apply -f metallb-disable-frr.yaml
```

`ResourcePatch` 生效后，Speaker DaemonSet 会滚动更新。该操作不会停止或重新配置主机上的 FRR systemd 服务，也不会修改 `MetalLB` 资源的 backend。

### 3. 验证 FRR 已关闭

等待 Speaker 更新完成：

```bash
kubectl -n metallb-system rollout status daemonset/speaker
```

确认 Speaker 只保留主容器，并且没有 FRR 初始化容器：

```bash
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.initContainers[*]}{.name}{"\n"}{end}'
kubectl -n metallb-system get pods -l app=metallb,component=speaker -o wide
```

容器列表和初始化容器列表都应只包含 `speaker`，所有 Speaker Pod 都应处于 `Running` 和 `Ready` 状态。

:::warning
通过 `ResourcePatch` 修改的配置可能在平台升级后丢失。升级后请重新检查 Speaker 容器列表；如果 FRR 容器或初始化容器恢复，请重新应用本方案。
:::
