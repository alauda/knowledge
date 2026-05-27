---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500227
sourceSHA: 0493771555570011a09dea7fa4d90c208db5f79fbd7369c34e9851f7dd9326a9
---

# 增加 ACP 工作节点上的 NIC RX 环形缓冲区大小

## 问题

在 Alauda Container Platform 工作节点（Kubernetes v1.34.5，调试镜像 `registry.alauda.cn:60070/acp/container-debug:v4.3.2`）上，当 NIC 的 RX 环形缓冲区对于提供的流量速率过小，工作负载可能会出现数据包丢失。内核通过 `ethtool -S <iface>` 暴露每个队列的计数器；上升的 `rx_queue_N_drops`（以及活动网络驱动程序发出的相关每队列字段，例如 KVM 支持节点上 `virtio_net` 的 `rx_queue_N_{packets,bytes,drops,xdp_*,kicks}`）是环形缓冲区饱和且驱动程序在网络栈能够出队之前丢弃帧的典型指示器。

当前配置的 RX/TX 环形缓冲区大小可以通过 `ethtool -g <iface>` 读取，该命令打印驱动程序的硬件最大值（`Pre-set maximums`）以及当前值（`Current hardware settings`）；两者之间的差距是可用于缓冲区增加的头部空间，而当前值等于硬件最大值意味着该 NIC 上无法进一步扩大。

## 根本原因

当每个队列的 RX 环形缓冲区大小低于工作负载在突发期间的需求时，驱动程序没有地方在硬件 DMA 和将其传递给内核软中断的过程中暂存传入帧，因此 NIC 会覆盖或丢弃数据包，并增加通过 `ethtool -S` 可见的每队列丢弃计数器。缓解措施是将环形缓冲区扩大到 `ethtool -g` 报告的硬件最大值，前提是该最大值大于当前值。

## 解决方案

使用 `ethtool -G <iface> rx <N>` 增加受影响接口的 RX 环形缓冲区，选择的 `<N>` 不得大于该节点上 `ethtool -g <iface>` 报告的 `Pre-set maximums` RX 值；同样的标志表面在需要时也接受 `tx <N>` 用于传输环形缓冲区。在硬件最大值较小的驱动程序上（例如 `virtio_net` 在经过验证的节点上将 RX 限制为 256），ioctl 会拒绝任何超过该限制的值，因此可实现的大小依赖于环境，而每节点的 `ethtool -g` 读数是权威的上限。

仅仅调用 `ethtool -G` 会更改实时设置，并不会在重启或接口重新初始化后保留。要使更改在节点重启时保持持久，需要一个在 kubelet 启动之前运行的节点操作系统级引导机制，以便在 Pod 网络启动时环形缓冲区已就位；此交付是平台特定的，必须通过用于集群节点镜像的任何主机配置机制处理，而不是通过任何 ACP 集群 API。

## 诊断步骤

在目标工作节点上打开特权调试会话，直接检查主机上的环形缓冲区大小和每队列计数器。`kubectl debug node` 在 ACP v1.34.5 上受支持；结合集群驻留的 `container-debug:v4.3.2` 镜像，它提供了一个 chroot 进入节点文件系统，并可使用 `ethtool` 和 `systemctl`：

```bash
NODE=<worker-node-name>
IFACE=<interface>     # 例如 KVM 支持节点上的 eth0

kubectl debug node/${NODE} \
  --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- chroot /host ethtool -g ${IFACE}

kubectl debug node/${NODE} \
  --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- chroot /host ethtool -S ${IFACE} | grep -E 'rx_queue_.*_(drops|packets)'
```

第一个命令打印 `Pre-set maximums`（硬件上限）和 `Current hardware settings`（当前值）；比较它们以确认在尝试更改之前是否存在头部空间。第二个命令列出每队列计数器；一个或多个队列的非零且递增的 `rx_queue_N_drops` 确认环形缓冲区是瓶颈。

在应用新的环形缓冲区大小后，通过相同的调试会话重新运行 `ethtool -g ${IFACE}` 以确认 `Current hardware settings` 现在反映请求的值，并在代表性流量窗口上重新采样 `ethtool -S ${IFACE}` 以确认 `rx_queue_N_drops` 停止增加。遍历每个处理受影响流量的工作节点，因为更改是针对每个节点和每个接口的。
