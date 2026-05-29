---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500627
sourceSHA: a287bfd50dbb771a34ec3a5c61029a4d5ad52504312ae05d5a818c18f02bd723
---

# VM 持久状态 PVC 在存储迁移后仍保留在源存储上

## 问题

在 Alauda Container Platform KubeVirt 虚拟化（HCO 操作员 1.17.0，KubeVirt v1.7.0-alauda.2，命名空间 `kubevirt`）中，启用持久虚拟 TPM 或持久 EFI/NVRAM 的虚拟机会获得一个小的专用 PersistentVolumeClaim 来支持该设备状态。当虚拟机的存储从一个后端迁移到另一个后端时，虚拟机的主磁盘 PVC 会移动到新的存储类。然而，小的 `persistent-state-for-<vm>` PVC 仍然保留在源存储类中，并未与主磁盘一起移动。

## 根本原因

KubeVirt 创建 `persistent-state-for-<vm>` PVC 来保存虚拟机的 vTPM 或 EFI/NVRAM 状态，并且仅在虚拟机选择启用时才会这样做——`devices.tpm.persistent` 和 `firmware.bootloader.efi.persistent` 默认值为 `false`，因此该 PVC 仅存在于启用持久 TPM 或持久 EFI 的虚拟机中。该状态 PVC 的存储类并不是从虚拟机其他磁盘的存储类派生的。相反，它由一个集群范围内的字段 `spec.vmStateStorageClass` 管理，该字段位于 `hyperconvergeds.hco.kubevirt.io`（组 `hco.kubevirt.io/v1beta1`）的单例中，描述为用于创建以保存虚拟机状态（如 TPM）的 PVC 的存储类。

由于该字段是集群范围内的全局字符串，而不是每个虚拟机的设置，因此移动虚拟机主磁盘的每个虚拟机存储迁移对状态 PVC 没有影响，导致其保留在源存储类上。ACP 通过 `virtualmachinestoragemigrations` API（组 `migrations.kubevirt.io/v1alpha1`）提供 KubeVirt 原生虚拟机存储迁移，由在 `kubevirt` 命名空间中运行的 `migcontroller-kubevirt-hyperconverged` 控制器进行协调；迁移计划针对一组虚拟机并迁移其磁盘，并且不包含集群范围内的虚拟机状态 PVC 字段。

## 解决方案

没有直接的方法可以迁移单个虚拟机的现有 `persistent-state-for-<vm>` PVC——存储迁移计划的范围仅涵盖主磁盘，而不包括状态 PVC。更改 `spec.vmStateStorageClass` 是集群全局的更改，会影响所有虚拟机，并且不会迁移现有的持久状态 PVC。

要将未来的虚拟机状态 PVC 放置在所选的存储类上，请在 `kubevirt` 命名空间中的 HyperConverged 单例上设置 `spec.vmStateStorageClass`。新创建的启用持久 TPM 或持久 EFI 的虚拟机将会在该存储类上获得其持久状态 PVC：

```bash
kubectl patch hyperconverged -n kubevirt kubevirt-hyperconverged \
 --type merge \
 -p '{"spec":{"vmStateStorageClass":"<target-storage-class>"}}'
```

此设置仅适用于更改后创建的 PVC；已经存在的 PVC 将保留在其当前存储类中。对于必须将状态 PVC 移动到不同后端的虚拟机，请在所需的存储类下重新创建虚拟机的持久状态 PVC，而不是指望磁盘迁移将其移动。

## 诊断步骤

在存储迁移后列出虚拟机的 PVC，并比较它们的存储类。主磁盘 PVC 出现在新的存储类上，而 `persistent-state-for-<vm>` PVC 仍然保留在旧的存储类上：

```bash
kubectl get pvc -n <namespace>
```

通过读取 HyperConverged 单例来确认管理新虚拟机状态 PVC 的集群范围设置；空值意味着新虚拟机状态 PVC 将回退到集群默认存储类：

```bash
kubectl get hyperconverged -n kubevirt kubevirt-hyperconverged \
 -o jsonpath='{.spec.vmStateStorageClass}'
```
