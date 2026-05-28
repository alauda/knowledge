---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500361
sourceSHA: f99aba9b1fc7a0ea2cc914bc1a4a4b2b0ecb2c18161801d8fae179e7fbeca5e2
---

# VMRestore 在 VMI 仍存在于 ACP 时失败，提示“目标 VM 未关闭”

## 问题

在安装了 KubeVirt operator bundle 的 Alauda Container Platform 上（镜像 `build-harbor.alauda.cn/3rdparty/kubevirt/virt-controller:v1.7.0-alauda.2`，HCO CSV `kubevirt-hyperconverged-operator.v4.3.5`，命名空间 `kubevirt`），创建的 `VirtualMachineRestore` CR（`snapshot.kubevirt.io/v1beta1`，命名空间）用于从 `VirtualMachineSnapshot` 恢复 VM，可能会停滞并在其 `status.conditions` 上显示 `Progressing=False` 状态，原因/消息文本指出恢复目标在五分钟内未准备好，并要求在尝试恢复之前关闭目标 VM。

`VirtualMachineRestore` CRD 由 KubeVirt operator 安装（标签 `app.kubernetes.io/managed-by=virt-operator`，`app.kubernetes.io/version=1.17.0`，加上注释 `kubevirt.io/install-strategy-version=v1.7.0-alauda.2`）；`v1beta1` 组/版本是存储版本，而 `v1alpha1` 仍然用于兼容性。

## 根本原因

KubeVirt 恢复控制器通过检查集群中是否存在相应的 `VirtualMachineInstance`（VMI）对象来判断目标 VM 是否已关闭，而不是通过读取 API 之外的任何渲染状态字段。只要命名空间中存在目标 VM 的 VMI，恢复前提条件就被视为不满足，调和过程拒绝继续，无论父 `VirtualMachine` 报告的是什么。

在 ACP 上，VM 的权威生命周期状态直接从 API 中读取：父 CR 上的 `VirtualMachine.status.printableStatus`（例如 `Starting` 或 `ImagePullBackOff` 等值原样显示）以及 `VirtualMachineInstance` 命名空间对象的存在与否。VMI 可能在停止请求失败后仍然留在命名空间中——父 `VirtualMachine` 可能已经显示停止意图，而 VMI 对象仍然存在——仅仅是这个残留的 VMI 就足以使恢复控制器处于“目标未关闭”的分支中。

## 解决方案

直接删除残留的 `VirtualMachineInstance`。VMIs 是通过 `kubectl` 可访问的命名空间资源，删除 VMI 会拆除底层的 virt-launcher pod（其生命周期由 VMI 所拥有），这会强制停止 VM 并清除恢复前提条件。

```bash
# 确定目标 VM 的残留 VMI
kubectl get vmi -n <namespace>

# 通过删除 VMI 强制停止；拥有的 virt-launcher pod 随之终止
kubectl delete vmi <vm-name> -n <namespace>
```

在 VMI 被删除后，`VirtualMachineRestore` 控制器对目标 VMI 的存在检查在下次调和时返回为空，恢复前提条件（目标 VM 没有活动的 VMI）得以满足。

## 诊断步骤

读取失败恢复的条件块以确认失败模式——`Progressing=False` 条件与超时/“关闭目标 VM”原因/消息文本是此前提条件检查的标志；同一 `status.conditions` 切片上的其他失败模式将发出不同的原因字符串：

```bash
kubectl get vmrestore -n <namespace> <restore-name> -o yaml
```

通过 API 检查 VM 和 VMI 的真实状态，而不是依赖任何渲染视图。`VirtualMachine.status.printableStatus` 包含权威的生命周期阶段，而同一命名空间中 `VirtualMachineInstance` 对象的存在是恢复控制器实际查询的内容。默认情况下，KubeVirt 将 VMI 命名为与其父 VM 相同，但自定义模板可能会覆盖这一点——首先列出命名空间中的 VMI，并在名称不同的情况下通过拥有者引用进行匹配：

```bash
kubectl get vm -n <namespace> <vm-name> \
  -o jsonpath='{.status.printableStatus}{"\n"}'
kubectl get vmi -n <namespace> \
  -o jsonpath='{range .items[?(@.metadata.ownerReferences[0].name=="<vm-name>")]}{.metadata.name}{"\n"}{end}'
```

如果 VMI 列表返回一个由目标 VM 拥有的对象，而 VM 的可打印状态已经指示停止或过渡状态，则集群处于上述残留 VMI 状态；按照解决方案中所示删除该 VMI 以解除恢复阻塞。
