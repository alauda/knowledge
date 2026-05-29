---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500579
sourceSHA: 701d346a4085cccd4e0e7cb58f27b949650b03778afc68924fe57db87d2f8a10
---

# 调整 ACP 节点上的 kubelet 镜像垃圾回收阈值

## 问题

在 Alauda Container Platform 节点上，kubelet 通过删除未使用的容器镜像来回收磁盘空间，而这种回收的激进程度由两个阈值字段控制：`imageGCHighThresholdPercent` 和 `imageGCLowThresholdPercent`。当节点磁盘使用率超过高阈值时，镜像垃圾回收会运行，然后释放镜像，直到使用率降回低阈值。当高阈值设置得较低时，kubelet 更频繁地回收未使用的镜像，这可能导致镜像被删除并在后续工作负载调度时再次拉取。在运行 Server v1.34.5（原生上游 kubelet）的标准集群上，这些字段的上游默认值为 `imageGCHighThresholdPercent: 85` 和 `imageGCLowThresholdPercent: 80`，由安装程序统一应用于每个节点；伴随的基于年龄的控制默认值为 `imageMinimumGCAge: 2m0s` 和 `imageMaximumGCAge: 0s`（禁用基于年龄的 GC），因此回收完全由磁盘使用阈值驱动。

## 根本原因

当磁盘使用率超过配置的 `imageGCHighThresholdPercent` 时，会触发节点上的镜像垃圾回收。由于 `imageMaximumGCAge` 默认值为 `0s`（禁用），唯一的触发条件是磁盘使用压力：一旦使用率超过高阈值，kubelet 会删除未使用的镜像，直到使用率降到低阈值，否则保持镜像缓存不变。因此，过低的高阈值使得 kubelet 更容易跨越触发点，并回收工作负载可能在短时间内仍需要的镜像。

## 解决方案

提高 `imageGCHighThresholdPercent`（例如，从较低值提高到 `75`）可以扩大镜像垃圾回收运行前的余地，从而减少 kubelet 触发回收的频率。在 ACP 节点上，kubelet 从节点本地文件 `/var/lib/kubelet/config.yaml` 读取其有效配置；在此处调整阈值并重启 kubelet，以使新值生效。编辑目标节点上的文件以设置所需值：

```yaml
# /var/lib/kubelet/config.yaml (摘录)
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80
```

编辑后，重启该节点上的 kubelet，以便重新加载配置：

```bash
systemctl restart kubelet
```

保持 `imageGCHighThresholdPercent` 严格大于 `imageGCLowThresholdPercent`；高值是触发回收的磁盘使用点，低值是 kubelet 释放到的目标。对每个需要更改镜像 GC 行为的节点应用相同的编辑，因为这些阈值是节点本地的 kubelet 设置，而不是集群范围的对象。

## 诊断步骤

直接从 kubelet 的 `configz` 端点读取节点上当前有效的阈值，该端点以 JSON 格式返回实时合并的 kubelet 配置：

```bash
kubectl get --raw /api/v1/nodes/<node>/proxy/configz | grep imageGC
```

输出将准确打印 kubelet 合并的两个阈值行；在默认的 ACP 节点上，这读取为 `85` / `80`：

```text
"imageGCHighThresholdPercent": 85,
"imageGCLowThresholdPercent": 80,
```

由于这些阈值是由安装程序统一设置的，因此每个节点报告相同的 `imageGCHighThresholdPercent=85` / `imageGCLowThresholdPercent=80` 基线，直到节点本地编辑更改它；查询控制平面节点和工作节点并比较这两行，以确认是否有任何节点偏离了默认值。
