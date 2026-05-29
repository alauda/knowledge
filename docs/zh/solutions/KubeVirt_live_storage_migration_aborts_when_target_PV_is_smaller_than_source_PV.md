---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500674
sourceSHA: 07ce72db9d56735fb4b4274f34fd1a7bbb1f6c0041a1948c678c0b1e37a10a26
---

# 当目标 PV 小于源 PV 时，KubeVirt 实时存储迁移中止

## 问题

在 Alauda 容器平台 (Kubernetes `v1.34.5-1`，KubeVirt 超融合 `kubevirt-kubevirt-hyperconverged` 阶段 `已部署` 在命名空间 `kubevirt`，`kubevirt-migration-controller` 正在运行) 中，虚拟机磁盘的实时存储迁移在 `virt-launcher` pod 的 QEMU 进程内部失败，尽管源和目标 `PersistentVolumeClaim` 请求了相同的存储容量。QEMU `-blockdev` 初始化中止，错误信息格式如下：

```text
-blockdev {"driver":"raw","file":"libvirt-1-storage","offset":0,"size":<source-bytes>,...}:
The sum of offset (0) and size (0) has to be smaller or equal to the actual size of the
containing file (<target-bytes>)
```

这两个字节值之间存在微小的差异——例如，源 `17,482,664,378,368` 字节与目标 `17,482,235,510,784` 字节（约短 409 MiB）——尽管两个 PVC 共享相同的 `.spec.resources.requests.storage` 值。

## 根本原因

动态存储提供者必须至少满足请求的 PVC 大小，但可以提供大于请求的 `PersistentVolume`。当 PVC 使用 `volumeMode: Block` 时，绑定的 `PersistentVolume` 被映射到 `virt-launcher` pod 作为原始块设备，QEMU 看到的是 PV 的 **实际提供容量**，而不是请求的 PVC 大小。实时存储迁移通过 `VirtualMachineStorageMigrationPlan` CR 的 `targetMigrationPVCs[].destinationPVC` 创建一个新的目标 PVC（其中 `volumeMode` 是一个接受 `Block` 的一流枚举）。如果源 PV 的提供者在请求之上进行了过度配置，而目标 PV 的分配则更为紧凑，则目标的原始块设备最终小于源的地址空间。QEMU 在复制任何数据之前检测到此前提条件违规，并以 `offset (0) and size (0) has to be smaller or equal to the actual size of the containing file` 错误中止迁移。

在 ACP 的默认存储上，过度配置是实际存在的。在实验室集群中，默认的 `StorageClass` `topolvm-hdd`（提供者 `topolvm.cybozu.com`，基于 LVM，4 MiB 物理区块）发出了请求 `1610612737` 字节的 `Block` PVC；绑定的 `PersistentVolume` 报告 `.spec.capacity.storage = 1540Mi = 1614807040` 字节，即比请求多 `+4194303` 字节（一个完整的 LVM 区块）。针对同一 `StorageClass` 发出的第二个 `Block` PVC 请求仅比前者小两个字节（`1610612735`）绑定到一个报告 `1536Mi = 1610612736` 字节的 PV——在两个 `.spec.resources.requests.storage` 值在 `Quantity` 级别上逐字相同的情况下，实际提供容量之间存在 `4 MiB` 的差异。相同的机制扩展到在现场观察到的约 409 MiB 的差距，当源和目标使用不同调优的提供者时。

## 诊断步骤

在 PVC 层面上，这种差异是不可见的。源 PVC 和目标 PVC 都会报告相同的 `.spec.resources.requests.storage`，而 `kubectl describe pvc` 比较看起来是健康的。实际提供的容量在绑定的 `PersistentVolume` 上显现，而不是在 PVC 上，因此必须在 PV 层面进行比较。

确认两个 PVC 请求了相同的存储：

```bash
kubectl -n <vm-namespace> get pvc <source-pvc> <target-pvc> \
  -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.spec.resources.requests.storage}{"\n"}{end}'
```

然后比较两个绑定 PV 的实际容量——此时不匹配变得可见：

```bash
kubectl get pv \
  -o jsonpath='{range .items[*]}{.metadata.name}{" capacity="}{.spec.capacity.storage}{" claim="}{.spec.claimRef.namespace}/{.spec.claimRef.name}{"\n"}{end}' \
  | grep -E '<source-pvc>|<target-pvc>'
```

对于 `topolvm`，每个卷的 `LogicalVolume` CR 显示了底层实现的大小，并确认请求是如何被四舍五入的：

```bash
kubectl get logicalvolumes.topolvm.cybozu.com \
  -o jsonpath='{range .items[*]}{.metadata.name}{": spec.size="}{.spec.size}{" status.currentSize="}{.status.currentSize}{"\n"}{end}'
```

如果源 PV 的 `.spec.capacity.storage` 大于目标 PV 的，则实时存储迁移在每次重试时都会遇到 QEMU 前提条件，直到目标被扩展超过源。

## 解决方案

将目标 PVC 的存储请求扩展到大于或等于源 PV 的实际字节数（而不是源 PVC 的请求）。目标 `StorageClass` 必须具有 `allowVolumeExpansion: true`；ACP 上的默认 `topolvm-hdd` 满足此条件：

```bash
kubectl get sc topolvm-hdd -o jsonpath='{.allowVolumeExpansion}{"\n"}'
```

```text
true
```

将目标 PVC 的 `.spec.resources.requests.storage` 修补为源 PV 的实际字节数：

```bash
kubectl -n <vm-namespace> patch pvc <target-pvc> --type=merge \
  -p '{"spec":{"resources":{"requests":{"storage":"<source-PV-actual-bytes>"}}}}'
```

提供者在原地扩展绑定的块设备；在 `topolvm-hdd` 上确认了这一点，将 PVC 的请求从 `1610612735` 字节修补到 `1610612740` 字节使绑定 PV 的 `.spec.capacity.storage` 从 `1536Mi` 增长到 `1540Mi`，而无需重新创建 PVC。一旦目标 PV 的 `.spec.capacity.storage` 至少与源 PV 的 `.spec.capacity.storage` 相等，重试实时存储迁移将使 QEMU 的 `-blockdev` 前提条件通过，迁移继续进行。

使用源 PV 的 `.spec.capacity.storage` 中的字节数，或来自 QEMU 错误消息本身（失败的 `-blockdev` 行中的 `size` 值）——而不是源 PVC 请求中的值，这正是导致最初不匹配的原因。
