---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500299
sourceSHA: a9a893b7db4b33ee5fc9f11727fcb6defbffaeba30d57e687859a590714ff794
---

# 恢复因每节点 CSI 卷限制而卡住的 KubeVirt 虚拟机

## 问题

在 Alauda 容器平台上使用 KubeVirt（命名空间 `kubevirt`，Kubernetes `v1.34.5`），一个 `virtualmachines.kubevirt.io` 对象可能会报告为 `Starting` 状态，而为其创建的 `virt-launcher-<vm>-<hash>` pod 则保持在 `ContainerCreating` 状态，永远无法达到 `Running`。当支持虚拟机磁盘的 `persistentvolumeclaims` 无法附加到调度该 pod 的节点时，启动 pod 无法完成启动，因为 pod 的磁盘挂载依赖于该卷的附加完成。

## 根本原因

一个 CSI 驱动程序通过 `csinodes.storage.k8s.io` 对象的 `.spec.drivers[].allocatable.count` 字段（一个整数，beta 在 `storage.k8s.io/v1` 中）来宣传每节点最大可附加卷的数量；当该字段被设置时，它限制了驱动程序在单个节点上可以使用的唯一卷的数量，而当该字段未指定时，节点上支持的卷数量是无限制的。ACP 的默认 `topolvm` CSI 驱动程序将 `allocatable.count` 保持未设置，因此它本身并不施加每节点的附加限制；每节点限制是一个通用的 CSI 机制，仅在所使用的 CSI 驱动程序填充该字段时生效。

第二个因素通过存储最终器加剧了卡住的状态。一个标记为删除的 `persistentvolumes`（core/v1）对象可以携带一个 `deletionTimestamp`，同时在其 `metadata.finalizers` 列表中保留 `kubernetes.io/pv-protection` 最终器；该对象在最终器列表为空之前不会从注册表中删除，因此仅有非空的 `deletionTimestamp` 并不会将其移除。每个活动 PV（与 external-provisioner 最终器一起）都存在 `kubernetes.io/pv-protection` 最终器，防止 PV 及其绑定的 PVC 在 pod 仍然引用存储时被垃圾回收。绑定的 `persistentvolumeclaims` 携带相应的 `kubernetes.io/pvc-protection` 最终器，因此删除这样的 PVC 会使其保持在 `Bound` 状态，并设置 `deletionTimestamp`，直到其使用条件被清除。

## 诊断步骤

确认虚拟机处于 `Starting` 状态，并且其启动 pod 卡在 `ContainerCreating` 状态，位于 `kubevirt` 命名空间中：

```bash
kubectl get vm,vmi -A
kubectl get pod -n <vm-namespace> -l kubevirt.io=virt-launcher -o wide
```

检查卡住的 PV，以揭示一个残留的 pv-protection 最终器：`kubectl get pv <name> -o yaml` 显示 PV 的 `deletionTimestamp` 和 `finalizers` 列表，这两者共同表明该对象是否被 `kubernetes.io/pv-protection` 保持打开：

```bash
kubectl get pv <name> -o yaml
kubectl get pv <name> -o jsonpath='{.metadata.deletionTimestamp}{"\n"}{..finalizers}{"\n"}'
```

以相同方式检查绑定的 PVC；一个显示为 `Bound` 并且有 `deletionTimestamp` 的 PVC 正被 `kubernetes.io/pvc-protection` 最终器保持，直到其使用引用被清除：

```bash
kubectl get pvc <name> -n <vm-namespace> -o yaml
```

检查节点的 `csinodes.storage.k8s.io` 对象，以查看所使用的驱动程序是否宣传每节点附加限制；一个空的 `.spec.drivers[].allocatable.count` 意味着该驱动程序对节点没有施加限制：

```bash
kubectl get csinode <node-name> -o jsonpath='{.spec.drivers[*].allocatable.count}{"\n"}'
```

## 解决方案

强制删除无响应的 `virt-launcher-<vm>-<hash>` pod，以释放它所持有的卷锁；`kubectl delete pod --force --grace-period=0` 是一个通用的 core/v1 操作，由于启动 pod 由 virt-controller 所拥有，因此在强制删除后会重新创建它们：

```bash
kubectl delete pod virt-launcher-<vm>-<hash> -n <vm-namespace> --force --grace-period=0
```

一旦节点容量可用，通过克隆或恢复快照来提供一个健康的替代卷，以便虚拟机可以过渡到 `Running` 状态，并且 PVC 正确地处于 `Bound` 状态。ACP 的 KubeVirt 提供了 `virtualmachinesnapshots` 和 `virtualmachinerestores` 原语，以及 CDI `volumeclonesources` 用于此目的：

```yaml
apiVersion: snapshot.kubevirt.io/v1beta1
kind: VirtualMachineRestore
metadata:
  name: <vm>-restore
  namespace: <vm-namespace>
spec:
  target:
    apiGroup: kubevirt.io
    kind: VirtualMachine
    name: <vm>
  virtualMachineSnapshotName: <vm>-snapshot
```

在替代 PVC 达到 `Bound` 状态并且任何持有的最终器被清除后，虚拟机恢复其正常生命周期：重新创建的 `virt-launcher-<vm>-<hash>` pod 附加磁盘并继续从 `ContainerCreating` 过渡到 `Running`。
