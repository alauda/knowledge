---
kind:
   - Solution
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.3.x
id: KB260600120
---

# Physical GPU Passthrough for KubeVirt Virtual Machines on ACP

## Overview

Physical GPU passthrough assigns a real Graphics Processing Unit (GPU) directly to a virtual machine (VM). The VM accesses the physical GPU without a virtualized graphics adapter, achieving graphics and compute performance close to bare metal.

On Alauda Container Platform (ACP), passthrough is enabled by installing the **NVIDIA GPU Operator** cluster plugin in **sandbox / `vm-passthrough`** mode. In this mode the operator runs the `kubevirt-gpu-device-plugin` and `vfio-manager`, which bind eligible NVIDIA GPUs to the `vfio-pci` driver and advertise them as allocatable `nvidia.com/<device>` resources. KubeVirt then exposes those resources to VMs through `permittedHostDevices`.

This document describes how to prepare the physical GPU passthrough environment on ACP.

> **Version note:** Use the NVIDIA GPU Operator plugin package provided for your ACP release.

## Constraints and Limitations

- The host must support and have **IOMMU/VT-d** enabled in firmware and kernel.
- Each VM can be assigned **one physical GPU** through the console (Physical GPU is an Alpha feature).
- The GPU must be free of a host NVIDIA driver so it can be bound to `vfio-pci`.

## Prerequisites

- ACP installed, and the target cluster managed by ACP.
- KubeVirt virtualization enabled on the target cluster (the `kubevirt-hyperconverged` HyperConverged exists in the `kubevirt` namespace).
- At least one worker node equipped with a supported NVIDIA GPU.

### Enabling IOMMU

The procedure to enable IOMMU varies by operating system; refer to your OS documentation. The example below uses CentOS. Run all commands in a terminal on the GPU node.

1. Edit `/etc/default/grub` and add `intel_iommu=on iommu=pt` to `GRUB_CMDLINE_LINUX`:

   ```bash
   GRUB_CMDLINE_LINUX="crashkernel=auto rd.lvm.lv=centos/root rhgb quiet intel_iommu=on iommu=pt"
   ```

2. Regenerate `grub.cfg`:

   ```bash
   grub2-mkconfig -o /boot/grub2/grub.cfg
   ```

3. Restart the server.

4. Confirm IOMMU is enabled. The output should contain `IOMMU enabled`:

   ```bash
   dmesg | grep -i iommu
   ```

### Uninstall the NVIDIA Driver

Passthrough requires the GPU to use `vfio-pci`. If a host NVIDIA driver is already installed on the GPU node, uninstall it first.

## Install the GPU Operator Cluster Plugin

### Prerequisites

1. Obtain the NVIDIA GPU Operator plugin installation package that matches the platform, and ensure its images are available in the cluster's image repository.
2. Use the platform's application publishing capability to publish the NVIDIA GPU Operator plugin to the target cluster.

### Procedure

1. In the left navigation bar, go to **Marketplace** > **Cluster Plugins**.
2. Select the target cluster.
3. Click the action button next to the **NVIDIA GPU Operator** plugin > **Install**.

The plugin installs in `vm-passthrough` sandbox mode by default. The platform automatically renders cluster-specific values (such as the image registry address), so no extra configuration is required.

### Verify the Installation

1. Confirm the operator and its sandbox operands are running. The `ClusterPolicy` should report `ready`:

   ```bash
   kubectl get clusterpolicy
   # NAME             STATUS   AGE
   # cluster-policy   ready    1m

   kubectl get pods -A | grep -E 'gpu-operator|nvidia-(vfio-manager|sandbox)'
   ```

   On a node with a supported GPU, the `nvidia-vfio-manager`, `nvidia-sandbox-device-plugin-daemonset`, and `nvidia-sandbox-validator` pods become `Running`.

   > If `ClusterPolicy` reports `NoGPUNodes`, no GPU node has been detected yet. Node Feature Discovery labels GPU nodes automatically once it detects an NVIDIA PCI device (vendor `10de`); the sandbox operands are then scheduled onto those nodes.

2. Identify the GPU node:

   ```bash
   kubectl get nodes -o wide
   ```

3. Verify the GPU node advertises a passthrough-capable GPU. Output similar to `nvidia.com/GK210GL_TESLA_K80` indicates passthrough-capable GPUs are available:

   ```bash
   # Replace <gpu-node-name> with the node from the previous step
   kubectl get node <gpu-node-name> -o json | jq '.status.allocatable | with_entries(select(.key | startswith("nvidia.com/"))) | with_entries(select(.value != "0"))'
   ```

   Example output:

   ```json
   {
       "nvidia.com/GK210GL_TESLA_K80": "8"
   }
   ```

## Configure KubeVirt

