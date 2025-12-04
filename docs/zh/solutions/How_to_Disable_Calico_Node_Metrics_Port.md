---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '3.16,3.18,4.0,4.1,4.2'
id: KB251200002
sourceSHA: fe78610c7c4ff3c50f59b8ba6d2217ec3aa106caba5613838c34268c27dad276
---

# 禁用 Calico 节点指标端口

## 问题

在基于 Calico 的 Kubernetes 集群中，`calico-node` DaemonSet 在每个节点上通过 TCP 端口 `9091` 暴露 Felix 指标。该指标端点仅通过自签名的 TLS 证书进行保护，并不强制实施身份验证。在不需要此端点的环境中，平台所有者可能希望完全禁用它，并出于安全和合规原因关闭所有节点上的端口 `9091`。

本文档描述了如何禁用 `calico-node` 上的 Felix Prometheus 指标并关闭端口 `9091`。

## 环境

- 使用 Calico 作为 CNI 插件的 Kubernetes 集群。
- `calico-node` 部署为 `kube-system` 命名空间中的 DaemonSet。
- 通过环境变量 `FELIX_PROMETHEUSMETRICSENABLED` 当前启用 Felix Prometheus 指标。

该操作步骤是通用的，适用于 `calico-node` 在端口 `9091` 上暴露 Felix 指标的环境。

## 解决方案

按照以下步骤禁用 Felix Prometheus 指标并关闭端口 `9091`。

> **警告**
> 更新 `calico-node` DaemonSet 将导致 Pod 重启。这可能会暂时中断容器网络。请计划维护窗口并谨慎操作。

### 步骤 1：禁用 Felix Prometheus 指标

更新 `calico-node` DaemonSet，将 `FELIX_PROMETHEUSMETRICSENABLED` 设置为 `false`：

```bash
kubectl -n kube-system set env ds/calico-node -c calico-node FELIX_PROMETHEUSMETRICSENABLED=false
```

此命令更新 `calico-node` 容器上的环境变量，并触发 DaemonSet 的滚动重启。

### 步骤 2：等待滚动重启完成

监控 `calico-node` DaemonSet 的发布状态，直到其成功完成：

```bash
kubectl -n kube-system rollout status ds/calico-node
```

仅在命令报告发布已完成后继续操作。

### 步骤 3：验证端口 9091 是否关闭

发布完成后，验证 Felix 指标是否不再在端口 `9091` 上暴露。

示例（选择适合您环境和安全策略的方法）：

1. **从托管 `calico-node` 的节点**

   - 使用 `ss` 或 `netstat` 确认没有监听 `:9091`：

     ```bash
     ss -lntp | grep ':9091[[:space:]]\+' || echo "port 9091 is not listening"
     ```

2. **从集群内部**

   - 从之前可以访问指标端点的调试 Pod 中运行：

     ```bash
     curl -k https://<node-ip>:9091/metrics || echo "metrics endpoint not reachable"
     ```

   - 指标端点应不再可访问。

一旦验证，Felix 指标在端口 `9091` 上将在全集群范围内禁用。

## 根本原因

默认情况下（或根据先前配置），`calico-node` 配置为 `FELIX_PROMETHEUSMETRICSENABLED=true`，这导致 Felix 在每个节点的 TCP 端口 `9091` 上暴露 Prometheus 指标。该端点仅通过自签名的 TLS 证书进行保护，并不实施身份验证。在不需要此端点的环境中，保持其启用会不必要地在每个节点上暴露一个额外的开放端口。

禁用 `FELIX_PROMETHEUSMETRICSENABLED` 将移除指标监听器并关闭端口 `9091`。

## 诊断步骤

使用以下步骤确定此解决方案是否适用于您的环境，并确认当前配置。

### 1. 检查 `calico-node` 配置

验证 Felix Prometheus 指标是否启用：

```bash
kubectl -n kube-system get ds calico-node -o yaml | grep -A3 FELIX_PROMETHEUSMETRICSENABLED
```

如果值为 `true` 或变量未明确设置（并且已知在您的构建中默认启用指标），则此解决方案适用。

### 2. 确认端口 9091 是否在监听

在运行 `calico-node` 的节点上，检查端口 `9091` 是否有监听：

```bash
ss -lntp | grep ':9091[[:space:]]\+'
```

如果与 `calico-node` 或 Felix 相关的进程在 `:9091` 上监听，则指标端点处于活动状态。

### 3. 确认端点可达性（可选）

从具有网络访问节点 IP 的 Pod 中，尝试访问指标端点：

```bash
curl -k https://<node-ip>:9091/metrics
```

如果您收到指标输出，则 Felix Prometheus 指标已启用并通过端口 `9091` 暴露。在这种情况下，您可以应用 **解决方案** 步骤以禁用该端点并关闭端口。
