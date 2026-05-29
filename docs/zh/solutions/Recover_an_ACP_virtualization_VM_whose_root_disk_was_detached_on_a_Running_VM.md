---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500695
sourceSHA: a33919644bb3a53d31be40d65432329d4505e37203b6c5e78def44706acbb815
---

# 恢复根磁盘已从运行中的虚拟机中分离的 ACP 虚拟化 VM

## 问题

在安装了虚拟化组件的 Alauda 容器平台上（命名空间 `kubevirt` 中的 `HyperConverged` 单例 `kubevirt-hyperconverged`，观察到 `KubeVirt` 版本 `v1.7.0-alauda.2`，HCO 操作员 `1.17.0`，以及已部署的 `CDI` 单例 `cdi-kubevirt-hyperconverged`），`VirtualMachine` 上的持久根磁盘被建模为一对：一个类型为 `persistentVolumeClaim` 的 `spec.template.spec.volumes[]` 条目（其所需的 `claimName` 指向启动 PVC）和一个 `spec.template.spec.domain.devices.disks[]` 条目，该条目为该卷提供设备名称和一个整数 `bootOrder`（标记该磁盘可启动的杠杆）。

当对运行中的虚拟机发出删除根磁盘的请求时——无论是通过删除 `disks[]` 条目、删除匹配的 `volumes[]` 条目，还是两者同时——该更改都被拒绝为实时更新。`VirtualMachineInstance` 继续运行，现有的根磁盘保持连接，但 `VirtualMachine` 控制器记录了差异，并在 `.status.conditions[]` 上显示 `RestartRequired` 状态，消息为 `模板规格中更改了非实时可更新字段`。该更改仅在下一个冷重启周期生效；如果在该状态下重启虚拟机，则新的 VMI 启动时没有根磁盘，无法找到可启动设备。

## 根本原因

虚拟机的启动/源磁盘是非实时可更新的。对 `VirtualMachineInstance` 的热插拔连接和断开通过 `subresources.kubevirt.io/v1` 端点 `virtualmachineinstances/addvolume` 和 `virtualmachineinstances/removevolume` 驱动，这些操作通过 `.status.volumeRequests` 修改 VMI，并明确描述为 `在活动运行的 VMI 上热插拔`；这些仅适用于标记为热插拔的卷（`spec.template.spec.volumes[].persistentVolumeClaim.hotpluggable=true`）。持久根磁盘卷——与可启动的 `disks[]` 条目配对的那个——不在该路径上。对定义它的 `disks[]`/`volumes[]` 条目的编辑是模板规格更改，因此 KubeVirt 的 webhook 将其保持为待处理状态，VMI 的 `target`（例如 `vda`）保持镜像原始 PVC，直到停止/启动应用差异。

PVC 本身不受影响。即使根磁盘的 `volumes[]` 条目和拥有的 `dataVolumeTemplates[]` 块都从虚拟机规格中删除，底层 PVC 仍保持在 `STATUS=Bound` 状态——分离并不会删除后端存储，因此数据保持完整并可用于恢复步骤。

## 解决方案

修复方法是将根磁盘引用重新放入虚拟机规格中，并设置 `bootOrder`，然后冷重启虚拟机。KubeVirt 在 `subresources.kubevirt.io/v1` 上公开生命周期子资源（`virtualmachines/start`、`virtualmachines/stop`、`virtualmachines/restart`），因此即使没有 UI 控制，恢复也是一个通用的 `kubectl` 驱动序列。

确认根磁盘的后端 PVC 仍然是 `Bound`（这是使恢复成为可能的前提——同一 PVC 可以在不丢失数据的情况下重新连接）：

```bash
kubectl -n <vm-namespace> get pvc <rootdisk-pvc-name>
```

停止虚拟机，修补虚拟机规格以重新添加根磁盘作为卷和可启动磁盘，然后再次启动虚拟机：

```bash
kubectl -n <vm-namespace> patch vm <vm-name> \
  --type merge \
  -p '{"spec":{"runStrategy":"Halted"}}'
```

