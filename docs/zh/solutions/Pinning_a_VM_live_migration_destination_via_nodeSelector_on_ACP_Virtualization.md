---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500407
sourceSHA: 1957b4bd0eaa0cf215092c2cdd8c703cb88ec6564f958e2c749615fb34ac6d7b
---

# 通过 nodeSelector 钉住 ACP 虚拟化的 VM 实时迁移目标

## 问题

在安装了 `kubevirt-operator` 包的 Alauda 容器平台上（CSV `kubevirt-hyperconverged-operator.v4.3.5`，KubeVirt `v1.7.0-alauda.2`，HCO operator `1.17.0`，在 `kubevirt` 命名空间中的 HyperConverged 单例），虚拟化管理员有时需要将特定的 `VirtualMachineInstance` 实时迁移到选定的目标节点——用于撤离演练、硬件亲和性验证或绕过噪声邻居——而不是让调度器选择任何合格的节点。`VirtualMachine` CRD (`kubevirt.io/v1`) 包含一个类型为 `map[string]string` 的 `.spec.template.spec.nodeSelector` 字段，其文档角色是“必须匹配节点标签的选择器，以便 VMI 能够在该节点上调度”，同样的 `nodeSelector` 字段出现在 virt-controller 从模板生成的投影 `VirtualMachineInstance` 形状上。

## 根本原因

`VirtualMachineInstanceMigration` (`kubevirt.io/v1`) 触发命名 VMI 的实时迁移；引导迁移目标 virt-launcher pod 的一种支持路径是让标准 Kubernetes 调度器根据 VMI 自身的调度约束进行决策。VMI 从父 `VirtualMachine` 的 `.spec.template.spec.nodeSelector` 继承 `.spec.nodeSelector`，因此迁移目标允许落在的节点集恰好是该映射所选择的节点集。将映射缩小到仅由一个节点匹配的标签，因此将迁移的候选集缩小到该节点。（在问题部分提到的 KubeVirt v1.7.0-alauda.2 构建中，`VirtualMachineInstanceMigration` CRD 还暴露了一个一流的 `spec.addedNodeSelector` 映射，作为对迁移对象本身的外科替代限制器；下面的配方保持在模板侧的 `nodeSelector` 路径，因为这是本文其余部分所依赖的字段。）

## 解决方案

支持的步骤是：编辑父 `VirtualMachine`，添加一个仅与预期目标节点匹配的 `nodeSelector`，创建一个 `VirtualMachineInstanceMigration` 以触发迁移，然后再次编辑 `VirtualMachine`，在 VMI 报告落在新节点上后移除 `nodeSelector`。第一次编辑缩小了候选集，以便迁移目标 pod 只能调度到选定的节点；最后的未编辑恢复了后续迁移或重启的集群范围调度。

标记目标节点（如果已有合适的标签则跳过）：

```bash
kubectl label node <destination-node-name> migration-target=true --overwrite
```

修补 `VirtualMachine` 以添加与该标签匹配的 `nodeSelector`。字段路径为 `.spec.template.spec.nodeSelector`；将选择器放置在这里会导致投影的 VMI 带有相同的约束，KubeVirt 驱动的调度路径在选择 virt-launcher pod 的主机时会遵循该约束：

```bash
kubectl patch vm <vm-name> -n <vm-namespace> --type merge -p \
  '{"spec":{"template":{"spec":{"nodeSelector":{"migration-target":"true"}}}}}'
```

通过创建一个引用 VMI 的 `VirtualMachineInstanceMigration` 来触发迁移：

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstanceMigration
metadata:
  name: pin-to-target
  namespace: <vm-namespace>
spec:
  vmiName: <vm-name>
```

在 VMI 报告新的节点在 `.status.nodeName` 后，从 `VirtualMachine` 中移除 `nodeSelector`，以便 VM 在未来的迁移或重启中可以自由调度到集群范围内。如果没有这最后一步，约束将持续存在，后续的迁移或重启事件仍将被引导到标记的节点：

```bash
kubectl patch vm <vm-name> -n <vm-namespace> --type json -p \
  '[{"op":"remove","path":"/spec/template/spec/nodeSelector"}]'
```

## 诊断步骤

在创建迁移对象之前，确认投影的 VMI 带有预期的 `nodeSelector`——运行中的 VMI 上的字段是迁移目标 pod 调度过滤的依据，而不是 VM 模板直接：

```bash
kubectl get vmi <vm-name> -n <vm-namespace> -o jsonpath='{.spec.nodeSelector}'
```

跟踪迁移进度，并在 VMI 移动后确认新主机：

```bash
kubectl get vmim -n <vm-namespace> pin-to-target -o jsonpath='{.status.phase}'
kubectl get vmi <vm-name> -n <vm-namespace> -o jsonpath='{.status.nodeName}'
```

在移除 `nodeSelector` 后，重新读取 `VirtualMachine` 上的 `.spec.template.spec.nodeSelector` 和 `VirtualMachineInstance` 上的 `.spec.nodeSelector`；两者应为空或不存在，表明 VM 已恢复到下一次迁移或重启的无约束调度：

```bash
kubectl get vm <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.template.spec.nodeSelector}'
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.nodeSelector}'
```
