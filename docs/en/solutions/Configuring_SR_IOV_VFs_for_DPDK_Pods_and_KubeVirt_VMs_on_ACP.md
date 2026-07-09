---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.3'
---

# Attach High-Performance SR-IOV VFs to DPDK Pods and KubeVirt VMs with Multus on ACP

## Issue

Users running DPDK/CNF Pods or KubeVirt VMs on Alauda Container Platform 4.3 may need to attach host SR-IOV VFs as high-performance service NICs or PCI passthrough devices through Multus. The cluster primary CNI can remain kube-ovn. Multus attaches the secondary network to workloads, while SR-IOV Network Operator discovers SR-IOV PFs, creates VFs, advertises VF resources through the device plugin, and generates the `NetworkAttachmentDefinition` objects consumed by Multus.

This article follows the user workflow for attaching SR-IOV VFs with Multus on ACP 4.3: install `sriov-network-plugin`, confirm the Multus/NAD base, configure `SriovNetworkNodePolicy`, generate `SriovNetwork`/NAD objects, and use `vfio-pci` SR-IOV VFs from either a DPDK/CNF Pod or a KubeVirt VM.

## Environment

This article applies to the following combination:

| Component | Version or description |
| --- | --- |
| Alauda Container Platform | 4.3 |
| Plugin | `sriov-network-plugin` |
| Plugin package version | `sriov-network-plugin v4.3.7` |
| Upstream baseline | `k8snetworkplumbingwg/sriov-network-operator:v1.6.0` |
| Deployment namespace | `cpaas-system` when installed through the ACP marketplace |
| Primary CNI | kube-ovn can remain the primary CNI; SR-IOV is used as a Multus secondary network or PCI passthrough device |
| Multi-NIC base | ACP provides Multus capability; Pods or VMs reference the SR-IOV VF through NAD |

This article covers installing and using the SR-IOV L5 plugin for DPDK/CNF Pod and KubeVirt VM VF attachment. It does not cover OVS-DPDK, Userspace CNI, or internal DPDK application parameters.

## Prerequisites

### Nodes and hardware

Prepare at least one worker node that meets these requirements:

- The node has a physical NIC PF that supports SR-IOV.
- IOMMU is enabled in BIOS and the operating system, such as Intel VT-d or AMD-Vi.
- The PF driver supports VF creation, and the PF is not held by the primary CNI or OVS in a way that prevents VF configuration.

On the node, use the following checks to confirm that IOMMU is enabled:

```bash
cat /proc/cmdline
dmesg | grep -Ei 'DMAR|IOMMU|AMD-Vi'
```

`/proc/cmdline` usually contains a parameter such as `intel_iommu=on` or `amd_iommu=on`, and `dmesg` should include IOMMU initialization logs. After a VF is created, also confirm that the VF has an IOMMU group:

```bash
readlink -f /sys/bus/pci/devices/<vf-pci-address>/iommu_group
```

If the path does not exist, the node usually does not have usable IOMMU isolation, and the `vfio-pci` or PCI passthrough scenario should not continue.

The node kernel must also have VFIO support enabled. At minimum, confirm that the `vfio-pci` module is available:

```bash
lsmod | grep vfio
modprobe vfio-pci
```

To load the module automatically after node reboot, write it to the system module-load configuration:

```bash
echo vfio-pci > /etc/modules-load.d/vfio-pci.conf
```

### Label SR-IOV nodes

`sriov-network-config-daemon` is scheduled only to nodes labeled with `feature.node.kubernetes.io/sriov-capable=true` by default. Before installing the plugin, label the nodes that actually have SR-IOV PFs:

```bash
kubectl label node <node-name> feature.node.kubernetes.io/sriov-capable=true --overwrite
```

Apply this label only to nodes where VFs will be configured. Nodes without this label do not run `sriov-network-config-daemon` and do not get a corresponding `SriovNetworkNodeState`.

## Resolution

### Install the plugin

This capability is delivered as an ACP 4.3 feature. The plugin package version is `sriov-network-plugin v4.3.7`. The user workflow is to download the plugin package from the AC application marketplace, upload it to the target ACP platform, and then install it from the platform marketplace.

