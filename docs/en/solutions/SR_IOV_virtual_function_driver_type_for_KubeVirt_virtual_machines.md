---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# SR-IOV virtual function driver type for KubeVirt virtual machines
## Overview

SR-IOV virtual functions (VFs) on a worker node can be exposed to workloads under two driver bindings: `netdevice`, which keeps the VF inside the host kernel network stack, and `vfio-pci`, which detaches the VF from the host kernel and binds it to the userspace VFIO framework so that another address space can drive it directly. Both bindings work for container-based workloads under Multus. For virtual machines managed by the KubeVirt-based virtualization stack, however, the practical choice is constrained by what the guest kernel needs to see and by the security model of PCI passthrough.

This article clarifies when each driver binding is appropriate so that the correct `SriovNetworkNodePolicy.spec.deviceType` and accompanying `NetworkAttachmentDefinition` are chosen for a given workload type.

## Resolution

### Picking the driver type

| Workload | Driver binding | Why |
|---|---|---|
| Container Pod with high-performance networking via Multus secondary NIC | `netdevice` | The host kernel owns the VF; the pod sees it as a regular Linux interface. No DPDK and no VM passthrough required. |
| Container Pod with userspace dataplane (DPDK) | `vfio-pci` | DPDK polls the VF directly from userspace; the kernel must release the device. |
| Virtual Machine with `virtio` NIC bridged to a VF (CNI-attached) | `netdevice` | KubeVirt creates a `virtio` NIC inside the guest and bridges it to the VF on the host through the CNI. The host kernel must own the VF. |
| Virtual Machine with full PCI passthrough of the VF into the guest | `vfio-pci` | The hypervisor (`virt-launcher` / QEMU) needs the VF detached from the host kernel so it can map the PCI device into the guest address space. |

In short:

- `netdevice` is correct for container networking and for KubeVirt VMs that present a virtio NIC to the guest.
- `vfio-pci` is required when the guest must own the PCIe function directly — true SR-IOV passthrough into the VM, or DPDK-driven containers.

### Configuring `SriovNetworkNodePolicy`

Set `spec.deviceType` to match the intended consumer:

```yaml
apiVersion: sriovnetwork.k8s.cni.cncf.io/v1
kind: SriovNetworkNodePolicy
metadata:
  name: vm-passthrough-vf
  namespace: sriov-network-operator
spec:
  deviceType: vfio-pci
  nicSelector:
    pfNames: ["enp59s0f0"]
  nodeSelector:
    feature.node.kubernetes.io/network-sriov.capable: "true"
  numVfs: 8
  resourceName: vmpassthrough
```

For container-side or VM virtio use, replace `vfio-pci` with `netdevice` and adjust `resourceName` accordingly.

### Why connectivity may appear to work even with the "wrong" type

Under `netdevice`, a VM that presents a `virtio` NIC backed by the VF can establish network connectivity because the host kernel handles the VF and forwards traffic to the VM through the standard CNI plumbing. Reachability tests succeed, which can give the impression that `vfio-pci` is optional. The functional difference appears only when the requirement is **direct hardware ownership** by the guest — for example, deterministic latency, kernel bypass, or driver-specific features in the guest OS that rely on touching the PF/VF registers directly. Those properties require `vfio-pci`.

## Diagnostic Steps

1. Inspect the active driver bound to a VF on the node:

   ```bash
   kubectl debug node/<worker> -- chroot /host \
     readlink -f /sys/bus/pci/devices/0000:3b:02.0/driver
   ```

   The symlink resolves to `.../drivers/vfio-pci` or `.../drivers/iavf` (or the relevant netdevice driver) depending on the binding.

2. Confirm the resource name advertised to the kubelet:

   ```bash
   kubectl get node <worker> -o jsonpath='{.status.allocatable}' | jq .
   ```

   The chosen `resourceName` (for example `intel.com/vmpassthrough`) will appear with a non-zero quantity once the SR-IOV operator has applied the policy.

3. For a VM intended to use passthrough, verify the resource is requested in the `VirtualMachineInstance` spec:

   ```bash
   kubectl get vmi <vm> -n <ns> -o jsonpath='{.spec.domain.devices.interfaces}'
   ```

   A passthrough interface uses `sriov: {}`; a virtio-bridged interface uses `bridge: {}` or `masquerade: {}`.