```bash
kubectl -n <vm-namespace> patch vm <vm-name> --type=json -p='[
  {"op":"add","path":"/spec/template/spec/domain/devices/disks","value":[
    {"name":"rootdisk","bootOrder":1,"disk":{"bus":"virtio"}}
  ]},
  {"op":"add","path":"/spec/template/spec/volumes","value":[
    {"name":"rootdisk","persistentVolumeClaim":{"claimName":"<rootdisk-pvc-name>"}}
  ]}
]'
```

```bash
kubectl -n <vm-namespace> patch vm <vm-name> \
  --type merge \
  -p '{"spec":{"runStrategy":"Always"}}'
```

如果现有规格已经有 `disks[]` 或 `volumes[]` 数组（例如仍然连接的网络磁盘），请在 `/spec/template/spec/domain/devices/disks/-` 和 `/spec/template/spec/volumes/-` 使用 `add` 来附加根磁盘条目，而不是替换数组。磁盘条目上的 `bootOrder: 1` 是标记该卷为可启动设备的依据；磁盘上的整数 `bootOrder > 0` 优先于没有 `bootOrder` 的磁盘，因此这是恢复所依赖的明确杠杆。

一旦 VMI 在重启后恢复到 `Running` 状态，根磁盘将在新的 VMI 的 `spec.domain.devices.disks` 中再次显示（作为 `virtio`，并带有 `bootOrder: 1`），并且 `VirtualMachine` 上不再存在 `RestartRequired` 状态——待处理的更改已被应用，虚拟机正在从与之前相同的 PVC 启动。

## 诊断步骤

通过读取 `virt-launcher` pod 的 `spec.volumes` 部分来识别根磁盘卷指向的 PVC，该部分反映了挂载到 VMI 的持久卷——根磁盘条目显示为 `{name: rootdisk, persistentVolumeClaim: {claimName: <pvc-name>}}`：

```bash
kubectl -n <vm-namespace> get pod \
  -l kubevirt.io/vm=<vm-name> \
  -o jsonpath='{.items[0].spec.volumes}'
```

确认其背后的 PVC 仍然是 `Bound`——如果根磁盘仅在规格级别上被分离，这仍然成立，数据保持完整以供恢复；如果 PVC 缺失或处于 `Terminating` 状态，则无法重用：

```bash
kubectl -n <vm-namespace> get pvc <rootdisk-pvc-name>
```

读取 `RestartRequired` 状态以验证分离是否确实被视为待处理的非实时可更新更改，而不是其他情况（例如控制器级错误）。`.status.conditions[]` 的 `type` 字段是一个自由字符串，因此过滤是精确的：

```bash
kubectl -n <vm-namespace> get vm <vm-name> \
  -o jsonpath='{.status.conditions[?(@.type=="RestartRequired")]}'
```

当该状态存在时，消息为 `模板规格中更改了非实时可更新字段`，这是明确的信号，表明规格更改已排队等待下次重启，而当前 VMI 仍在之前的模板上运行。交叉检查 VMI 以确认它仍在旧模板上——`spec.domain.devices.disks` 仍列出根磁盘，`status.volumeStatus[].persistentVolumeClaimInfo.claimName` 仍指向启动 PVC：

```bash
kubectl -n <vm-namespace> get vmi <vm-name> \
  -o jsonpath='{.spec.domain.devices.disks}'
kubectl -n <vm-namespace> get vmi <vm-name> \
  -o jsonpath='{.status.volumeStatus}'
```

如果在待处理的分离期间已经触发了重启，则新的 VMI 启动时根磁盘被移除：`spec.domain.devices.disks` 为空，`status.volumeStatus` 为空，libvirt 域没有 `<disk>` 元素——即使启动顺序已设置，qemu 也没有 `-blockdev` 条目，因此客户机无法找到可启动设备。在这种状态下，相同的恢复过程（重新添加根磁盘条目并重启）将虚拟机恢复，因为底层 PVC 仍然是 `Bound`。
