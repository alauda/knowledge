---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500637
sourceSHA: 5d764101b2772c0a1697f964cbeacb3e12dca71e398a044cecfeac1288f8ffba
---

# 在 ACP 虚拟化更新后刷新 KubeVirt 虚拟机上的 virt-launcher 绑定设备定义

## 问题

在 Alauda Container Platform 上，虚拟化是通过安装在 `kubevirt` 命名空间中的上游 KubeVirt 发行版提供的，该发行版通过 OperatorBundle `kubevirt-hyperconverged-operator.v4.3.5` 安装；集群运行 HyperConverged 自定义资源和一个部署的 `KubeVirt` 自定义资源，该资源拥有 `virt-controller` / `virt-api` / `virt-handler` / `virt-launcher` 工作负载。在此环境中观察到的 KubeVirt 构建为 `v1.7.0-alauda.2`，并且 `virt-controller` 部署以 `--launcher-image` 参数启动，该参数固定为单个 virt-launcher 镜像标签 (`3rdparty/kubevirt/virt-launcher:v1.7.0-alauda.2`)；在该部署处于当前状态时启动的每个新 VirtualMachineInstance 都会从该确切的镜像标签生成一个 virt-launcher pod。

一个带有 `hooks.kubevirt.io/hookSidecars` 注释的 VirtualMachine 依赖于 virt-launcher 容器内的 libvirtd 来选择一个 virtio 系列显示设备；设备选择绑定到创建 VirtualMachineInstance 时 virt-launcher 容器镜像的内容。由于用于运行的 VirtualMachineInstance 的镜像在 VMI 创建时是固定的，因此已经运行的 VMI 继续使用在早期时间生成的设备定义，即使集群的 virt-controller 现在配置为从不同的 virt-launcher 镜像标签启动新的 VMI。

## 根本原因

libvirtd 解析的显示设备打包位于 virt-launcher 容器镜像内；给定 VirtualMachineInstance 的配置设备遵循在创建该 VMI 时当前的 virt-launcher 镜像。由于 virt-controller 是使用单个 `--launcher-image` 参数启动的，所有新的 VMI 都会继承该参数，因此设备定义的真实来源在该参数更新为不同标签时发生变化——但仅适用于从那时起创建的 VMI。

该集群上的 KubeVirt 实时迁移已启用——`KubeVirt` 资源携带一个活动的 `spec.configuration.migrations` 块（`parallelMigrationsPerCluster: 5`，`completionTimeoutPerGiB: 150`），并且在配置的功能门列表中存在 `VideoConfig` 功能门，因此 virtio 视频设备选择在当前构建的范围内。KubeVirt 实时迁移将设备状态从源 virt-launcher pod 流式传输到目标 virt-launcher pod，目标 pod 必须实例化相同类型的 PCI 设备，以便传入状态能够映射到匹配的硬件。当源 virt-launcher pod 是从早期的 virt-launcher 镜像创建时，而新的目标 virt-launcher pod 是从当前配置的镜像启动时，这两个 pod 可能携带不同的显示设备打包，导致目标无法干净地加载流式传输的状态。

## 解决方案

冷重启受影响的 VirtualMachines（停止，然后启动）会从 virt-controller 当前配置使用的 virt-launcher 镜像重新创建 VirtualMachineInstance——在该集群的当前状态下为 `--launcher-image: registry.alauda.cn:60080/3rdparty/kubevirt/virt-launcher:v1.7.0-alauda.2`——因此新 VMI 的设备定义是针对当前提供的 virt-launcher 内容生成的。

冷重启后，任何后续实时迁移的源和目标 virt-launcher pods 都是从相同的 `--launcher-image` 标签生成的，这保持了迁移端点之间的设备打包一致性。

```bash
# 检查控制器当前使用的 virt-launcher 镜像标签
kubectl -n kubevirt get deploy virt-controller \
  -o jsonpath='{.spec.template.spec.containers[*].args}'

# 停止并启动受影响的 VM 以从当前镜像重新生成其 VMI
kubectl -n <vm-namespace> patch virtualmachine <vm-name> \
  --type=merge -p '{"spec":{"runStrategy":"Halted"}}'
kubectl -n <vm-namespace> patch virtualmachine <vm-name> \
  --type=merge -p '{"spec":{"runStrategy":"Always"}}'
```

## 诊断步骤

受影响的 VirtualMachines 是那些携带用于驱动 virtio 显示设备选择的 hook-sidecar 注释的虚拟机。通过选择 `spec.template.metadata.annotations` 中的 `hooks.kubevirt.io/hookSidecars` 键来列出它们。

```bash
# 查找使用 hookSidecars 注释的虚拟机（集群范围内）
kubectl get vm -A -o json | jq -r '
  .items[]
  | select(.spec.template.metadata.annotations
           | has("hooks.kubevirt.io/hookSidecars"))
  | "\(.metadata.namespace)/\(.metadata.name)"'
```

确认当前生效的 KubeVirt 构建和 virt-launcher 镜像标签，以便从此时创建的任何 VMI 匹配该固定标签：

```bash
kubectl -n kubevirt get kubevirt kubevirt-kubevirt-hyperconverged \
  -o jsonpath='{.status.observedKubeVirtVersion}'
kubectl -n kubevirt get deploy virt-controller \
  -o jsonpath='{.spec.template.spec.containers[*].args}'
```

在调度重新生成的 VirtualMachineInstances 的迁移之前，确认实时迁移控制器已配置并且相关功能门已启用：

```bash
kubectl -n kubevirt get kubevirt kubevirt-kubevirt-hyperconverged \
  -o jsonpath='{.spec.configuration.migrations}'
kubectl -n kubevirt get kubevirt kubevirt-kubevirt-hyperconverged \
  -o jsonpath='{.spec.configuration.developerConfiguration.featureGates}'
```
