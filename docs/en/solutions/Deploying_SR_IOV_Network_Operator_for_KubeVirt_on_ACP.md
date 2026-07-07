---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.3'
---

# Provide High-Performance Secondary NICs for Application Pods and KubeVirt VMs with Multus and SR-IOV on ACP

## Issue

Users running KubeVirt VMs or containerized network functions (CNFs) on Alauda Container Platform 4.3 may need to attach host SR-IOV VFs to Pods or VMs as high-performance secondary NICs through Multus. The cluster primary CNI can remain kube-ovn. Multus attaches the secondary network to the workload, while SR-IOV Network Operator discovers SR-IOV PFs, creates VFs, advertises VF resources through the device plugin, and generates the `NetworkAttachmentDefinition` objects consumed by Multus.

This article follows the user workflow for completing an end-to-end Multus + SR-IOV setup on ACP 4.3: install `sriov-network-plugin`, confirm the Multus/NAD base, configure `SriovNetworkNodePolicy`, generate `SriovNetwork`/NAD objects, validate the control plane without SR-IOV NICs, and validate Pod plus KubeVirt VM data-plane behavior on SR-IOV hardware.

## Environment

This article applies to the following combination:

| Component | Version or description |
| --- | --- |
| Alauda Container Platform | 4.3 |
| Plugin | `sriov-network-plugin` |
| Plugin package version | `sriov-network-plugin v4.3.1` |
| Upstream baseline | `k8snetworkplumbingwg/sriov-network-operator:v1.6.0` |
| Deployment namespace | `cpaas-system` when installed through the ACP marketplace |
| Primary CNI | kube-ovn can remain the primary CNI; SR-IOV is used as a Multus secondary network |
| Multi-NIC base | ACP provides Multus capability; workloads reference the SR-IOV secondary network through NAD |

The ACP package enables the SR-IOV CNI path for SR-IOV VF orchestration and Multus secondary-network attachment.

This article covers installing and using the SR-IOV L5 plugin for KubeVirt VM secondary NICs. It does not cover OVS-DPDK, Userspace CNI, or DPDK application configuration inside containers.

## Prerequisites

### Nodes and hardware

SR-IOV hardware is not required if you only need to validate the plugin control plane. To complete VF and virtual-machine data-plane validation, prepare at least one worker node that meets these requirements:

- The node has a physical NIC PF that supports SR-IOV.
- IOMMU is enabled in BIOS and the operating system, such as Intel VT-d or AMD-Vi.
- The PF driver supports VF creation, and the PF is not held by the primary CNI or OVS in a way that prevents VF configuration.

## Resolution

### Install the plugin

This capability is delivered as an ACP 4.3 feature. The plugin package version is `sriov-network-plugin v4.3.1`. The user workflow is to download the plugin package from the AC application marketplace, upload it to the target ACP platform, and then install it from the platform marketplace.

1. Log in to the AC application marketplace and search for `SR-IOV Network Plugin` or `sriov-network-plugin`.
2. Select the package whose compatible platform version is `v4.3` and whose plugin version is `v4.3.1`.
3. Download the package that matches the target platform architecture. For amd64 platforms, download `sriov-network-plugin.amd64.v4.3.1.tgz`; for arm64 platforms, download `sriov-network-plugin.arm64.v4.3.1.tgz`. If the platform does not require an architecture-specific package, download `sriov-network-plugin.ALL.v4.3.1.tgz`.
4. Keep the downloaded `.tgz` filename unchanged. `violet` parses the plugin name, architecture, and version from the filename; renaming the package can make the upload fail.
5. Upload the downloaded plugin package to the target ACP platform.

If the target platform uses `violet` to upload offline packages, use the following command:

```bash
export PLATFORM_URL=""
export USERNAME=""
export PASSWORD=""
export CLUSTER_NAME=""
export PACKAGE_FILE="sriov-network-plugin.amd64.v4.3.1.tgz"

violet push "$PACKAGE_FILE" \
  --platform-address "$PLATFORM_URL" \
  --platform-username "$USERNAME" \
  --platform-password "$PASSWORD" \
  --clusters "$CLUSTER_NAME" \
  --target-catalog-source platform
```

