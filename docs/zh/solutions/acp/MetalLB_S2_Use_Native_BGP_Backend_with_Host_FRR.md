---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.3.x,4.4.x'
---

# S2 临时方案：解决主机 FRR 与 MetalLB FRR 的冲突

## 问题

部分裸金属 ACP 节点已通过 systemd 运行客户自行维护的 FRR 服务。当 MetalLB 使用 `frr` BGP 后端时，每个 MetalLB speaker Pod 都会在主机网络命名空间中运行多个 FRR 相关容器。MetalLB 的 FRR 进程可能修改节点主路由表，并与客户维护的 FRR 服务相互影响。

## 根本原因

MetalLB speaker 使用 `hostNetwork: true`。当 BGP 后端为 `frr` 时，speaker Pod 包含 `frr`、`reloader` 和 `frr-metrics` 容器。MetalLB FRR 进程与由 systemd 管理的 FRR 服务共享节点网络命名空间，因此二者都可能影响主机路由和 BGP 控制面。

## 临时解决方案

将 MetalLB 切换为 `native` BGP 后端。此操作会从 speaker Pod 中移除 MetalLB 管理的 FRR 容器，使 MetalLB 不再在节点网络命名空间中运行 FRR 进程。

仅在满足以下全部条件时使用本方案：

- 集群不是 OpenShift。MetalLB native BGP 后端不支持 OpenShift。
- 客户接受使用 MetalLB native BGP 实现替代 MetalLB FRR 后端。
- MetalLB 与主机 FRR 不使用相同的 BGP 本地地址、邻居、router ID 或宣告前缀。
- 已安排维护窗口。更新 `MetalLB` 资源会滚动更新 MetalLB speaker DaemonSet。

本方案仅防止 MetalLB 部署自身的 FRR 容器，**不代表**两套独立 BGP 实现可以使用相同的 BGP 身份或相同的宣告路由。应配置独立的 BGP 邻居和不重叠的宣告前缀，或仅将 MetalLB speaker 调度到未运行客户 FRR 服务的节点。

该变更属于配置临时方案。MetalLB 插件升级或重装后，需要重新验证配置。

### 1. 检查当前 MetalLB 配置

确认 MetalLB 自定义资源并记录当前 BGP 后端：

```bash
kubectl -n metallb-system get metallb
kubectl -n metallb-system get metallb metallb -o jsonpath='{.spec.bgpBackend}{"\n"}'
```

本文使用默认资源名 `metallb`。如果实际集群使用其他资源名，请在后续命令中替换。

切换前，记录当前 speaker 调度位置和 BGP 配置：

```bash
kubectl -n metallb-system get ds speaker -o wide
kubectl -n metallb-system get bgppeers,bgpadvertisements,ipaddresspools
```

与网络管理员确认：所有运行 speaker 的节点上，MetalLB 的 BGP 邻居和宣告地址池均不与主机 FRR 服务重叠。

### 2. 备份 MetalLB 资源

保存当前自定义资源，以便回滚：

```bash
kubectl -n metallb-system get metallb metallb -o yaml > metallb-before-native-backend.yaml
```

请勿使用该备份文件恢复 `status` 字段。本文的回滚命令只更新 `spec.bgpBackend`。

### 3. 切换到 native BGP 后端

将 `spec.bgpBackend` 设置为 `native`：

```bash
kubectl -n metallb-system patch metallb metallb \
  --type=merge \
  -p '{"spec":{"bgpBackend":"native"}}'
```

等待 speaker DaemonSet 滚动更新完成：

```bash
kubectl -n metallb-system rollout status daemonset/speaker
```

### 4. 验证 MetalLB FRR 容器已移除

列出 speaker Pod 模板中的容器：

```bash
kubectl -n metallb-system get daemonset speaker \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
```

输出中不应包含以下容器：

- `frr`
- `reloader`
- `frr-metrics`
- `metrics-auth-proxy-frr`（此前启用安全 FRR 指标时）

确认所有 speaker Pod 都已就绪：

```bash
kubectl -n metallb-system get pods -l app=metallb,component=speaker
```

最后，请使用客户正常的网络监控工具验证 BGP 会话状态和路由宣告。Pod 就绪并不能证明 BGP 会话已建立，也不能证明预期的 LoadBalancer 前缀已完成宣告。

### 5. 可选：将 speaker 节点与主机 FRR 节点隔离

如果有可供 MetalLB speaker 专用的节点，请通过 `MetalLB` 资源约束 speaker DaemonSet。仅为未运行客户 FRR 服务的节点添加标签：

```bash
kubectl label node <metallb-node> metallb.alauda.io/speaker=true
```

然后为 MetalLB 资源添加节点选择器：

```bash
kubectl -n metallb-system patch metallb metallb \
  --type=merge \
  -p '{"spec":{"nodeSelector":{"metallb.alauda.io/speaker":"true"}}}'
```

等待 speaker DaemonSet 滚动更新，并确认 speaker 只运行在目标节点：

```bash
kubectl -n metallb-system rollout status daemonset/speaker
kubectl -n metallb-system get pods -l app=metallb,component=speaker -o wide
```

当需要节点隔离时使用此可选步骤。它可以降低主机级冲突风险，但不能替代独立 BGP 邻居和非重叠前缀的要求。

## 回滚

如果 native 模式无法满足 BGP 要求，可恢复 MetalLB FRR 后端：

```bash
kubectl -n metallb-system patch metallb metallb \
  --type=merge \
  -p '{"spec":{"bgpBackend":"frr"}}'
kubectl -n metallb-system rollout status daemonset/speaker
```

滚动更新完成后，确认所需的 FRR 相关容器已恢复，并在恢复集群服务前验证 BGP 会话。原有主机 FRR 冲突未解决时，不应回滚至 `frr`。
