---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500636
sourceSHA: 5fad5dafc1b01655d1aaf8c34e14ffe66bab9aa702dade68171576b6b1cf62fe
---

# Windows VM 在 ACP 虚拟化中手动更新 virtio-win 驱动后丢失 NIC 静态 IP

## 问题

在 Alauda Container Platform 虚拟化的 KubeVirt（KubeVirt `v1.7.0-alauda.2`，命名空间 `kubevirt` 中的 HyperConverged Cluster Operator）中，Windows 客户机在内部手动更新 virtio-win 驱动后，可能会丢失其网络接口的静态 IP 配置。受影响的 NIC 是 KubeVirt 提供给 VM 的仿真 virtio-net 设备，内部的 `netkvm`（virtio-win）网络驱动程序与之绑定。virtio-win 驱动程序的介质通过与 KubeVirt 操作员包一起提供的 `virtio-container-disk:v1.7.0-alauda.2` 镜像传递给客户机，但静态 IP 丢失是驱动更新的客户机内部效应，而不是平台调度或仿真 VM 的方式发生变化。

## 根本原因

更新 virtio-win 驱动程序会促使 Windows 设备安装子系统注册一个新的 virtio 网络设备实例。之前绑定的静态 IP 会与现在被取代的（隐藏的）设备关联，而不是转移到新的设备上，因此活动接口在没有其配置地址的情况下启动。Windows `setupapi` 设备安装日志记录了未能干净配置的设备，错误代码为 `0x38`（`CM_PROB_NEED_CLASS_CONFIG`），这标记了一个类配置尚未最终确定的设备。

这种模式与类配置处于待定状态的设备一致——通常是在客户机重启未完成上一个驱动类更改之前尝试下一个更新时。平台基础（KubeVirt 仿真的 virtio-net NIC 及其默认 `virtio` 接口模型）在更新过程中保持不变；孤立的地址完全存在于客户机的设备树中。

## 解决方案

客户机 `netkvm` 驱动程序绑定的 virtio NIC 对应于 `virtio` 接口模型，这是 KubeVirt 在 ACP KubeVirt `v1.7.0-alauda.2` 上的首选和默认 `model` 值。在尝试在 Windows 客户机内部进行 virtio-win 升级之前，请检查 Windows 设备管理器中是否有任何显示黄色警告标志的设备——处于该状态的设备具有尚未最终确定的配置，并且在下一个驱动更新期间处于风险之中。

如果发现设备处于警告状态，请重启 VM，并在启动后让其正常启动，然后再开始 virtio-win 升级。重启将最终确定 virtio NIC 的待定设备类配置，以便后续的驱动更新应用于已稳定的设备实例，从而避免将静态 IP 留在被取代的设备上。

可以通过在 `kubevirt` 命名空间中的标准 KubeVirt VirtualMachine 控制来重启 VM；例如，停止并启动 VM 以强制进行干净启动：

```bash
kubectl patch virtualmachine -n <vm-namespace> <vm-name> \
  --type merge -p '{"spec":{"running":false}}'
kubectl patch virtualmachine -n <vm-namespace> <vm-name> \
  --type merge -p '{"spec":{"running":true}}'
```

## 诊断步骤

在 NIC 丢失其静态 IP 后，通过查看 Windows `setupapi` 设备安装日志确认症状，该日志中记录了错误代码为 `0x38`（`CM_PROB_NEED_CLASS_CONFIG`）的设备；该条目标识了在更新过程中未能最终确定类配置的设备。默认的 `setupapi` 日志位于客户机的 Windows 系统目录下：

```text
C:\Windows\INF\setupapi.dev.log
```

在 Windows 设备管理器中交叉检查同一设备——virtio 网络适配器是 KubeVirt 提供给 VM 的 `virtio` 模型接口，因此那里出现的黄色警告标志指向需要在任何进一步驱动更改之前进行干净重启的 NIC 实例。在重试 virtio-win 升级之前重启客户机可以解决待定配置状态，并恢复静态 IP 的正常绑定。
