---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500583
sourceSHA: 3b7fff04f92cf3e9f0f5a1483b2f904bcff5f1176e84976472fc1c477849a27a
---

# 当源 PVC 缺少 CDI 内容类型注释时，集群间 VM 磁盘导出为 tar 存档

## 问题

在安装了 KubeVirt 的 Alauda 容器平台上（命名空间 `kubevirt`，HCO `v1.17.0`，`virt-exportproxy v1.7.0-alauda.2`，`cdi-controller v1.64.0-alauda.2`），从文件系统支持的 PVC 导出 VM 磁盘到另一个集群可能会导致新 VM 无法启动的目标磁盘。触发条件是源 PVC 的磁盘映像未标记 CDI 内容类型注释：当该注释缺失时，导出服务器通过其 `tar.gz` 格式 URL 发布卷（`VirtualMachineExport` CR 上的 `status.links.{internal,external}.volumes[].formats[].format` 接口为每个卷暴露 `disk_image` 和 `archive` 形式，选择它们的依据是源 PVC 的元数据）。

在目标端，当 CDI 在 `cdi.kubevirt.io/v1beta1` 上将该流消费到一个由 `VirtualMachine` 拥有的 PVC（而不是由 `DataVolume` 拥有）且其注释不包括 `cdi.kubevirt.io/storage.contentType` 时，控制器将传入的字节直接写入目标设备，而不解压 tar 包，导致目标卷成为一个字面意义上的 POSIX tar 存档，而不是原始磁盘映像。

## 根本原因

块或文件后端上的 tar 存档没有 MBR/GPT，没有引导加载程序，也没有文件系统供客户机固件交接——它是一系列头部+有效负载记录，而不是磁盘。因此，指向此类卷的 VM 无法完成固件到内核的交接，导致启动失败。

目标集群上的行为完全由源 PVC 的 CDI 元数据决定：由于缺少注释且 ownerReference 指向 `VirtualMachine`，上游稳定的 `cdi.kubevirt.io/v1beta1` 协调路径将传入字节视为不透明的存档内容，而不是要提取的磁盘映像，因此包装在目标卷上得以保留。

## 解决方案

在触发导出之前，在源 PVC 上设置 CDI 内容类型注释，以便导出服务器选择磁盘映像格式而不是存档格式，目标 CDI 控制器将传入流视为原始磁盘：

```bash
kubectl annotate pvc -n <source-ns> <source-pvc> \
  cdi.kubevirt.io/storage.contentType=kubevirt
```

在注释设置完成后重新运行导出和下游导入；目标卷将作为真实的磁盘映像落地，基于它创建的 VM 正常启动。相同的注释键（`cdi.kubevirt.io/storage.contentType`）在集群的 `cdi-controller v1.64.0-alauda.2` 中被相同地解释，因为组/版本 `cdi.kubevirt.io/v1beta1` 是上游稳定的，因此此解决方法适用于任何通过 `VirtualMachineExport` 加上 CDI 导入进行的叉车式跨集群 VM 迁移工作流。

## 诊断步骤

通过从 `kubevirt` 命名空间中的 VM 的 `virt-launcher` pod 中采样卷的前一兆字节，并对捕获的字节运行 `file` 命令，确认目标 PVC 实际上是一个 tar 存档（而不是损坏但仍然是磁盘映像）：

```bash
kubectl exec -n <vm-ns> <virt-launcher-pod> -- \
  dd if=/dev/vol-0 bs=1M count=1 > vol-0.out
file vol-0.out
```

响应 `POSIX tar archive (GNU)` 确认目标磁盘作为 tar 包而不是解压的磁盘映像被写入，这与上述故障模式相符，并指向源 PVC 上缺失的 `cdi.kubevirt.io/storage.contentType` 注释作为根本原因。

通过标准的 KubeVirt pod 标签找到受影响 VM 的 `virt-launcher` pod，该标签在此集群中被认可：

```bash
kubectl get pod -n <vm-ns> -l kubevirt.io=virt-launcher
```