1. Enable the `disableMDevConfiguration` feature gate. It disables KubeVirt's mediated-device (mdev / vGPU) management, which is required for `vfio-pci` passthrough.

   > **Warning:** `disableMDevConfiguration` is a global HCO feature gate. If the cluster already serves mediated devices or NVIDIA vGPU, enabling it disrupts that configuration. Verify first that no mediated devices are in use:

   ```bash
   kubectl get hco kubevirt-hyperconverged -n kubevirt \
     -o jsonpath='{.spec.mediatedDevicesConfiguration}{"\n"}{.spec.permittedHostDevices.mediatedDevices}{"\n"}'
   ```

   Then enable the feature gate:

   ```bash
   kubectl patch hco kubevirt-hyperconverged -n kubevirt --type='json' \
     -p='[{"op": "add", "path": "/spec/featureGates/disableMDevConfiguration", "value": true }]'
   ```

2. On the GPU node, obtain the `pciDeviceSelector`. In the output below, `10de:102d` is the selector value:

   ```bash
   lspci -nn | grep -i nvidia
   # 04:00.0 3D controller [0302]: NVIDIA Corporation GK210GL [Tesla K80] [10de:102d] (rev a1)
   ```

3. Obtain the `resourceName` from the GPU node's allocatable resources (for example `nvidia.com/GK210GL_TESLA_K80`):

   ```bash
   # Replace <gpu-node-name> with the GPU node name
   kubectl get node <gpu-node-name> -o json | jq '.status.allocatable | with_entries(select(.key | startswith("nvidia.com/"))) | with_entries(select(.value != "0"))'
   ```

4. Register the passthrough GPU as a `pciHostDevices` entry. To avoid overwriting USB host devices, mediated devices, or other PCI devices that may already be configured, first inspect the current value:

   ```bash
   kubectl get hco kubevirt-hyperconverged -n kubevirt -o jsonpath='{.spec.permittedHostDevices}{"\n"}'
   ```

   > **Note:** Convert all letters in the `pciDeviceSelector` to **uppercase**. For example, `10de:102d` becomes `10DE:102D`.

   - If `permittedHostDevices` is **not yet configured** (empty output above), initialize it with the GPU entry:

     ```bash
     export DEVICE=<pci-devices-id>      # e.g. 10DE:102D
     export RESOURCE=<resource-name>     # e.g. nvidia.com/GK210GL_TESLA_K80

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

   - If `permittedHostDevices.pciHostDevices` **already exists**, append the GPU entry without touching the existing devices. The `-` token appends to the end of the array, so no index calculation is needed:

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

     If `permittedHostDevices` exists but has no `pciHostDevices` array yet, the append above fails because the path does not exist. Create the empty array first, then run the append:

     ```bash
     kubectl patch hco kubevirt-hyperconverged -n kubevirt --type='json' \
       -p='[{"op": "add", "path": "/spec/permittedHostDevices/pciHostDevices", "value": []}]'
     ```

## Create a Virtual Machine with a Passthrough GPU

After the configuration above, the physical GPU can be selected when creating a VM.

1. Go to **Container Platform**.
2. In the left navigation bar, click **Virtualization** > **Virtual Machines**.
3. Click **Create Virtual Machine**.
4. Configure the **Physical GPU (Alpha)** parameter:

   | Parameter            | Description |
   | -------------------- | ----------- |
   | **Physical GPU (Alpha)** | Select the configured physical GPU model. Only one physical GPU can be assigned per VM. |

If the configured GPU model can be selected during VM creation, the passthrough environment is ready.

## Related Operations

### Remove GPU Configuration from KubeVirt

> **Warning:** Do not remove the entire `/spec/permittedHostDevices` object if the cluster also serves other host devices (USB host devices, mediated devices, or other PCI devices) — that would delete them as well. Remove only the GPU's `pciHostDevices` entry.

1. List the current `pciHostDevices` to find the zero-based index of the GPU entry:

   ```bash
   kubectl get hco kubevirt-hyperconverged -n kubevirt -o jsonpath='{.spec.permittedHostDevices.pciHostDevices}{"\n"}'
   ```

2. Remove the GPU entry by its index (replace `<index>`):

   ```bash
   export INDEX=<index>

   kubectl patch hco kubevirt-hyperconverged -n kubevirt --type='json' \
     -p='[{"op": "remove", "path": "/spec/permittedHostDevices/pciHostDevices/'"${INDEX}"'"}]'
   ```

After removal, the GPU model can no longer be selected when creating a VM.

### Uninstall the GPU Operator Cluster Plugin

1. In the left navigation bar, go to **Marketplace** > **Cluster Plugins**.
2. Select the target cluster.
3. Click the action button next to the **NVIDIA GPU Operator** plugin > **Uninstall**.
