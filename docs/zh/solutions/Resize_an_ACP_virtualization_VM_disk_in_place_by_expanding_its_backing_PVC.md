---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500196
sourceSHA: f7f096bf5660e051c422b735e1073179406613239d58040720052c8d03c7809c
---

# 通过扩展其后备 PVC 在 ACP 虚拟化 VM 磁盘上就地调整大小

## 问题

在安装了虚拟化组件的 Alauda 容器平台上（`kubevirt` 命名空间中的 CSV `kubevirt-hyperconverged-operator.v4.3.5`，`HyperConverged` 单例 `kubevirt-hyperconverged` 和 `CDI` 单例 `cdi-kubevirt-hyperconverged` 均已调和），每个持久 VM 磁盘在 `VirtualMachine` 上都解析为一个 `PersistentVolumeClaim` — 要么通过 `spec.template.spec.volumes[].persistentVolumeClaim.claimName` 直接引用，要么通过 `spec.template.spec.volumes[].dataVolume.name` 间接引用，在这种情况下，CDI 将命名的 `DataVolume` (`cdi.kubevirt.io/v1beta1`) 物化为同名的 PVC。因此，增加 VM 磁盘的客人可见大小实际上就是增加该后备 PVC 上的存储请求。

`kubevirt` 命名空间中的 `virt-plus` 部署（镜像 `build-harbor.alauda.cn/acp/kubevirt/virt-plus:v4.3.5`，由同一 HCO CSV 拥有）提供了该集群上 VM 管理的 Web UI 界面。当磁盘编辑表单上的磁盘大小字段未能将更改持久化到 VM 磁盘已引用的同一 PVC 时，支持的就地扩展磁盘的方法是直接使用 `kubectl` 修补底层 PVC，完全绕过 UI 表单。

## 根本原因

已绑定 PVC 的就地扩展是 Kubernetes 的通用功能，仅在绑定的 `StorageClass` 具有 `allowVolumeExpansion: true` 时生效。在该集群上，默认的 StorageClass 是 `topolvm-hdd`（供应者 `topolvm.cybozu.com`，`ALLOWVOLUMEEXPANSION=true`），满足该前提条件，因此向 PVC 的 `spec.resources.requests.storage` 向上编辑会被 CSI 驱动程序认可，并且新大小会在不重新创建 PVC 的情况下传播到客人磁盘。

## 解决方案

识别支持 VM 磁盘的 PVC，然后直接提高其存储请求。由于 `VirtualMachine.spec.template.spec.volumes[]` 中的 VM 磁盘引用已经命名了该 PVC（无论是通过 `persistentVolumeClaim.claimName` 还是通过 CDI 物化为同名 PVC 的 `dataVolume.name`），因此对该 PVC 的就地扩展保持了现有引用的完整性，VM 继续以新大小使用相同的后备存储。

从 VM 规格中读取磁盘到 PVC 的映射：

```bash
kubectl get virtualmachine -n <vm-namespace> <vm-name> \
  -o jsonpath='{.spec.template.spec.volumes[*]}{"\n"}'
```

确认 PVC 存在，状态为 `Bound`，并且使用允许扩展的 StorageClass（`topolvm-hdd` 是该集群上的默认值并符合条件）：

```bash
kubectl get pvc -n <vm-namespace> <pvc-name>
kubectl get sc topolvm-hdd \
  -o jsonpath='{.allowVolumeExpansion}{"\n"}'
```

将 PVC 的存储请求向上修补到所需大小：

```bash
kubectl patch pvc -n <vm-namespace> <pvc-name> \
  --type merge \
  -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'
```

CSI 驱动程序会认可更改，因为 `topolvm-hdd` 宣告了 `allowVolumeExpansion=true`；一旦存储层的卷被调整大小，PVC 的 `status.capacity.storage` 将更新为新值，客人会在现有磁盘引用上看到更大的块设备，而不是新创建的从节点 PVC。

## 诊断步骤

如果在修补后磁盘大小没有增长，首先验证 StorageClass 级别的前提条件。只有具有 `allowVolumeExpansion: true` 的 `StorageClass` 对象才会认可 PVC `spec.resources.requests.storage` 的就地增加；在该集群上，默认类 `topolvm-hdd`（供应者 `topolvm.cybozu.com`）是满足该条件的，因此绑定到没有该标志的不同类的 PVC 将静默地使请求未满足：

```bash
kubectl get sc
kubectl get pvc -n <vm-namespace> <pvc-name> \
  -o jsonpath='{.spec.storageClassName}{"\n"}'
```

确认在修补后 VM 磁盘引用仍指向同一 PVC — 该解决方法的整个要点是现有的 `VirtualMachine.spec.template.spec.volumes[]` 条目（无论是 `persistentVolumeClaim.claimName` 还是 `dataVolume.name`）保持不变，并继续绑定相同的后备存储，现在是更大的大小：

```bash
kubectl get virtualmachine -n <vm-namespace> <vm-name> \
  -o jsonpath='{.spec.template.spec.volumes[*]}{"\n"}'
kubectl get pvc -n <vm-namespace> <pvc-name> \
  -o jsonpath='{.status.capacity.storage}{"\n"}'
```
