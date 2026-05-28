---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500382
sourceSHA: 209c8533a0eace76d0e18e825d42bb8e2818e936059b7be6aef00d0f554e4ae1
---

# 在 ACP 虚拟化中发现恢复的 PVC 名称

## 问题

在使用 `kubevirt-operator` 套件的 Alauda Container Platform（插件版本 `kubevirt v1.7.0-alauda.2`，上游 KubeVirt 1.17.0，安装在 Kubernetes v1.34.5 的 `kubevirt` 命名空间中），新创建的虚拟机的启动磁盘 PVC 名称是可预测的：`spec.template.spec.volumes[].dataVolume.name` 在虚拟机 CR 中同时指向同一命名空间中的 DataVolume 和 PersistentVolumeClaim，因此操作员可以通过读取虚拟机清单来定位启动磁盘。当相同的工作负载从快照中恢复时，PVC 名称不再源自该虚拟机面向的字段——恢复控制器将结果 PVC 引用写入恢复 CR 的单独状态字段中，因此定位新的 PVC 需要读取该状态，而不是猜测名称。

## 解决方案

从虚拟机 CR 中读取启动磁盘 PVC 名称。`kubevirt.io/v1` 虚拟机模式的 `spec.template.spec.volumes[].dataVolume.name` 字段携带虚拟机命名空间中 DataVolume 和 PVC 的名称，因此对该路径进行一次 `kubectl get vm -o jsonpath` 查询即可返回 PVC 名称，而无需进一步查找：

```bash
kubectl get vm -n <vm-namespace> <vm-name> \
 -o jsonpath='{.spec.template.spec.volumes[*].dataVolume.name}'
```

从虚拟机快照恢复后，不要推断 PVC 名称——应从恢复对象中读取。`snapshot.kubevirt.io/v1beta1` 虚拟机恢复 CRD 暴露了 `status.restores[].persistentVolumeClaim`（必需字段），恢复控制器在此记录每个卷条目的实际 PVC 名称。在恢复 CR 报告完成后查询，以获取权威的 PVC 引用：

```bash
kubectl get virtualmachinerestore -n <vm-namespace> <restore-name> \
 -o jsonpath='{.status.restores[*].persistentVolumeClaim}'
```

同一 `status.restores[]` 数组为每个恢复的卷携带一个条目，因此多磁盘虚拟机在其各自的索引下显示每个 PVC 引用。将此状态字段作为后续操作的唯一真实来源——挂载、备份或附加到新虚拟机——而不是从源虚拟机或 DataVolume 名称手动构造 PVC 名称。

对于需要提前获得可预测 PVC 名称而不是事后查找的工作流，虚拟机恢复 `spec` 接受一个 `volumeRestoreOverrides` 数组——每个条目将 `restoreName` 固定为匹配源 `volumeName` 的所选 PVC 名称，并附带结果 PVC 的可选 `labels` 和 `annotations`。在恢复创建时声明覆盖意味着 `status.restores[].persistentVolumeClaim` 报告操作员选择的名称，而不是控制器生成的默认名称，这使得下游自动化可以通过稳定的标识符引用 PVC：

```yaml
apiVersion: snapshot.kubevirt.io/v1beta1
kind: VirtualMachineRestore
spec:
  target:
    apiGroup: kubevirt.io
    kind: VirtualMachine
    name: <vm-name>
  virtualMachineSnapshotName: <snapshot-name>
  volumeRestoreOverrides:
  - volumeName: <source-volume-name>
    restoreName: <desired-pvc-name>
```

## 诊断步骤

在排查任何恢复的 PVC 发现流程之前，确认提供恢复控制器的插件和 CRD 组/版本。在 `installer-v4.3.0-online` 上，`kubevirt-operator` 套件在 `kubevirt` 命名空间中安装了 `kubevirt.io/v1` 虚拟机 CRD 和 `snapshot.kubevirt.io/v1beta1` 虚拟机恢复 CRD；在依赖恢复状态以显示 PVC 名称之前，验证这两个 CRD 是否存在且已建立：

```bash
kubectl get crd virtualmachines.kubevirt.io \
 virtualmachinerestores.snapshot.kubevirt.io \
 -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.versions[*].name}{"\n"}{end}'
```

如果缺少虚拟机恢复 CRD，则快照/恢复路径未安装，直到启用提供这些 CRD 的套件，才能通过 `status.restores[].persistentVolumeClaim` 进行 PVC 发现。
