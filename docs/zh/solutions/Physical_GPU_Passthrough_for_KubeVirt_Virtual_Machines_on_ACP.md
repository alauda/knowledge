---
kind:
  - Solution
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x
id: KB260600120
sourceSHA: 766a73167a68dce7d5da8ff61555236e549c0e9d7c4985ee07f37695246482ae
---

# ACP 上 KubeVirt 虚拟机的物理 GPU 直通

## 概述

物理 GPU 直通将真实的图形处理单元（GPU）直接分配给虚拟机（VM）。虚拟机可以在没有虚拟化图形适配器的情况下访问物理 GPU，从而实现接近裸金属的图形和计算性能。

在 Alauda 容器平台（ACP）上，通过以 **sandbox / `vm-passthrough`** 模式安装 **NVIDIA GPU Operator** 集群插件来启用直通。在此模式下，operator 运行 `kubevirt-gpu-device-plugin` 和 `vfio-manager`，将符合条件的 NVIDIA GPU 绑定到 `vfio-pci` 驱动程序，并将其作为可分配的 `nvidia.com/<device>` 资源进行广告。KubeVirt 然后通过 `permittedHostDevices` 将这些资源暴露给虚拟机。

本文档描述了如何在 ACP 上准备物理 GPU 直通环境。

> **版本说明：** 使用为您的 ACP 版本提供的 NVIDIA GPU Operator 插件包。

## 约束和限制

- 主机必须支持并在固件和内核中启用 **IOMMU/VT-d**。
- 每个虚拟机可以通过控制台分配 **一个物理 GPU**（物理 GPU 是 Alpha 功能）。
- GPU 必须没有主机 NVIDIA 驱动程序，以便可以绑定到 `vfio-pci`。

## 先决条件

- 已安装 ACP，并且目标集群由 ACP 管理。
- 在目标集群上启用 KubeVirt 虚拟化（`kubevirt` 命名空间中存在 `kubevirt-hyperconverged` HyperConverged）。
- 至少有一个配备支持的 NVIDIA GPU 的工作节点。

### 启用 IOMMU

启用 IOMMU 的操作步骤因操作系统而异；请参考您的操作系统文档。以下示例使用 CentOS。在 GPU 节点的终端中运行所有命令。

1. 编辑 `/etc/default/grub` 并将 `intel_iommu=on iommu=pt` 添加到 `GRUB_CMDLINE_LINUX`：

   ```bash
   GRUB_CMDLINE_LINUX="crashkernel=auto rd.lvm.lv=centos/root rhgb quiet intel_iommu=on iommu=pt"
   ```

2. 重新生成 `grub.cfg`：

   ```bash
   grub2-mkconfig -o /boot/grub2/grub.cfg
   ```

3. 重启服务器。

4. 确认 IOMMU 已启用。输出应包含 `IOMMU enabled`：

   ```bash
   dmesg | grep -i iommu
   ```

### 卸载 NVIDIA 驱动程序

直通要求 GPU 使用 `vfio-pci`。如果在 GPU 节点上已经安装了主机 NVIDIA 驱动程序，请先卸载它。

## 安装 GPU Operator 集群插件

### 先决条件

1. 获取与平台匹配的 NVIDIA GPU Operator 插件安装包，并确保其镜像在集群的镜像库中可用。
2. 使用平台的应用发布功能将 NVIDIA GPU Operator 插件发布到目标集群。

### 操作步骤

1. 在左侧导航栏中，转到 **Marketplace** > **Cluster Plugins**。
2. 选择目标集群。
3. 点击 **NVIDIA GPU Operator** 插件旁边的操作按钮 > **Install**。

插件默认以 `vm-passthrough` 沙箱模式安装。平台会自动渲染集群特定的值（例如镜像注册表地址），因此无需额外配置。

### 验证安装

1. 确认 operator 及其沙箱操作数正在运行。`ClusterPolicy` 应报告 `ready`：

   ```bash
   kubectl get clusterpolicy
   # NAME             STATUS   AGE
   # cluster-policy   ready    1m

   kubectl get pods -A | grep -E 'gpu-operator|nvidia-(vfio-manager|sandbox)'
   ```

   在支持 GPU 的节点上，`nvidia-vfio-manager`、`nvidia-sandbox-device-plugin-daemonset` 和 `nvidia-sandbox-validator` pods 应处于 `Running` 状态。

   > 如果 `ClusterPolicy` 报告 `NoGPUNodes`，则尚未检测到 GPU 节点。节点特征发现会在检测到 NVIDIA PCI 设备（供应商 `10de`）后自动标记 GPU 节点；然后沙箱操作数会调度到这些节点上。

2. 确定 GPU 节点：

   ```bash
   kubectl get nodes -o wide
   ```

3. 验证 GPU 节点是否广告支持直通的 GPU。输出类似于 `nvidia.com/GK210GL_TESLA_K80` 表示可用的直通 GPU：

   ```bash
   # 将 <gpu-node-name> 替换为上一步中的节点
   kubectl get node <gpu-node-name> -o json | jq '.status.allocatable | with_entries(select(.key | startswith("nvidia.com/"))) | with_entries(select(.value != "0"))'
   ```

   示例输出：

   ```json
   {
       "nvidia.com/GK210GL_TESLA_K80": "8"
   }
   ```

## 配置 KubeVirt

