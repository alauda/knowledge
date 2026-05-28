---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500290
sourceSHA: ab9bd23c0d44083483c3afd0ec2aa3b510d99bd680abf0bf89f82cc4ed1c7222
---

# Kubelet 在共享 imagefs 上的磁盘压力下发生图像垃圾回收死锁

## 问题

在 Alauda Container Platform 上，节点可能会在报告 `DiskPressure` 时卡住，同时 kubelet 不断记录 `Image garbage collection failed`。kubelet 对 `imagefs.available` 信号施加了硬驱逐阈值，以小数形式表示，例如 `0.15`（15%）。当 `imagefs.available` 降低到该硬驱逐阈值以下时，节点的 `DiskPressure` 状态会变为 `True`（`reason=KubeletHasDiskPressure`）。失败的垃圾回收过程具有独特的特征：它被记录为 `Image garbage collection failed`，并伴随有 `wanted to free 9223372036854775807 bytes, but freed 0 bytes`，其中 `9223372036854775807` 是 kubelet（v1.34.5，原生上游 kubelet）用来请求释放尽可能多的空间的 `MaxInt64` 哨兵值。

## 根本原因

超过图像垃圾回收高阈值（`imageGCHighThresholdPercent`，默认值 85）会使 kubelet 尝试通过删除图像来回收磁盘空间，直到低阈值（`imageGCLowThresholdPercent`，默认值 80），但它仅删除当前未被任何容器引用的图像。当 kubelet 对仍被容器引用的图像发出 CRI `RemoveImage` 调用时，容器运行时会以 `image is in use by a container` 错误拒绝该请求，图像不会被回收。当节点上的每个图像都被正在运行的容器引用时，图像垃圾回收器没有可驱逐的对象，回收的字节数为零——这就是为什么请求 `MaxInt64` 目标的过程在 kubelet v1.34.5 上报告 `freed 0 bytes` 的原因。由于在图像仍在使用时，收集器无法释放任何空间，因此节点始终被困在 `DiskPressure` 状态下，kubelet 不断失败图像 GC，形成一个死锁，条件永远不会自行清除。

一个常见的前提是文件系统布局。当 `/var/lib/containers`（imagefs）与应用程序数据共享同一底层设备时，应用程序数据的增长会消耗共享文件系统，并将 `imagefs.available` 推低到驱逐阈值以下。一旦共享设备的使用率保持在大约 85% 以上，节点在数学上无法满足 15% 的 `imagefs.available` 空间要求，即使图像 GC 本身行为正常，仍然保持在 `DiskPressure` 状态下。

## 解决方案

由于图像 GC 只能回收未使用的图像，而节点上的每个图像都在使用中，因此删除图像不会清除该状态；可操作的杠杆是释放共享文件系统上的空间，以便 `imagefs.available` 回升到 15% 的硬驱逐阈值以上。在共享设备上，imagefs 和应用程序数据共同存在，主要消耗者通常是非图像数据而不是图像集，因此解决方案是识别并减少消耗共享文件系统的内容。

在 Alauda Container Platform 上，一个典型的高容量消耗者是监控栈的 Prometheus 时间序列数据库，在 ACP 上作为 `cpaas-system` 命名空间中的 StatefulSet 副本 `prometheus-kube-prometheus-0-0` 运行。当该栈共享节点文件系统时，减少其磁盘占用（例如，通过监控栈的配置降低保留时间）可以释放共享设备空间；一旦使用率降回到 \~85% 以下，`imagefs.available` 恢复超过 15%，`DiskPressure` 状态就可以清除。

## 诊断步骤

通过自定义列选择器直接从 `node.status.conditions` 读取每个节点的 `DiskPressure` 状态；返回 `True` 的节点处于磁盘压力下：

```bash
kubectl get nodes -o custom-columns=\
NODE:.metadata.name,\
DISK_PRESSURE:".status.conditions[?(@.type=='DiskPressure')].status"
```

确认受影响节点上 kubelet 日志中的失败垃圾回收特征；死锁可以通过 `Image garbage collection failed` 日志行识别，该行携带 `MaxInt64` 字节目标并伴随零字节结果：

```text
Image garbage collection failed ... wanted to free 9223372036854775807 bytes, but freed 0 bytes
```

通过检查 `RemoveImage` 是否因正在使用的错误而被拒绝来验证每个图像是否在使用中，这确认了收集器没有可驱逐的对象，而不是运行时故障。最后，确认文件系统布局：当 imagefs 和应用程序数据共享一个设备时，检查总共享设备使用情况，并将使用率保持在 \~85% 以上视为使 15% 的 `imagefs.available` 要求无法满足的条件。