1. Log in to the AC application marketplace and search for `SR-IOV Network Plugin` or `sriov-network-plugin`.
2. Select the package whose compatible platform version is `v4.3` and whose plugin version is `v4.3.7`.
3. Download the `sriov-network-plugin.*.v4.3.7.tgz` package that matches the target platform architecture.
4. Keep the downloaded `.tgz` filename unchanged. `violet` parses the plugin name, architecture, and version from the filename; renaming the package can make the upload fail.
5. Upload the downloaded plugin package to the target ACP platform.

If the target platform uses `violet` to upload offline packages, use the following command:

```bash
export PLATFORM_URL=""
export USERNAME=""
export PASSWORD=""
export CLUSTER_NAME=""
export PACKAGE_FILE="sriov-network-plugin.amd64.v4.3.7.tgz"

violet push "$PACKAGE_FILE" \
  --platform-address "$PLATFORM_URL" \
  --platform-username "$USERNAME" \
  --platform-password "$PASSWORD" \
  --clusters "$CLUSTER_NAME" \
  --target-catalog-source platform
```

After the upload is complete, go to **Administrator -> Marketplace -> Cluster Plugins**, select version `v4.3.7` of `sriov-network-plugin`, and install it into the target business cluster. When installed through the ACP marketplace, the SR-IOV components are deployed in the `cpaas-system` namespace by default.

### Confirm the Multus base