1. 启用 `disableMDevConfiguration` 功能开关。它禁用 KubeVirt 的中介设备（mdev / vGPU）管理，这是 `vfio-pci` 直通所必需的。

   > **警告：** `disableMDevConfiguration` 是一个全局 HCO 功能开关。如果集群已经提供中介设备或 NVIDIA vGPU，启用它会干扰该配置。请先确认没有中介设备在使用：

   ```bash
   kubectl get hco kubevirt-hyperconverged -n kubevirt \
     -o jsonpath='{.spec.mediatedDevicesConfiguration}{"\n"}{.spec.permittedHostDevices.mediatedDevices}{"\n"}'
   ```

   然后启用功能开关：

   ```bash
   kubectl patch hco kubevirt-hyperconverged -n kubevirt --type='json' \
     -p='[{"op": "add", "path": "/spec/featureGates/disableMDevConfiguration", "value": true }]'
   ```

2. 在 GPU 节点上，获取 `pciDeviceSelector`。在以下输出中，`10de:102d` 是选择器值：

   ```bash
   lspci -nn | grep -i nvidia
   # 04:00.0 3D controller [0302]: NVIDIA Corporation GK210GL [Tesla K80] [10de:102d] (rev a1)
   ```

3. 从 GPU 节点的可分配资源中获取 `resourceName`（例如 `nvidia.com/GK210GL_TESLA_K80`）：

   ```bash
   # 将 <gpu-node-name> 替换为 GPU 节点名称
   kubectl get node <gpu-node-name> -o json | jq '.status.allocatable | with_entries(select(.key | startswith("nvidia.com/"))) | with_entries(select(.value != "0"))'
   ```

4. 将直通 GPU 注册为 `pciHostDevices` 条目。为了避免覆盖可能已经配置的 USB 主机设备、中介设备或其他 PCI 设备，首先检查当前值：

   ```bash
   kubectl get hco kubevirt-hyperconverged -n kubevirt -o jsonpath='{.spec.permittedHostDevices}{"\n"}'
   ```

   > **注意：** 将 `pciDeviceSelector` 中的所有字母转换为 **大写**。例如，`10de:102d` 变为 `10DE:102D`。

   - 如果 `permittedHostDevices` **尚未配置**（上面的输出为空），则用 GPU 条目初始化它：

     ```bash
     export DEVICE=<pci-devices-id>      # 例如 10DE:102D
     export RESOURCE=<resource-name>     # 例如 nvidia.com/GK210GL_TESLA_K80

     kubectl patch hco kubevirt-hyperconverged -n kubevirt --type='json' -p='
     [
       {
         "op": "add",
         "path": "/spec/permittedHostDevices",
         "value": {
           "pciHostDevices": [
             {
               "externalResourceProvider": true,
               "pciDeviceSelector": "'"$DEVICE"'",
               "resourceName": "'"$RESOURCE"'"
             }
           ]
         }
       }
     ]'
     ```

   - 如果 `permittedHostDevices.pciHostDevices` **已经存在**，则在不触及现有设备的情况下附加 GPU 条目。`-` 标记将附加到数组的末尾，因此无需计算索引：

     ```bash
     export DEVICE=<pci-devices-id>
     export RESOURCE=<resource-name>

     kubectl patch hco kubevirt-hyperconverged -n kubevirt --type='json' -p='
     [
       {
         "op": "add",
         "path": "/spec/permittedHostDevices/pciHostDevices/-",
         "value": {
           "externalResourceProvider": true,
           "pciDeviceSelector": "'"$DEVICE"'",
           "resourceName": "'"$RESOURCE"'"
         }
       }
     ]'
     ```

     如果 `permittedHostDevices` 存在但尚未具有 `pciHostDevices` 数组，则上述附加操作会失败，因为路径不存在。首先创建空数组，然后运行附加操作：

     ```bash
     kubectl patch hco kubevirt-hyperconverged -n kubevirt --type='json' \
       -p='[{"op": "add", "path": "/spec/permittedHostDevices/pciHostDevices", "value": []}]'
     ```

## 创建带有直通 GPU 的虚拟机

在上述配置完成后，可以在创建虚拟机时选择物理 GPU。

1. 转到 **Container Platform**。
2. 在左侧导航栏中，单击 **Virtualization** > **Virtual Machines**。
3. 单击 **Create Virtual Machine**。
4. 配置 **Physical GPU (Alpha)** 参数：

   | 参数                     | 描述                                                                                   |
   | ------------------------ | -------------------------------------------------------------------------------------- |
   | **Physical GPU (Alpha)** | 选择配置的物理 GPU 型号。每个虚拟机只能分配一个物理 GPU。                             |

如果在创建虚拟机时可以选择配置的 GPU 型号，则直通环境已准备就绪。

## 相关操作

### 从 KubeVirt 中移除 GPU 配置

> **警告：** 如果集群还提供其他主机设备（USB 主机设备、中介设备或其他 PCI 设备），请勿移除整个 `/spec/permittedHostDevices` 对象 — 这将同时删除它们。仅移除 GPU 的 `pciHostDevices` 条目。

1. 列出当前的 `pciHostDevices` 以找到 GPU 条目的零基索引：

   ```bash
   kubectl get hco kubevirt-hyperconverged -n kubevirt -o jsonpath='{.spec.permittedHostDevices.pciHostDevices}{"\n"}'
   ```

2. 按索引移除 GPU 条目（替换 `<index>`）：

   ```bash
   export INDEX=<index>

   kubectl patch hco kubevirt-hyperconverged -n kubevirt --type='json' \
     -p='[{"op": "remove", "path": "/spec/permittedHostDevices/pciHostDevices/'"${INDEX}"'"}]'
   ```

移除后，创建虚拟机时将无法再选择该 GPU 型号。

### 卸载 GPU Operator 集群插件

1. 在左侧导航栏中，转到 **Marketplace** > **Cluster Plugins**。
2. 选择目标集群。
3. 点击 **NVIDIA GPU Operator** 插件旁边的操作按钮 > **Uninstall**。