After the upload is complete, go to **Administrator -> Marketplace -> Cluster Plugins**, select version `v4.3.1` of `sriov-network-plugin`, and install it into the target business cluster. When installed through the ACP marketplace, the SR-IOV components are deployed in the `cpaas-system` namespace by default.

### Confirm the Multus base

SR-IOV networks are attached to Pods or KubeVirt VMs by Multus as secondary NICs. Before or after installing the SR-IOV plugin, confirm in **Administrator -> Marketplace -> Cluster Plugins** that Multus CNI is installed in the target business cluster. If it is not installed, follow the product documentation to [install Multus CNI](https://docs.alauda.cn/container_platform/4.3/configure/networking/how_to/kube_ovn/multiple_networks#%E5%AE%89%E8%A3%85-multus-cni) before configuring SR-IOV networks. The SR-IOV plugin handles node-side VF orchestration, SR-IOV CNI installation, and SR-IOV-related NAD generation. It does not replace the Multus meta CNI.

After installation, confirm that the operator and config-daemon are running:

```bash
kubectl get pods -n cpaas-system
```

Expected workloads:

```text
sriov-network-operator-xxxxx          1/1     Running
sriov-network-config-daemon-xxxxx     1/1     Running
```

### Control-plane validation without SR-IOV hardware

If the current environment has no SR-IOV NIC, the validation goal is to prove that the plugin deploys correctly and the operator can synchronize node state.

Check `SriovNetworkNodeState`:

```bash
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n cpaas-system
```

Check a specific node:

```bash
kubectl get sriovnetworknodestate <node-name> -n cpaas-system \
  -o jsonpath='{.status.syncStatus}{"\n"}'
```

In an environment without SR-IOV hardware, `status.interfaces` can be empty. If the operator, config-daemon, and `syncStatus` are healthy, the control-plane smoke validation is sufficient.

### VF validation with SR-IOV hardware

On a node with an SR-IOV PF, first confirm that the operator discovers the physical NIC:

```bash
kubectl get sriovnetworknodestate <node-name> -n cpaas-system \
  -o jsonpath='{range .status.interfaces[*]}{.name}{"\t"}{.pciAddress}{"\t"}{.vendor}{"\t"}{.deviceID}{"\t"}{.totalVfs}{"\n"}{end}'
```

The operator automatically discovers SR-IOV PFs on nodes and writes them to `SriovNetworkNodeState.status.interfaces`. It does not automatically decide which PF should create VFs, how many VFs to create, which `resourceName` to use, or which VF type to configure. To create VFs and advertise resources through the device plugin, create a `SriovNetworkNodePolicy`.

Select a PF, such as `ens5f0`, and create a `SriovNetworkNodePolicy`. `nodeSelector` only matches labels that already exist on nodes. Use `SriovNetworkNodeState` to identify the node that has the target SR-IOV PF, then use a stable existing node label to limit the policy scope. The following example uses `kubernetes.io/hostname` to select one node, creates four VFs, and advertises a device-plugin resource named `sriov_vf`:

```yaml
apiVersion: sriovnetwork.openshift.io/v1
kind: SriovNetworkNodePolicy
metadata:
  name: sriov-vf-policy
  namespace: cpaas-system
spec:
  resourceName: sriov_vf
  nodeSelector:
    kubernetes.io/hostname: <node-name>
  nicSelector:
    pfNames:
      - ens5f0
  numVfs: 4
  deviceType: vfio-pci
  mtu: 1500
```

`deviceType: vfio-pci` is used for KubeVirt SR-IOV PCI passthrough. The operator configures the VF driver according to this policy and exposes the resource through the device plugin. Do not run `dpdk-devbind.py` inside the VM for host VFs.

Apply the policy and watch node synchronization:

```bash
kubectl apply -f sriov-node-policy.yaml
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n cpaas-system
```

Confirm that the target node reaches `Succeeded`:

```bash
kubectl get sriovnetworknodestate <node-name> -n cpaas-system \
  -o jsonpath='{.status.syncStatus}{"\n"}{.status.lastSyncError}{"\n"}'
```

Confirm that the SR-IOV device-plugin resource appears in node allocatable resources:

```bash
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.openshift\.io/sriov_vf}{"\n"}'
```

If the output is a positive integer, the VF resource is available to the Kubernetes scheduler.

### Create an SR-IOV secondary network

Create a `SriovNetwork`. The operator generates the corresponding `NetworkAttachmentDefinition`. The following example creates the NAD in the application namespace `kubevirt` and uses Kube-OVN IPAM to assign an address to the SR-IOV secondary NIC:

```yaml
apiVersion: sriovnetwork.openshift.io/v1
kind: SriovNetwork
metadata:
  name: vm-sriov-net
  namespace: cpaas-system
spec:
  networkNamespace: kubevirt
  resourceName: sriov_vf
  vlan: 0
  ipam: |
    {
      "type": "kube-ovn",
      "server_socket": "/run/openvswitch/kube-ovn-daemon.sock",
      "provider": "vm-sriov-net.kubevirt.ovn"
    }
```

The `provider` uses the `<NAD name>.<NAD namespace>.ovn` format. In this example, the operator generates a NAD named `vm-sriov-net` in the `kubevirt` namespace, so the provider is `vm-sriov-net.kubevirt.ovn`.

Create a Kube-OVN Subnet that uses the same provider. Adjust `cidrBlock`, `gateway`, and `excludeIps` according to the application network plan:

```yaml
apiVersion: kubeovn.io/v1
kind: Subnet
metadata:
  name: vm-sriov-net
spec:
  protocol: IPv4
  enableDHCP: true
  provider: vm-sriov-net.kubevirt.ovn
  cidrBlock: 172.22.0.0/16
  gateway: 172.22.0.1
  excludeIps:
    - 172.22.0.0..172.22.0.10
```

The KubeVirt VM default network still uses the kube-ovn primary network. The SR-IOV network is attached as a Multus secondary NIC, and its address is allocated by the Kube-OVN Subnet above.

Apply the objects and confirm that the NAD is generated:

```bash
kubectl apply -f sriov-network.yaml
kubectl apply -f sriov-subnet.yaml
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n kubevirt vm-sriov-net
```

Inspect the effective NAD CNI configuration:

```bash
kubectl get network-attachment-definitions.k8s.cni.cncf.io vm-sriov-net -n kubevirt \
  -o jsonpath='{.spec.config}{"\n"}' | jq .
```

### Use the SR-IOV network in a KubeVirt VM

A VM can reference the same NAD through Multus. The following example shows only the network and interface-related fields:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: sriov-vm
  namespace: kubevirt
spec:
  running: true
  template:
    spec:
      domain:
        devices:
          interfaces:
            - name: default
              masquerade: {}
            - name: sriov-net
              sriov: {}
      networks:
        - name: default
          pod: {}
        - name: sriov-net
          multus:
            networkName: vm-sriov-net
```

In this example, the VM and the NAD are both in the `kubevirt` namespace, so `networkName` can be the NAD name, `vm-sriov-net`. To reference a NAD in another namespace, use the `<namespace>/<name>` format.

After creating the VM, confirm that the virt-launcher Pod is scheduled to a node with VF resources and inspect the VMI status:

```bash
kubectl get vmi -n kubevirt sriov-vm
kubectl get pod -n kubevirt -l kubevirt.io=virt-launcher -o wide
```

Inside the guest operating system, confirm that an additional NIC appears. The Kube-OVN Subnet handles platform-side address allocation for the secondary network. Whether the address is configured inside the guest still depends on the guest OS DHCP client, cloud-init, or system network configuration.

### Bind the service VF to DPDK inside the VM

If the workload needs DPDK inside the VM, operate only on the SR-IOV service VF that is passed through to the guest OS. Do not bind the default management NIC. Use the `dpdk-devbind.py` script from the DPDK package, or download it from the `dpdk-devbind.py` link in the ACP SR-IOV documentation.

Inside the VM, identify the PCI NICs:

```bash
lspci -Dnn | grep -i ethernet
```

Prepare HugePages according to the workload requirements, and load the VFIO driver:

```bash
modprobe vfio-pci
modprobe vfio_iommu_type1
```

Bind the service VF PCI address as seen inside the VM to `vfio-pci`:

```bash
python3 dpdk-devbind.py --status
python3 dpdk-devbind.py -b vfio-pci <guest-vf-pci-address>
python3 dpdk-devbind.py --status
```

`<guest-vf-pci-address>` is the PCI address seen inside the VM, not the VF address on the host. After binding, the VF is no longer used as a normal guest OS kernel NIC and is instead owned by the DPDK userspace process.
