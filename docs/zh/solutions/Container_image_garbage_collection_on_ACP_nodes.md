---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500255
sourceSHA: ead6f31be6a686530061345c98b9dfd84bc98d9400e148fa8881dee549fcfac5
---

# ACP 节点上的容器镜像垃圾回收

## 问题

在运行上游 Kubernetes kubelet `v1.34.5`（4 节点 Ubuntu 22.04.1 LTS，containerd 2.2.1-5）的 Alauda 容器平台节点上，未使用的容器镜像可能会在节点上积累，并且镜像文件系统的磁盘使用量持续上升，因为 kubelet 的镜像垃圾回收器不会立即删除未使用的镜像。相同的 kubelet 二进制文件同时负责镜像垃圾回收和磁盘压力驱逐路径——节点的实时合并配置暴露了驱逐阈值和 `evictionPressureTransitionPeriod`，以及镜像垃圾回收的可调参数，因此症状（稳定的镜像磁盘增长，最终的 `DiskPressure`）和垃圾回收策略共享一个所有者。

## 根本原因

kubelet 的镜像垃圾回收器依赖于合并的 `KubeletConfiguration`，并且仅在未使用的镜像达到最低年龄后才考虑将其删除。`imageMinimumGCAge` 字段定义了该最低年龄阈值：未使用的镜像如果年轻于 `imageMinimumGCAge`，则不符合镜像垃圾回收的条件，无论垃圾回收是如何触发的。

镜像垃圾回收的磁盘使用触发器受限于 `imageGCHighThresholdPercent`（kubelet 开始回收的镜像文件系统使用百分比）和 `imageGCLowThresholdPercent`（回收到的百分比）。在观察到的集群中，这些字段携带上游默认值——`imageMinimumGCAge: 2m0s`，`imageGCHighThresholdPercent: 85`，`imageGCLowThresholdPercent: 80`，`imageMaximumGCAge: 0s`——并且这些值在所有工作节点和控制平面节点上都是统一的。

当磁盘压力发生时，而节点上的未使用镜像仍然年轻于 `imageMinimumGCAge`，kubelet 不会收集这些镜像。最低年龄保护独立于磁盘压力信号，因此在默认配置的节点上，镜像文件系统可以继续增长，直到足够的镜像超过年龄阈值，或者操作员更改节点上的 kubelet 策略。

## 解决方案

在 Alauda 容器平台上调整 kubelet 镜像垃圾回收字段是一个节点级的 kubelet 配置更改。在典型的上游节点上，kubelet 在 `/var/lib/kubelet/config.yaml` 读取其磁盘配置文件，并通过 `systemctl restart kubelet` 重启以使新值生效；在编辑之前，请确认该集群的实际交付路径与节点级操作手册一致。磁盘上的文档遵循标准的上游 `KubeletConfiguration` 结构，镜像垃圾回收字段位于顶层——在此处设置 `imageMinimumGCAge`、`imageGCHighThresholdPercent`、`imageGCLowThresholdPercent` 或 `imageMaximumGCAge` 的新值，然后通过下面的 `configz` 诊断确认它们，然后再宣布更改生效。

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
imageMinimumGCAge: 1m0s
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80
imageMaximumGCAge: 0s
```

降低 `imageMinimumGCAge`（例如设置为 `1m0s` 或 `30s`）缩短了未使用镜像的保护窗口，并使 kubelet 在磁盘使用超过 `imageGCHighThresholdPercent` 时更早回收它们；提高该值则会扩大窗口并延迟回收。降低 `imageGCHighThresholdPercent` 会使 kubelet 在较低的磁盘使用水平开始镜像回收，而降低 `imageGCLowThresholdPercent` 则会使每个回收周期释放更多磁盘空间后停止。

## 诊断步骤

通过 apiserver 的节点代理 `configz` 端点读取目标节点的实时合并 kubelet 配置。该端点返回 kubelet 正在操作的有效合并 JSON，并直接暴露镜像垃圾回收字段，因此那里显示的值对于该节点上运行的 kubelet 是权威的：

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | jq '.kubeletconfig | {imageMinimumGCAge, imageGCHighThresholdPercent, imageGCLowThresholdPercent, imageMaximumGCAge}'
```

在该集群的默认配置节点上，响应携带 `imageMinimumGCAge: "2m0s"`，`imageGCHighThresholdPercent: 85`，`imageGCLowThresholdPercent: 80`，和 `imageMaximumGCAge: "0s"`——继承的上游默认值，并且相同的值出现在每个工作节点和控制平面节点上。

通过 `Node` 对象本身交叉检查节点压力侧；负责镜像垃圾回收的 kubelet 还在节点级条件表面报告 `DiskPressure` 和 `evictionHard`，这与 `configz` 端点反映的相同 kubelet 二进制文件：

```bash
kubectl describe node <node>
```
