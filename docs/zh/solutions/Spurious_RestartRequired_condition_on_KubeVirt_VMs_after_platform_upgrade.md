---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500209
sourceSHA: be5c4f1b285a9954e2d82502f078470d69f5144b3959ece20582852e5fe687b2
---

# 平台升级后 KubeVirt 虚拟机出现虚假 RestartRequired 状态

## 问题

在安装了 `kubevirt-operator` 包的 Alauda 容器平台上（ACP v4.3.13，CSV `kubevirt-hyperconverged-operator.v4.3.5`，KubeVirt 镜像 `build-harbor.alauda.cn/3rdparty/kubevirt/virt-controller:v1.7.0-alauda.2`，命名空间为 `kubevirt`），VirtualMachine 资源在 `.status.conditions[]` 中出现 `RestartRequired` 条目，表明已记录对虚拟机模板规格的非实时可更新更改，必须重启来使更改生效。相同的条件形态 — `{type, status, reason, message, lastTransitionTime, lastProbeTime}` — 也会阻止热插拔操作：当虚拟机上设置了 `RestartRequired` 时，virt-controller 会拒绝对该虚拟机的内存和 CPU 热插拔更新，直到条件被清除或虚拟机被重启。

附加在 `RestartRequired` 条件上的用户可见消息包含短语 `a non-live-updatable field was changed in the template spec`，每当 virt-controller 观察到 `.spec.template.spec` 的非实时可更新字段与该虚拟机的最后存储的 ControllerRevision 快照不同，就会发出该消息。管理员在未明确编辑的虚拟机上遇到该条件，这使得触发原因不明显，直到检查当前模板规格与每个虚拟机的 ControllerRevision 之间的差异。

## 根本原因

virt-controller 持久化每个虚拟机的 `ControllerRevision` (`apps/v1`)，其 `.data.spec.template.spec` 反映最后一次协调的虚拟机模板规格；在每次协调时，它将实时虚拟机的 `.spec.template.spec` 与该快照进行比较，如果任何非实时可更新字段发生更改，则在虚拟机上设置 `RestartRequired`，而不是将更改应用于正在运行的 VMI。ACP 上的 VirtualMachine CRD 将 `.spec.template.spec.domain.firmware.uuid` 作为 `string` 在组/版本 `kubevirt.io/v1` 中公开，上游描述该值是 VMI BIOS 报告的 UUID，未设置时默认为随机生成的 UID。该字段值为生成的 VMI 的 libvirt 域 UUID 提供种子，将虚拟机的域身份固定在虚拟机监控器层。

virt-controller 将 `.spec.template.spec.domain.firmware.uuid` 视为非实时可更新字段，因此对其值的任何更改 — 包括从未设置到具体 UUID 的过渡 — 都会触发 `RestartRequired` 条件，而不是实时应用。当平台级协调填充先前缺失的 `uuid` 时，现有虚拟机的新模板规格在该确切字段上与先前存在的 ControllerRevision 不同；virt-controller 看到非实时可更新字段的差异，并将每个受影响的 VirtualMachine 标记为 `RestartRequired`，即使来宾的实际身份没有改变。

## 解决方案

对于每个受影响的 VirtualMachine，通过对虚拟机进行 `status` 子资源合并补丁来清除现有条件。ACP 上的 VirtualMachine CRD 启用了 `status` 子资源（`subresources.status = {}` 在 `spec.versions[v1]` 下），因此该补丁在结构上被接受，并重写 `.status.conditions` 数组而不触及 `.spec`：

```bash
kubectl patch vm <name> -n <namespace> \
 --subresource=status --type=merge \
 -p '{"status":{"conditions":[]}}'
```

已经携带 `RestartRequired` 的虚拟机在后续升级中保留该条件，防止新的注入，因为此类升级停止进一步注入，但不会追溯清除已记录在现有虚拟机上的条件。在升级后对受影响的虚拟机应用上述 `status` 补丁，以便它们不再继续报告虚假的条件；在注入防止构建到位的情况下，virt-controller 不会在这些虚拟机上重新设置 `RestartRequired`，除非随后对模板规格进行了真实的非实时可更新更改。一旦条件被清除，受影响虚拟机上的热插拔操作（内存或 CPU 更新）将被解除阻止，因为热插拔拒绝是基于 `.status.conditions[]` 中存在 `RestartRequired`。

## 诊断步骤

在补丁之前确认虚拟机上是否实际存在 `RestartRequired` 条件，并阅读附加消息以验证其是否提到非实时可更新的模板规格更改：

```bash
kubectl get vm <name> -n <namespace> \
 -o jsonpath='{.status.conditions[?(@.type=="RestartRequired")]}'
```

通过将实时虚拟机模板规格与 virt-controller 为该虚拟机存储的相应 ControllerRevision 快照进行比较，识别出哪个字段发生了更改。将两侧捕获到不同的文件中并运行文本差异；当 `firmware.uuid` 是触发因素时，它在实时规格侧显示为单行添加（之前缺失，现在设置）：

```bash
kubectl get vm <name> -n <namespace> -o yaml \
 | yq '.spec.template.spec' > vm.spec

kubectl get controllerrevision <revision-name> -n <namespace> -o yaml \
 | yq '.data.spec.template.spec' > revision.spec

diff vm.spec revision.spec
```

如果差异突出显示 `.domain.firmware.uuid` 是唯一的差异，则该条件是上述虚假注入模式，**解决方案** 中的 `status` 子资源清除是安全的补救措施；如果差异突出显示其他非实时可更新字段，则将其视为真正的有意更改，确实需要重启虚拟机以使其生效，而不是仅仅清除状态。
