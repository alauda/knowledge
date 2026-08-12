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

本方案仅适用于非 OpenShift 集群。MetalLB native BGP 后端不支持 OpenShift。

### 1. 在控制台配置 BGP 对等体

进入目标集群，选择 **网络 -> BGP 对等体**，创建或编辑 MetalLB 使用的 BGP 对等体。

此处不需要编辑 ConfigMap，也不需要手动创建 `BGPPeer` 资源。请在控制台中配置以下字段：

- **本地 AS**、**对端 AS**、**对端 IP**：使用网络团队分配给 MetalLB 的参数。
- **本地 IP**：必须与主机 FRR 使用的地址不同。
- **Router ID**：必须与主机 FRR 使用的 Router ID 不同。
- **BGP 连接节点**：仅选择分配给 MetalLB 的节点；如有条件，选择未运行客户 FRR 服务的节点。

MetalLB 与主机 FRR 不得使用相同的本地地址、邻居、Router ID 或宣告前缀。

### 2. 在控制台配置 BGP 外部地址池

选择 **网络 -> 外部地址池**，创建或编辑 LoadBalancer 服务使用的地址池：

1. 将 **类型** 设置为 **BGP**。
2. 在 **IP 资源** 中填写 MetalLB VIP 范围。
3. 关联上一步创建的 BGP 对等体。
4. 仅选择允许宣告该 VIP 范围的节点。

VIP 范围不得与主机 FRR 服务宣告的前缀重叠。

### 3. 切换 MetalLB 后端

当前控制台已提供 BGP 对等体和外部地址池配置，但未提供 MetalLB `bgpBackend` 配置项。由 S2 工程师在维护窗口内将其切换为 `native`，该操作会滚动更新 speaker DaemonSet。

### 4. 验证结果

speaker 滚动更新完成后，确认 speaker Pod 中不再包含 `frr`、`reloader`、`frr-metrics` 容器。然后使用正常的网络监控工具确认 MetalLB BGP 会话及 VIP 路由宣告。

Pod 就绪并不能证明 BGP 会话已建立，也不能证明预期 VIP 前缀已完成宣告。

## 回滚

若 native 模式无法满足 BGP 要求，S2 工程师可将后端恢复为 `frr`。原有主机 FRR 冲突未解决时，不应回滚。
