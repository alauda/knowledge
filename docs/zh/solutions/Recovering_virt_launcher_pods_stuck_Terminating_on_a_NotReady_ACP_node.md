---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500165
sourceSHA: 71f65210fa8f2986dea28d81d0459798a9e424d0d39984827b3c9fd2ef761748
---

# 恢复在 NotReady ACP 节点上卡住的 virt-launcher pods

## 问题

在运行 KubeVirt `v1.7.0-alauda.2` 和超融合集群操作员 `v1.17.0`（Kubernetes `v1.34.5`）的 Alauda 容器平台上，失去与控制平面的联系的工作节点停止发布其 kubelet 心跳，`kube-controller-manager` 中的节点生命周期控制器会在 `--node-monitor-grace-period`（该集群为 50 秒）到期后，将节点的 `Ready`、`MemoryPressure`、`DiskPressure` 和 `PIDPressure` 状态翻转为 `Unknown`，原因是 `NodeStatusUnknown`。

任何绑定到不可达节点的 pod 都会保持在 `Terminating` 阶段，因为 API 服务器无法确认 kubelet 实际上已停止其容器并释放其资源，而节点又不可达。每个运行的 VirtualMachineInstance 背后的 `virt-launcher-<vmi>` 托管 pod 也不例外：它们是由 `virt-controller` 创建并由 `kubevirt` 命名空间中的 `virt-handler` DaemonSet（每个节点一个 pod）监督的普通 pod，而在 NotReady 节点上，它们也因同样的原因卡在 `Terminating` 状态。

由于 `virt-launcher` 托管 pod 从未完成终止，它们绑定的 VirtualMachineInstances（`virtualmachineinstances.kubevirt.io`）不会在健康节点上被拆除和重建——在此安装中，虚拟机故障转移不会自动触发。

## 根本原因

该 ACP 安装在 `kubevirt` 命名空间中的单例 `HyperConverged` CR `kubevirt-hyperconverged` 上携带 HCO 集群默认的 `spec.evictionStrategy: None`，这意味着默认情况下关闭了在排水时的实时迁移，处于 NotReady 状态的 VMI 不会被自动撤离；`workloadUpdateStrategy.methods=["LiveMigrate"]` 设置仅管理操作员更新，而不涉及节点故障撤离。因此，卡在 `Terminating` 状态的 virt-launcher pods 是在节点生命周期宽限期到期后预期的稳定状态，直到节点对象本身被移除或节点恢复。

标准的上游节点生命周期循环驱动了这一过程。该集群上的 `kube-controller-manager` 作为其默认的 `--controllers=*,bootstrapsigner,tokencleaner` 集合的一部分运行 `nodelifecycle`，一旦 `--node-monitor-grace-period=50s` 过去而没有 kubelet 心跳，控制器会将节点的状态翻转为 `Unknown`，原因是 `NodeStatusUnknown`；该节点的 pod 清理随后等待 API 服务器能够与 kubelet 通信，而根据定义，它无法做到这一点。

## 解决方案

在采取任何破坏性操作之前，确认节点确实不可达（例如，已关闭电源、网络接口故障或硬件故障）——删除一个仅暂时断开的节点对象将拆除可能仍在其上的 pod。

一旦确认节点不可达，删除节点对象，以便控制平面可以完成与其绑定的所有 pod 的清理。节点生命周期控制器和 API 服务器将释放卡住的 `Terminating` pod，包括受影响的 `virt-launcher-<vmi>` 托管 pod，以便控制平面最终可以清理它们；在剩余健康节点上重建 VirtualMachineInstances 仅在每个 VMI 有一个驱动重建的拥有者（具有重建 `RunStrategy` 的 `VirtualMachine` 或 `VirtualMachineInstanceReplicaSet`）时才会发生——裸 VMI 不会由 `virt-controller` 自动重启：

```bash
kubectl delete node <node-name>
```

一旦底层问题解决，重新启动节点并让其重新加入集群；kubelet 将重新注册节点对象并恢复向控制平面发布其状态。

## 诊断步骤

检查节点的状态以确认它已跨越 `NodeStatusUnknown` 阈值，而不是报告暂时的波动。在不可达节点上，`Ready`、`MemoryPressure`、`DiskPressure` 和 `PIDPressure` 状态均显示 `status: Unknown`，原因是 `NodeStatusUnknown`，与健康节点的 `Ready=True`（原因是 `KubeletReady`，消息是 `kubelet is posting ready status`）形成对比：

```bash
kubectl describe node <node-name>
```

不可达节点上的状态消息显示为 `Kubelet stopped posting node status`，这是 kubelet 提供的措辞，节点生命周期控制器在停止接收心跳后会显示该消息。

列出所有命名空间中的 `Terminating` pod，以显示卡住的 virt-launcher 托管 pod 和任何其他绑定到不可达节点的工作负载：

```bash
kubectl get pods -A | grep Terminating
```

此处的 `STATUS` 列是 API 服务器返回的打印合成状态，对于 `DeletionTimestamp` 已设置但优雅终止尚未完成的 pod；在健康集群上，此命令返回为空，因此在单个节点上任何命中都是强烈信号，提示在继续之前交叉检查该节点的 `Ready` 状态。