SR-IOV networks are attached to DPDK/CNF Pods or KubeVirt VMs by Multus as secondary networks. Before or after installing the SR-IOV plugin, confirm in **Administrator -> Marketplace -> Cluster Plugins** that Multus CNI is installed in the target business cluster. If it is not installed, follow the "Install Multus CNI" section in the product documentation for [multiple networks](https://docs.alauda.cn/container_platform/4.3/configure/networking/how_to/kube_ovn/multiple_networks) before configuring SR-IOV networks. The SR-IOV plugin handles node-side VF orchestration, SR-IOV CNI installation, and SR-IOV-related NAD generation. It does not replace the Multus meta CNI.

After installation, confirm that the operator and config-daemon are running:

```bash
kubectl get pods -n cpaas-system
```

Expected workloads:

```text
sriov-network-operator-xxxxx          1/1     Running
sriov-network-config-daemon-xxxxx     1/1     Running
```

If `sriov-network-config-daemon` is not visible, first confirm that the target node is labeled with `feature.node.kubernetes.io/sriov-capable=true`.

### Confirm SR-IOV PFs on nodes

A PF is the physical NIC on a node. A VF is a virtual PCI NIC created from a PF and assigned to a Pod or VM.

First list the node states synchronized by the operator, and select the target node from the `NAME` column:

```bash
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n cpaas-system
```

If a node with an SR-IOV NIC is missing from the list, first check whether the node has the `feature.node.kubernetes.io/sriov-capable=true` label. The config-daemon collects PF status only on nodes that match this label.

On a node with an SR-IOV PF, confirm that the operator discovers the physical NIC:

```bash
kubectl get sriovnetworknodestate <node-name> -n cpaas-system \
  -o jsonpath='{range .status.interfaces[*]}{.name}{"\t"}{.pciAddress}{"\t"}{.vendor}{"\t"}{.deviceID}{"\t"}{.totalVfs}{"\n"}{end}'
```

Record the PF name to use, such as `ens5f0`. Later, the `SriovNetworkNodePolicy` specifies the target nodes, PF name, VF count, `resourceName`, and `deviceType`. The following DPDK/CNF Pod and KubeVirt VM examples can share the same policy. Create a separate policy only when the workloads need independent VF pools.

### Optional: Handle NICs not in the default supported list

If `sriov-network-config-daemon` keeps logging messages like the following, the operator is running, but the NIC PCI ID is not in the default supported list. The operator skips that PF:

```text
DiscoverSriovDevices(): unsupported device {"device": "0000:3d:00.0 -> driver: 'hinic' ... product: 'Hi1822 Family (4*25GE)'"}
IsSupportedModel(): found unsupported model {"vendorId:": "19e5", "deviceId:": "1822"}
```

Add the NIC to the `supported-nic-ids` allowlist. The entry format is:

```text
<name>: "<vendor-id> <pf-device-id> <vf-device-id>"
```

For example, a Huawei Hi1822 PF has PCI ID `19e5:1822`, and its VF has PCI ID `19e5:375e`. The entry is:

```yaml
supportedExtraNICs:
  - 'Huawei_Hi1822: "19e5 1822 375e"'
```

If the VF device ID is unknown, temporarily create one VF during a maintenance window and inspect it. In the following example, `0000:3d:00.0` is the PF PCI address:

```bash
echo 1 > /sys/bus/pci/devices/0000:3d:00.0/sriov_numvfs
readlink -f /sys/bus/pci/devices/0000:3d:00.0/virtfn0
lspci -Dnn -s <vf-pci-address>
```

For on-site validation, you can temporarily patch the ConfigMap in an installed cluster and restart the operator and config-daemon:

```bash
kubectl patch cm supported-nic-ids -n cpaas-system --type merge -p \
  '{"data":{"Huawei_Hi1822":"19e5 1822 375e"}}'

kubectl rollout restart deployment/sriov-network-operator -n cpaas-system
kubectl rollout restart daemonset/sriov-network-config-daemon -n cpaas-system
```

This patch is only suitable for validation and can be lost after plugin upgrade or reinstall. For production delivery, persist the entry through `supportedExtraNICs` in the plugin installation parameters. If `sriov_numvfs` was written manually to discover the VF ID, clear the manually created VFs before letting the operator manage the PF through `SriovNetworkNodePolicy`:

```bash
echo 0 > /sys/bus/pci/devices/<pf-pci-address>/sriov_numvfs
```

Otherwise, config-daemon may report that the PF already has VFs that were not created by the sriov operator and skip part of the change flow.

### Configure and use an SR-IOV VF for DPDK/CNF Pods

When a DPDK/CNF Pod needs a userspace process to own the VF directly, set `deviceType` to `vfio-pci`. In this mode, the VF is not used as a regular Linux network interface inside the Pod. Packet processing and address handling are owned by the DPDK/CNF application in the container. Therefore, it is expected that `ip a` inside the Pod does not show a secondary interface such as `net1`. The validation target is a `/dev/vfio/<iommu-group>` device inside the container.

Save the following content as `sriov-node-policy-pod.yaml`:

```yaml
apiVersion: sriovnetwork.openshift.io/v1
kind: SriovNetworkNodePolicy
metadata:
  name: sriov-pod-policy
  namespace: cpaas-system
spec:
  resourceName: sriov_vfio
  nodeSelector:
    kubernetes.io/hostname: <node-name>
  nicSelector:
    pfNames:
      - ens5f0
  numVfs: 8
  deviceType: vfio-pci
  mtu: 1500
```

Apply the policy and watch node synchronization:

```bash
kubectl apply -f sriov-node-policy-pod.yaml
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
  -o jsonpath='{.status.allocatable.openshift\.io/sriov_vfio}{"\n"}'
```

If the output is a positive integer, the VF resource is available to the Kubernetes scheduler.

Record the PCI address of the target VF and confirm that its IOMMU group does not include other devices that should not be passed through to the workload:

```bash
VF_PCI_ADDR="<vf-pci-address>"
GROUP_PATH="$(readlink -f /sys/bus/pci/devices/$VF_PCI_ADDR/iommu_group)"
ls -l "$GROUP_PATH/devices"
```

If the same group contains other devices still required by the host, do not use that VF directly for `vfio-pci` or PCI passthrough. Adjust the hardware, BIOS settings, kernel IOMMU parameters, or NIC planning first.

Create a `SriovNetwork`. The operator generates the corresponding `NetworkAttachmentDefinition`. The following example creates the NAD in the application namespace `default`. Because the VF is owned directly by the DPDK/CNF application, Kube-OVN IPAM is not configured here.

Save the following content as `sriov-network-pod.yaml`:

```yaml
apiVersion: sriovnetwork.openshift.io/v1
kind: SriovNetwork
metadata:
  name: pod-sriov-net
  namespace: cpaas-system
spec:
  networkNamespace: default
  resourceName: sriov_vfio
```

In this example, the operator generates a NAD named `pod-sriov-net` in the `default` namespace. If the application Pod runs in another namespace, update `SriovNetwork.spec.networkNamespace`, Pod `metadata.namespace`, and the Pod NAD reference together.

If the service network must use a specific VLAN, add `vlan: <vlan-id>` under `spec`. If this field is omitted, the network is untagged.

The Pod default network still uses the kube-ovn primary network. The SR-IOV VF is attached as a Multus secondary resource and consumed by the DPDK/CNF application.

Apply the objects and confirm that the NAD is generated:

```bash
kubectl apply -f sriov-network-pod.yaml
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n default pod-sriov-net
```

A Pod references the NAD through the `k8s.v1.cni.cncf.io/networks` annotation and requests one SR-IOV VF through resource requests. The following example keeps the Pod default network on kube-ovn and requests one `vfio-pci` SR-IOV VF for the DPDK/CNF application.

Save the following content as `sriov-pod.yaml`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: sriov-pod
  namespace: default
  annotations:
    k8s.v1.cni.cncf.io/networks: default/pod-sriov-net
spec:
  containers:
    - name: app
      image: nginx:latest
      resources:
        requests:
          openshift.io/sriov_vfio: "1"
        limits:
          openshift.io/sriov_vfio: "1"
```

The `default/pod-sriov-net` value uses the `<NAD namespace>/<NAD name>` format. `openshift.io/sriov_vfio` corresponds to `SriovNetworkNodePolicy.spec.resourceName` and `SriovNetwork.spec.resourceName`.

Apply the Pod and confirm that it is scheduled to a node with VF resources:

```bash
kubectl apply -f sriov-pod.yaml
kubectl get pod -n default sriov-pod -o wide
```

Confirm that the container has received the VFIO device:

```bash
kubectl exec -n default sriov-pod -- ls -l /dev/vfio/
```

The expected output includes the `vfio` control device and one numeric IOMMU group device, for example:

```text
crw-------    1 root     root      234, 191 ... 191
crw-rw-rw-    1 root     root       10, 196 ... vfio
```

The numeric device, such as `191`, is the VFIO group available to the current Pod. In this scenario, do not use the presence of a secondary interface in `ip a` as the success criterion.

If `dpdk-devbind.py -s` is run inside the container or the Pod namespace, it may list all PF/VF PCI devices on the node. The script reads `/sys/bus/pci/devices`, and PCI sysfs is not filtered by Pod resource allocation. To determine which VF the current Pod can actually use, rely on the devices exposed under `/dev/vfio/` and the `openshift.io/sriov_vfio` resource allocated to the Pod.

The following is a reference observation: when `numVfs: 8` creates eight VFs on the node, all eight VFs are bound to `vfio-pci`, so `dpdk-devbind.py -s` can list eight VFs. However, when a single Pod requests only one `openshift.io/sriov_vfio`, the container exposes only one numeric group device under `/dev/vfio/`.

```text
Network devices using DPDK-compatible driver
============================================
0000:3d:00.1 'Hi1822 Family Virtual Function 375e' numa_node=0 drv=vfio-pci unused=hinic
0000:3d:00.2 'Hi1822 Family Virtual Function 375e' numa_node=0 drv=vfio-pci unused=hinic
...
0000:3d:01.0 'Hi1822 Family Virtual Function 375e' numa_node=0 drv=vfio-pci unused=hinic
```

This output only shows the VF driver binding status on the node. The number of VFs actually available to the Pod is still determined by `/dev/vfio/` and the resource request count.

If the workload uses Deployment, StatefulSet, or another controller, set `k8s.v1.cni.cncf.io/networks` in the Pod template `metadata.annotations`, and request `openshift.io/sriov_vfio` in the application container `resources.requests` and `resources.limits`. The VF resource only assigns the PCI device to the Pod. DPDK applications usually also need CPU, HugePages, and startup-parameter configuration; the exact values are determined by the business image and DPDK application documentation. A reference Pod fragment is:

```yaml
resources:
  requests:
    cpu: "4"
    memory: 4Gi
    hugepages-2Mi: 1Gi
    openshift.io/sriov_vfio: "1"
  limits:
    cpu: "4"
    memory: 4Gi
    hugepages-2Mi: 1Gi
    openshift.io/sriov_vfio: "1"
volumeMounts:
  - name: hugepage
    mountPath: /dev/hugepages
volumes:
  - name: hugepage
    emptyDir:
      medium: HugePages
```

### Configure and use an SR-IOV network for KubeVirt VMs

KubeVirt SR-IOV PCI passthrough passes the VF to the VM as a PCI device, so `deviceType` is `vfio-pci`.

If a `SriovNetworkNodePolicy` with `resourceName: sriov_vfio` already exists for the same PF, continue directly with the `SriovNetwork` for the VM. Create a separate policy only when the VM needs an independent VF pool.

Save the following content as `sriov-node-policy-vm.yaml`:

```yaml
apiVersion: sriovnetwork.openshift.io/v1
kind: SriovNetworkNodePolicy
metadata:
  name: sriov-vm-policy
  namespace: cpaas-system
spec:
  resourceName: sriov_vfio
  nodeSelector:
    kubernetes.io/hostname: <node-name>
  nicSelector:
    pfNames:
      - ens5f0
  numVfs: 8
  deviceType: vfio-pci
  mtu: 1500
```

Apply the policy and watch node synchronization:

```bash
kubectl apply -f sriov-node-policy-vm.yaml
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n cpaas-system
```

Confirm that the SR-IOV device-plugin resource appears in node allocatable resources:

```bash
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.openshift\.io/sriov_vfio}{"\n"}'
```

If the target VF IOMMU group was not checked earlier, complete the same IOMMU group check before creating the `SriovNetwork` for the VM.

Create a `SriovNetwork`. The operator generates the corresponding `NetworkAttachmentDefinition`. The following example creates the NAD in the VM namespace `kubevirt`. If the VF is later owned by a DPDK application inside the VM, Kube-OVN IPAM is not required here.

Save the following content as `sriov-network-vm.yaml`:

```yaml
apiVersion: sriovnetwork.openshift.io/v1
kind: SriovNetwork
metadata:
  name: vm-sriov-net
  namespace: cpaas-system
