---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500807
sourceSHA: 23d1b7469460bc1dd13ffeab709e0def3877762a06919340c0bacb154b4f3583
---

# KubeVirt 虚拟机存储迁移在 ACP 上留下孤立的源 PVC

## 问题

在 Alauda 容器平台上，KubeVirt 控制平面安装在 `kubevirt` 命名空间中，基于上游 KubeVirt `v1.7.0-alauda.2`（HCO 操作员 `1.17.0`）构建，`HyperConverged/kubevirt-hyperconverged` 处于 `Deployed` 状态。ACP 上的 `virtualmachines.kubevirt.io` CRD 提供 `v1` 和 `v1alpha3`，并且是上游逐字复制的，包括 VM 级字段 `.spec.updateVolumesStrategy`（描述：`UpdateVolumesStrategy 是应用于卷更新的策略`），当设置为 `Migration` 并且 `.spec.template.spec.volumes[]` 中的 `claimName` 更改为新的目标 PVC 时，会触发实时存储迁移。

在这样的迁移完成后，正在运行的虚拟机的 `.spec.template.spec.volumes[]` 现在引用新创建的（迁移的）PVC——例如 `claimName: <vm>-mig-<suffix>` 而不是原始的 `claimName: <vm>-<original-suffix>`——并且 VMI 继续在这些新 PVC 上运行而没有中断。操作员随后观察到后端的存储分配翻倍：原始 PVC 和迁移的 PVC 同时保持已配置状态，存储阵列的去重/压缩仪表板没有显示预期的利用率下降。

## 根本原因

KubeVirt 的虚拟机存储迁移机制——无论是通过上游原生的 `.spec.updateVolumesStrategy: Migration` 字段在 `virtualmachines.kubevirt.io` 上驱动，还是通过 ACP 的附加 `migrations.kubevirt.io/v1alpha1` `VirtualMachineStorageMigrationPlan` / `VirtualMachineStorageMigration` CRD 集由 `kubevirt-migration-controller` 部署在 `kubevirt` 命名空间中进行协调——都会配置一个新的 PVC 并重新指向实时 VMI 的磁盘，但它并不会自动删除源 PVC。ACP 侧的 `VirtualMachineStorageMigrationPlan` CRD 在其模式中没有 `delete` / `reclaim` / `cleanup` / `deleteSource` / `keepSource` 的选项；其 `status.completedMigrations[].sourcePVCs[]` 仅通过 `{name, namespace, sourcePVC, volumeName}` 跟踪源 PVC，而从未发出删除请求。

由于迁移未触及源 PVC，这些 PVC 在虚拟机切换到新磁盘后仍保持与其原始 `PersistentVolume` 对象的 `phase: Bound` 状态。从集群的角度来看，它们仍然被声明活跃使用，因此绑定保持。ACP 上的默认 StorageClass 是 `topolvm-hdd`（提供者 `topolvm.cybozu.com`），其 `RECLAIMPOLICY=Delete`，但 `Delete` 仅在 PV 转换为 `Released` 时触发——而 PV 在 PVC 仍然绑定时无法变为 `Released`。因此，集群最终同时消耗源 PVC 和迁移 PVC 的容量，这就是后端观察到的容量翻倍症状。

## 解决方案

确认虚拟机的卷引用确实已移动到迁移的 PVC，然后删除孤立的源 PVC 以释放其 PV 绑定。一旦源 PVC 被删除，动态配置的 PV 上的 `Delete` 回收策略会调用 CSI 驱动程序的 `DeleteVolume` RPC，释放后端分配，恢复存储阵列上预期的非翻倍利用率。

在删除任何内容之前，请验证源 PVC 名称不再出现在实时虚拟机的 `.spec.template.spec.volumes[].persistentVolumeClaim.claimName` 中——如果它们缺失，则删除是安全的，不会干扰正在运行的 VMI：

```bash
kubectl -n <vm-namespace> get vm <vm-name> \
  -o jsonpath='{.spec.template.spec.volumes[*].persistentVolumeClaim.claimName}{"\n"}'
```

一旦输出仅列出迁移的 `claimName`（而不是原始源 PVC），删除每个孤立的源 PVC。PersistentVolumeClaim 资源是核心 `v1`，可以使用标准的 `kubectl` 命令在 ACP 上进行操作：

```bash
kubectl -n <vm-namespace> get pvc <source-pvc-name>
kubectl -n <vm-namespace> delete pvc <source-pvc-name>
```

删除后，绑定的 PV 会通过 `Released` 状态转换，并且（在 `persistentVolumeReclaimPolicy: Delete` 的情况下，动态配置的 PV 在 `topolvm-hdd` 上的默认设置）被 CSI 驱动程序移除，从而释放后端分配；存储后端的利用率随后下降到预期的迁移后占用水平。

## 诊断步骤

检查当前的虚拟机卷引用集，以识别实时虚拟机在迁移后实际使用的 PVC。此处列出的任何 PVC 名称均在使用中；在同一命名空间中未列出的 PVC 是删除候选：

```bash
kubectl -n <vm-namespace> get vm <vm-name> \
  -o jsonpath='{range .spec.template.spec.volumes[*]}{.name}{"\t"}{.persistentVolumeClaim.claimName}{"\n"}{end}'
```

列出虚拟机命名空间中的 PVC，并检查它们的阶段以确认孤立的源 PVC 仍然是 `Bound`。不再在虚拟机规格中引用的 `Bound` 源 PVC 是迁移后孤立状态的标志：

```bash
kubectl -n <vm-namespace> get pvc
kubectl -n <vm-namespace> get pvc <source-pvc-name> \
  -o jsonpath='{.status.phase}{"\n"}'
```

交叉参考绑定 PV 的回收策略，以预测 PVC 删除时会发生什么。使用 `persistentVolumeReclaimPolicy: Delete`（在 `topolvm-hdd` 上动态配置 PV 的集群默认值），删除 PVC 会释放 PV，CSI 驱动程序会移除后端卷；使用 `Retain` 时，PVC 删除后 PV 保留，操作员必须手动清理：

```bash
kubectl get sc
kubectl get pv <pv-name> \
  -o jsonpath='{.spec.persistentVolumeReclaimPolicy}{"\n"}'
```

确认存储迁移机制本身在集群上运行——在 ACP 上，`kubevirt` 命名空间中的 `kubevirt-migration-controller` 部署协调 `migrations.kubevirt.io/v1alpha1` CRD 集，其存在确认了哪个表面（虚拟机上的上游 `.spec.updateVolumesStrategy` 字段或 ACP 特定的 `VirtualMachineStorageMigrationPlan` CR）可用于触发此集群上的存储迁移：

```bash
kubectl -n kubevirt get deploy kubevirt-migration-controller
kubectl get crd | grep -E 'migrations.kubevirt.io|virtualmachinestoragemigration'
kubectl explain virtualmachine.spec.updateVolumesStrategy
```
