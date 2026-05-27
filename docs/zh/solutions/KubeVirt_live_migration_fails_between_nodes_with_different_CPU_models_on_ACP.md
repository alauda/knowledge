---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500244
sourceSHA: 7a212fd03de7dea38ce1b9f400dcaa57f127f4a00e6f0ebf3b1b950fd5fdf597
---

# KubeVirt 在不同 CPU 模型的节点之间的实时迁移失败

## 问题

在 Alauda 容器平台的 KubeVirt 虚拟化中（插件 `kubevirt-hyperconverged-operator.v4.3.5`，KubeVirt `v1.7.0-alauda.1`，HCO 安装在 `kubevirt` 命名空间），一个节点具有不同物理 CPU 类型的集群无法可靠地在任意节点之间实时迁移每个虚拟机。一个 `spec.template.spec.domain.cpu.model` 保持为 `host-model` 默认值的虚拟机将采用其调度到的节点的确切 CPU 模型，因此只能迁移到同样支持该模型的节点。当节点之间没有共享的模型时，固定在仅存在于一个节点上的模型的虚拟机没有兼容的迁移目标。

## 根本原因

KubeVirt 节点标签记录每个节点原生支持的 CPU 模型，以便进行虚拟机调度，使用 `cpu-model.node.kubevirt.io/<model>` 标签。它还单独记录一个节点可以接受作为实时迁移目标的 CPU 模型，使用 `cpu-model-migration.node.kubevirt.io/<model>` 标签。在异构集群中，这些标签系列在每个节点上并不宣传相同的模型——调度标签集在节点之间有所不同，反映了不同的物理 CPU。

节点上的迁移标签集是该节点调度标签集的严格超集，并且可以与之不同。因此，一个节点可以在 `cpu-model-migration.node.kubevirt.io/<model>` 下宣传一个模型（它可以作为迁移目标托管该模型），而在 `cpu-model.node.kubevirt.io/<model>` 下不宣传相同的模型（它不会将新的虚拟机调度到该模型上）。由于 `host-model` 虚拟机固定在其调度节点的确切模型上，因此固定模型与每个节点标签集的差异组合使得虚拟机没有可用的迁移目标。

## 解决方案

设置一个集群范围内的默认 CPU 模型，该模型在所有节点中都是通用的，选择每个节点调度标签中存在的最新 CPU 模型。`HyperConverged` CR (`hco.kubevirt.io/v1beta1`) 暴露 `spec.defaultCPUModel`，默认情况下为空；当未设置且虚拟机未设置其 CPU 模型时，虚拟机将回退到 `host-model` 并固定在其调度节点上。将 `defaultCPUModel` 设置为每个节点都宣传的调度模型为所有虚拟机提供了一个可迁移的模型，以便它们可以跨异构节点迁移。

将该值应用于 `kubevirt` 命名空间中的单例 `HyperConverged` CR：

```bash
kubectl patch hyperconverged -n kubevirt kubevirt-hyperconverged \
  --type merge \
  -p '{"spec":{"defaultCPUModel":"<model-common-to-all-nodes>"}}'
```

仔细选择模型：仅在 `cpu-model-migration.node.kubevirt.io` 标签中出现但在任何 `cpu-model.node.kubevirt.io` 调度标签中未出现的模型没有调度标签供调度器匹配，因此将其设置为 `defaultCPUModel` 可能会导致虚拟机无法启动或调度。将所选值限制为在每个节点的调度标签集中存在的模型。

## 诊断步骤

通过读取节点上的 `cpu-model.node.kubevirt.io` 标签，列举每个节点宣传的调度 CPU 模型；`uniq -c` 的前导计数是宣传该模型的节点数量，计数低于总节点数量的模型在所有节点中并不通用：

```bash
kubectl get nodes -l kubernetes.io/os=linux -o yaml \
  | grep 'cpu-model.node.kubevirt.io' \
  | sort | uniq -c
```

为了选择一个安全的 `defaultCPUModel`，比较同一节点上的调度标签与迁移标签。仅在 `cpu-model-migration.node.kubevirt.io` 下出现的模型是仅用于迁移目标的模型，不能被选为默认值：

```bash
kubectl get node <node> -o yaml \
  | grep -E 'cpu-model(-migration)?\.node\.kubevirt\.io' \
  | sort
```

在每个节点的 `cpu-model.node.kubevirt.io` 下存在的模型是有效的通用调度模型，是 `defaultCPUModel` 的安全候选。
