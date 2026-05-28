---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500285
sourceSHA: a7af360b19071fd1e58eb43333abd2109f0710c5f7084169d013f14c0391365c
---

# ACP node-exporter 默认启用 Fibre Channel 收集器

## 问题

在 Alauda 容器平台上，由 prometheus 模块插件（kube-prometheus chart v4.3.3，子图表 exporter-node，在 `cpaas-system` 命名空间中）提供的 node-exporter DaemonSet 运行的是来自镜像标签 `node-exporter:v1.11.1-v4.3.4` 的上游 node_exporter 二进制文件 v1.11.1。其容器参数为 `--web.config.file`、`--path.rootfs=/host`、`--no-collector.ipvs` 和 `--collector.processes` — 其中没有 `--no-collector.fibrechannel`，因此 `fibrechannel` 收集器保持其上游默认启用状态。该收集器因此在集群中的每个节点上运行，这引发了一个问题：在没有 Fibre Channel 硬件的主机上，它是否会产生任何有用的数据。

## 根本原因

`fibrechannel` 收集器从 `/sys/class/fc_host` 读取 Fibre Channel 主机属性，因此仅在实际具有 Fibre Channel HBA 的主机上产生有意义的系列。该收集器默认启用 — node-exporter DaemonSet 参数中没有 `--no-collector.fibrechannel` 标志。在没有该硬件的节点上 — 例如 KVM 虚拟机 — 收集器保持启用状态，但由于没有 `/sys/class/fc_host` 条目可供读取，因此不会发出任何 Fibre Channel 系列。因此，在这样的主机上，收集器是无效的而不是有害的：它默认开启，但在没有 FC HBA 的节点上没有任何贡献。

## 解决方案

在需要显式关闭 `fibrechannel` 收集器的情况下 — 例如，为了在永远不会有 Fibre Channel 硬件的集群中保持启用的收集器集最小 — 在 node-exporter 命令行参数中传递 `--no-collector.<name>` 标志。对于 Fibre Channel 收集器，这个标志是 `--no-collector.fibrechannel`。这与 ACP node-exporter DaemonSet 中已经使用的相同标志机制，后者通过 `--no-collector.ipvs` 禁用 ipvs 收集器；将 `--no-collector.fibrechannel` 添加到参数列表中以相同方式关闭 Fibre Channel 收集器。

由于参数列表是由 kube-prometheus chart 渲染的 node-exporter DaemonSet 的一部分，因此通过拥有该图表的 prometheus 模块插件配置更改收集器标志，而不是直接编辑渲染的 DaemonSet，以便更改能够在协调中生效。

## 诊断步骤

node-exporter 指标端点在容器端口 9100（命名为 `metrics`）上提供。在 ACP 上，该端点通过 HTTPS 提供，并通过 node-exporter `web.config.file` 配置了基本身份验证，因此访问它需要 TLS 方案和凭据，而不是简单的未认证请求。

要确认收集器的启用/禁用状态，请检查 node-exporter DaemonSet 参数，而不是查询 Prometheus。请注意，在 ACP 上，prometheus ServiceMonitor 的保持列表在摄取之前删除 `node_fibrechannel_*` 系列，因此在 Prometheus 中该前缀的空结果并不表示缺少 FC 硬件 — 它在抓取时被删除。参数列表中缺少 `--no-collector.fibrechannel` 意味着收集器处于默认启用状态；`--no-collector.ipvs` 的存在显示了另一个收集器的禁用标志机制：

```bash
kubectl -n cpaas-system get daemonset kube-prometheus-exporter-node \
  -o jsonpath='{.spec.template.spec.containers[*].args}'
```
