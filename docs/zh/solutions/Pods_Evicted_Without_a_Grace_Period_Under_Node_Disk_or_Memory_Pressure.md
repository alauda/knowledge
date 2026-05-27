---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500249
sourceSHA: 67aa8f717e4e0ffb2e1e06398bccad2d55abbbd1719077a738ea843649b52293
---

# 在节点磁盘或内存压力下，Pods 被驱逐而没有宽限期

## 问题

在运行 Kubernetes v1.34.5 的 Alauda Container Platform 节点上，当节点出现磁盘或内存压力时，工作负载可能会被突然终止，而没有宽限期进行干净的关闭。当 kubelet 超过硬驱逐阈值时，它会立即终止受影响的 pods，而不考虑任何宽限期。默认情况下，仅硬驱逐阈值生效，硬阈值设计上不带宽限期，因此在磁盘或内存压力下，pods 会立即被驱逐而没有宽限期。

## 根本原因

kubelet 的驱逐管理器支持两种阈值类型，具有不同的时间语义。硬驱逐阈值一旦被超过，会立即终止 pod，而不应用宽限期。软驱逐阈值（`evictionSoft`）则在 kubelet 驱逐 pod 之前，尊重相关的宽限期（`evictionSoftGracePeriod`）。默认情况下，kubelet 上未配置软驱逐阈值，这使得只有硬阈值处于活动状态，并产生突然的、无宽限的驱逐行为。

kubelet 的默认配置填充了一个 `evictionHard` 映射，同时在实时合并配置中缺少 `evictionSoft` 和 `evictionSoftGracePeriod`。该配置在工作节点和控制平面节点之间是统一的：每个节点上都存在相同的硬阈值，而软驱逐键则缺失。

## 诊断步骤

可以通过 kube-apiserver 节点代理从 kubelet 的 `/configz` 端点读取实时合并的驱逐配置，路径为 `/api/v1/nodes/<node>/proxy/configz`。查询此端点将返回该节点上有效的 KubeletConfiguration 作为 JSON，包括在该节点上生效的驱逐阈值映射。

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz"
```

默认响应携带一个 `evictionHard` 映射，其中包含 `memory.available`、`nodefs.available`、`nodefs.inodesFree`、`imagefs.available`、`imagefs.inodesFree` 和 `pid.available` 的阈值，并且不包含 `evictionSoft` 或 `evictionSoftGracePeriod` 键。在 `/configz` 输出中缺少 `evictionSoft` 和 `evictionSoftGracePeriod` 确认了该节点上未配置软驱逐。

```text
"evictionHard": {
  "memory.available": "100Mi",
  "nodefs.available": "10%",
  "nodefs.inodesFree": "5%",
  "imagefs.available": "15%",
  "imagefs.inodesFree": "5%",
  "pid.available": "10%"
}
```

## 解决方案

配置 `evictionSoft` 以及 `evictionSoftGracePeriod` 在驱逐之前引入宽限期，为工作负载提供终止的时间。`evictionSoft` 是驱逐信号到阈值值的映射——例如 `memory.available`、`nodefs.available`、`nodefs.inodesFree`、`imagefs.available` 和 `imagefs.inodesFree`。`evictionSoftGracePeriod` 是相同驱逐信号到宽限持续时间的映射，例如将 `memory.available` 设置为 `1m30s`。这两个键必须成对设置：只有在相应的 `evictionSoft` 阈值也被设置时，`evictionSoftGracePeriod` 中的宽限持续时间才会被尊重。

解决方法是在节点的 kubelet 上设置 `evictionSoft` 和 `evictionSoftGracePeriod` 对。机械上，这是一个标准的 kubelet 配置更改：这两个映射被添加到 kubelet 的配置源中（通常是节点本地的 kubelet 配置文件，例如 `/var/lib/kubelet/config.yaml`），然后重启 kubelet 以重新加载合并配置。两个映射中使用的驱逐信号是 kubelet 已经跟踪的标准节点压力信号。

```yaml
evictionSoft:
  memory.available: "500Mi"
  nodefs.available: "15%"
  imagefs.available: "20%"
evictionSoftGracePeriod:
  memory.available: "1m30s"
  nodefs.available: "1m30s"
  imagefs.available: "1m30s"
```

```bash
systemctl restart kubelet
```

重新读取 `/configz` 端点以检查该节点上 kubelet 当前的合并驱逐配置；在默认状态下，缺少 `evictionSoft` 和 `evictionSoftGracePeriod` 确认了软驱逐已关闭。