spec:
  networkNamespace: kubevirt
  resourceName: sriov_vfio
```

In this example, the operator generates a NAD named `vm-sriov-net` in the `kubevirt` namespace. If the VM runs in another namespace, update `SriovNetwork.spec.networkNamespace`, VM `metadata.namespace`, and the VM NAD reference together.

If the service network must use a specific VLAN, add `vlan: <vlan-id>` under `spec`. If this field is omitted, the network is untagged.

The KubeVirt VM default network still uses the kube-ovn primary network. The SR-IOV VF is attached as a Multus secondary device and passed through to the VM.

Apply the objects and confirm that the NAD is generated:

```bash
kubectl apply -f sriov-network-vm.yaml
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n kubevirt vm-sriov-net
```

The VM secondary NIC is configured in two places in the VM template: `spec.template.spec.domain.devices.interfaces` defines the NIC type seen by the VM, and `spec.template.spec.networks` defines which Multus NAD the NIC attaches to. The `name` values in both lists must match.

Add both `interfaces[].sriov` and `networks[].multus` to the VM template to attach the SR-IOV secondary NIC. The following example shows only the network and interface-related fields:

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

Inside the guest operating system, confirm that the passed-through SR-IOV VF appears. Whether to bind the VF to DPDK, how to allocate HugePages inside the VM for the DPDK application, and how to configure EAL parameters or the service process are determined by the guest operating system and DPDK application documentation.
