---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.3.x'
---

# Provide High-Performance Secondary NICs for Application Pods and KubeVirt VMs with Multus and SR-IOV on ACP

## Issue

Users running KubeVirt VMs or containerized network functions (CNFs) on Alauda Container Platform 4.3.x may need to attach host SR-IOV VFs to Pods or VMs as high-performance secondary NICs through Multus. The cluster primary CNI can remain kube-ovn. Multus attaches the secondary network to the workload, while SR-IOV Network Operator discovers SR-IOV PFs, creates VFs, advertises VF resources through the device plugin, and generates the `NetworkAttachmentDefinition` objects consumed by Multus.

This article follows the user workflow for completing an end-to-end Multus + SR-IOV setup on ACP 4.3.x: install `sriov-network-plugin`, confirm the Multus/NAD base, configure `SriovNetworkNodePolicy`, generate `SriovNetwork`/NAD objects, validate the control plane without SR-IOV NICs, and validate Pod plus KubeVirt VM data-plane behavior on SR-IOV hardware.

## Environment

This article applies to the following combination:

| Component | Version or description |
| --- | --- |
| Alauda Container Platform | 4.3.x |
| Plugin | `sriov-network-plugin` |
| Plugin package version | `sriov-network-plugin v4.3.x` |
| Upstream baseline | `k8snetworkplumbingwg/sriov-network-operator:v1.6.0` |
| Deployment namespace | `cpaas-system` when installed through the ACP marketplace |
| Primary CNI | kube-ovn can remain the primary CNI; SR-IOV is used as a Multus secondary network |
| Multi-NIC base | ACP provides Multus capability; workloads reference the SR-IOV secondary network through NAD |

The ACP package enables only the SR-IOV CNI path. The `config-daemon` installs the SR-IOV CNI binary into the node CNI bin directory through the `sriov-cni` init container. The image values for `ib-sriov-cni`, `ovs-cni`, and `rdma-cni` are empty, so the operator does not render these init containers in the `config-daemon` DaemonSet.

This solution delivers SR-IOV VF orchestration and Multus secondary-network attachment. A DPDK userspace data plane can be built on top of SR-IOV VFs, but it still requires additional VF driver binding, HugePages, CPU isolation, NUMA planning, workload image adaptation, and performance testing. These are not provided as out-of-the-box capabilities by this plugin package.

## Prerequisites

### Platform and permissions

Prepare a kubeconfig that can manage the target cluster. The current user must be able to create the following resources:

- Namespaces, ServiceAccounts, ClusterRoles, and ClusterRoleBindings
- CRDs
- Deployments and DaemonSets
- Custom resources in the `sriovnetwork.openshift.io` API group
- `NetworkAttachmentDefinition` objects in `k8s.cni.cncf.io/v1`

### Nodes and hardware

SR-IOV hardware is not required if you only need to validate the plugin control plane. To complete VF and virtual-machine data-plane validation, prepare at least one worker node that meets these requirements:

- The node has a physical NIC PF that supports SR-IOV.
- IOMMU is enabled in BIOS and the operating system, such as Intel VT-d or AMD-Vi.
- The PF driver supports VF creation, and the PF is not held by the primary CNI or OVS in a way that prevents VF configuration.
- The target node can enter a maintenance window. Creating VFs or changing VF drivers can trigger node drain or a short network interruption.

Label the nodes that will be configured for SR-IOV. `SriovNetworkNodePolicy` will use this label to limit its scope:

```bash
kubectl label node <node-name> feature.node.kubernetes.io/sriov-capable=true
```

## Resolution

### Install the plugin

This capability is delivered as an ACP 4.3.x feature. The plugin package version is `sriov-network-plugin v4.3.x`. The user workflow is to download the plugin package from the AC application marketplace, upload it to the target ACP platform, and then install it from the platform marketplace.

1. Log in to the AC application marketplace and search for `SR-IOV Network Plugin` or `sriov-network-plugin`.
2. Select the package whose compatible platform version is `v4.3` and whose plugin version is `v4.3.x`.
3. Download the package that matches the target platform architecture. For amd64 platforms, download `sriov-network-plugin.amd64.v4.3.x.tgz`; for arm64 platforms, download `sriov-network-plugin.arm64.v4.3.x.tgz`. If the platform does not require an architecture-specific package, download `sriov-network-plugin.ALL.v4.3.x.tgz`.
4. Keep the downloaded `.tgz` filename unchanged. `violet` parses the plugin name, architecture, and version from the filename; renaming the package can make the upload fail.
5. Upload the downloaded plugin package to the target ACP platform.

If the target platform uses `violet` to upload offline packages, use the following command:

```bash
export PLATFORM_URL=""
export USERNAME=""
export PASSWORD=""
export CLUSTER_NAME=""
export PACKAGE_FILE="sriov-network-plugin.amd64.v4.3.x.tgz"

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY

violet push "$PACKAGE_FILE" \
  --platform-address "$PLATFORM_URL" \
  --platform-username "$USERNAME" \
  --platform-password "$PASSWORD" \
  --clusters "$CLUSTER_NAME" \
  --target-catalog-source platform
```

After the upload succeeds, verify on the global cluster that the plugin version configuration has been generated and is ready to deploy:

```bash
kubectl get moduleplugin sriov-network-plugin \
  -o jsonpath='{.status.latestVersion}{"\n"}'
kubectl get moduleconfig sriov-network-plugin-<version> \
  -o jsonpath='{.status.readyForDeploy}{"\n"}'
```

The expected output is `v4.3.x` and `true`. If the `ModulePlugin` exists but no `ModuleConfig` is generated, or if the `ModuleConfig` is not `readyForDeploy=true`, the plugin package metadata is incomplete. Common causes are a missing `ModulePlugin.spec.logo` or a missing platform installation config file, `scripts/plugin-config.yaml`, in the package. Upload the complete package published from the AC marketplace instead.

After the upload is complete, go to **Administrator -> Marketplace -> Cluster Plugins**, select `sriov-network-plugin`, and install it into the target business cluster. When installed through the ACP marketplace, the SR-IOV components are deployed in the `cpaas-system` namespace by default. The following commands use this variable:

```bash
export SRIOV_NAMESPACE="cpaas-system"
```

Before installation, confirm that the cluster does not already have a manually installed SR-IOV instance. If a previous test installation exists in another namespace, such as `sriov-network-operator`, uninstall that old instance with the original installation method before installing from the marketplace. Running two operators against the same SR-IOV custom resources is not recommended:

```bash
kubectl get pods -A | grep sriov-network
kubectl get sriovoperatorconfig -A
kubectl get sriovnetworknodestate -A
```

The SR-IOV node daemon requires `hostNetwork`, `hostPID`, `hostPath`, and privileged containers. Before installation, confirm that the deployment namespace allows privileged Pod Security Admission. If the labels are missing, add them:

```bash
kubectl label namespace "$SRIOV_NAMESPACE" \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/audit=privileged \
  pod-security.kubernetes.io/warn=privileged \
  --overwrite
```

### Confirm the Multus base

SR-IOV networks are attached to Pods or KubeVirt VMs by Multus as secondary NICs. Before or after installing the SR-IOV plugin, confirm that the cluster has the NAD CRD:

```bash
kubectl get crd network-attachment-definitions.k8s.cni.cncf.io
```

If this CRD does not exist, the Multus base is not ready. Install or enable ACP Multus capability before configuring SR-IOV networks. The SR-IOV plugin handles node-side VF orchestration, SR-IOV CNI installation, and SR-IOV-related NAD generation. It does not replace the Multus meta CNI.

After installation, confirm that the operator and config-daemon are running:

```bash
kubectl get pods -n "$SRIOV_NAMESPACE"
```

Expected workloads:

```text
sriov-network-operator-xxxxx          1/1     Running
sriov-network-config-daemon-xxxxx     1/1     Running
```

Confirm that the CRDs are registered:

```bash
kubectl get crd | grep sriovnetwork.openshift.io
```

Confirm that `config-daemon` has only the `sriov-cni` init container and does not include `ib-sriov-cni`, `ovs-cni`, or `rdma-cni`:

```bash
kubectl get daemonset sriov-network-config-daemon -n "$SRIOV_NAMESPACE" \
  -o jsonpath='{range .spec.template.spec.initContainers[*]}{.name}{"\t"}{.image}{"\n"}{end}'
```

Expected output:

```text
sriov-cni    build-harbor.alauda.cn/3rdparty/sriov/sriov-cni:v2.10.0
```

### Control-plane validation without SR-IOV hardware

If the current environment has no SR-IOV NIC, the validation goal is to prove that the plugin deploys correctly, CRDs are registered, the operator can synchronize node state, and no extra `ovs-cni`, `rdma-cni`, or `ib-sriov-cni` init containers are deployed.

Check `SriovNetworkNodeState`:

```bash
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n "$SRIOV_NAMESPACE"
```

Check a specific node:

```bash
kubectl get sriovnetworknodestate <node-name> -n "$SRIOV_NAMESPACE" \
  -o jsonpath='{.status.syncStatus}{"\n"}'
```

In an environment without SR-IOV hardware, `status.interfaces` can be empty. This is a hardware limitation and does not indicate a plugin deployment failure. If the operator, config-daemon, CRDs, and `syncStatus` are healthy, the control-plane smoke validation is sufficient.

### VF validation with SR-IOV hardware

On a node with an SR-IOV PF, first confirm that the operator discovers the physical NIC:

```bash
kubectl get sriovnetworknodestate <node-name> -n "$SRIOV_NAMESPACE" \
  -o jsonpath='{range .status.interfaces[*]}{.name}{"\t"}{.pciAddress}{"\t"}{.vendor}{"\t"}{.deviceID}{"\t"}{.totalVfs}{"\n"}{end}'
```

Select a PF, such as `ens5f0`, and create a `SriovNetworkNodePolicy`. The following example creates four VFs and advertises a device-plugin resource named `intel_sriov_netdevice`:

```yaml
apiVersion: sriovnetwork.openshift.io/v1
kind: SriovNetworkNodePolicy
metadata:
  name: intel-sriov-netdevice
  namespace: cpaas-system
spec:
  resourceName: intel_sriov_netdevice
  nodeSelector:
    feature.node.kubernetes.io/sriov-capable: "true"
  nicSelector:
    pfNames:
      - ens5f0
  numVfs: 4
  deviceType: netdevice
  mtu: 1500
```

Apply the policy and watch node synchronization:

```bash
kubectl apply -f sriov-node-policy.yaml
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n "$SRIOV_NAMESPACE"
```

Confirm that the target node reaches `Succeeded`:

```bash
kubectl get sriovnetworknodestate <node-name> -n "$SRIOV_NAMESPACE" \
  -o jsonpath='{.status.syncStatus}{"\n"}{.status.lastSyncError}{"\n"}'
```

Confirm that the SR-IOV device-plugin resource appears in node allocatable resources:

```bash
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.openshift\.io/intel_sriov_netdevice}{"\n"}'
```

If the output is a positive integer, the VF resource is available to the Kubernetes scheduler.

### Create an SR-IOV secondary network

Create a `SriovNetwork`. The operator generates the corresponding `NetworkAttachmentDefinition`. The following example creates the NAD in the application namespace `kubevirt`:

```yaml
apiVersion: sriovnetwork.openshift.io/v1
kind: SriovNetwork
metadata:
  name: vm-sriov-net
  namespace: cpaas-system
spec:
  networkNamespace: kubevirt
  resourceName: intel_sriov_netdevice
  vlan: 0
  ipam: |
    {
      "type": "host-local",
      "subnet": "192.168.100.0/24",
      "rangeStart": "192.168.100.100",
      "rangeEnd": "192.168.100.200",
      "gateway": "192.168.100.1"
    }
```

Apply the object and confirm that the NAD is generated:

```bash
kubectl apply -f sriov-network.yaml
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n kubevirt vm-sriov-net
```

Inspect the effective NAD CNI configuration:

```bash
kubectl get network-attachment-definitions.k8s.cni.cncf.io vm-sriov-net -n kubevirt \
  -o jsonpath='{.spec.config}{"\n"}' | jq .
```

### Validate VF allocation with a test Pod

Create a test Pod in the application namespace. The Pod must request the SR-IOV resource and reference the NAD:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: sriov-test
  namespace: kubevirt
  annotations:
    k8s.v1.cni.cncf.io/networks: vm-sriov-net
spec:
  restartPolicy: Never
  containers:
    - name: test
      image: <test-image-with-iproute2-or-busybox>
      command:
        - sleep
        - "3600"
      resources:
        requests:
          openshift.io/intel_sriov_netdevice: "1"
        limits:
          openshift.io/intel_sriov_netdevice: "1"
```

Confirm that the Pod is scheduled to an SR-IOV node and enters `Running`:

```bash
kubectl get pod sriov-test -n kubevirt -o wide
```

Enter the Pod and inspect the secondary NIC:

```bash
kubectl exec -n kubevirt sriov-test -- ip link
kubectl exec -n kubevirt sriov-test -- ip addr
```

If the underlay network is ready, continue with ping or application traffic validation:

```bash
kubectl exec -n kubevirt sriov-test -- ping -c 3 192.168.100.1
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

After creating the VM, confirm that the virt-launcher Pod is scheduled to a node with VF resources and inspect the VMI status:

```bash
kubectl get vmi -n kubevirt sriov-vm
kubectl get pod -n kubevirt -l kubevirt.io=virt-launcher -o wide
```

Inside the guest operating system, confirm that an additional NIC appears, then configure an IP address according to the network design or use DHCP if available.

### Relationship with DPDK and support boundary

The upstream `sriov-cni` can assign SR-IOV VFs to workloads. After those VFs are bound to userspace drivers such as `vfio-pci`, they can become part of a DPDK data path. Therefore, this solution provides the SR-IOV attachment base for a DPDK high-performance network path, but it is not a complete DPDK solution by itself.

If the customer workload explicitly requires DPDK, validate the following items in addition to this solution:

- Node BIOS settings, IOMMU, VFIO driver, HugePages, CPU isolation, and NUMA affinity.
- Whether VFs use kernel `netdevice` mode or are bound to `vfio-pci` for DPDK userspace processes.
- Whether the DPDK path is direct SR-IOV VF consumption by the workload, kube-ovn OVS-DPDK, Userspace CNI, vhostuser, or another integration pattern.
- Performance baselines for PPS, bandwidth, latency, and jitter using the customer CNF image or tools such as `testpmd` and Trex.

Do not describe this plugin package as a complete DPDK productized delivery before the hardware, driver, resource-isolation, and performance-validation work is complete.

## Diagnostic steps

### Operator or config-daemon is not running

Check Pod status and events:

```bash
kubectl get pods -n "$SRIOV_NAMESPACE" -o wide
kubectl describe pod -n "$SRIOV_NAMESPACE" <pod-name>
kubectl logs -n "$SRIOV_NAMESPACE" deploy/sriov-network-operator
```

If `config-daemon` is stuck in init, first confirm that the init container list contains only `sriov-cni`. If `ovs-cni`, `rdma-cni`, or `ib-sriov-cni` still appears, the installed plugin package or operator image is not the ACP-corrected version.

### The node does not discover an SR-IOV PF

Check `SriovNetworkNodeState`:

```bash
kubectl get sriovnetworknodestate <node-name> -n "$SRIOV_NAMESPACE" -o yaml
```

If `status.interfaces` is empty, continue checking hardware and kernel state on the node:

```bash
lspci -nn | grep -i ethernet
ip link show
```

Confirm that BIOS/IOMMU is enabled and that the target PF driver supports SR-IOV.

### Policy synchronization fails

Check synchronization status and errors:

```bash
kubectl get sriovnetworknodestate <node-name> -n "$SRIOV_NAMESPACE" \
  -o jsonpath='{.status.syncStatus}{"\n"}{.status.lastSyncError}{"\n"}'
```

Common causes include:

- `nodeSelector` does not match any node.
- `nicSelector.pfNames` is incorrect, or the PF name does not exist on the target node.
- The PF is held by another network component and cannot create VFs.
- IOMMU is not enabled, or the driver does not support the requested number of VFs.

### Pod or VM cannot allocate a VF

Confirm that the resource exists in node allocatable:

```bash
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.openshift\.io/intel_sriov_netdevice}{"\n"}'
```

Check Pod or virt-launcher events:

```bash
kubectl describe pod -n kubevirt <pod-name>
```

If the event reports insufficient resources, verify that `SriovNetworkNodePolicy.spec.resourceName`, the Pod resource request, and `SriovNetwork.spec.resourceName` all use the same value.

## Limitations

- An environment without SR-IOV hardware can only validate the control-plane smoke path. It cannot prove VF creation, device-plugin resource advertisement, or VM data-plane connectivity.
- This solution does not replace the cluster primary CNI. kube-ovn continues to provide the Pod primary network, while SR-IOV is used as a Multus secondary network.
- The current ACP package does not deploy `ovs-cni`, `rdma-cni`, or `ib-sriov-cni`. If the workload requires OVS, RDMA, or InfiniBand SR-IOV, evaluate the required images, operator rendering logic, and validation scope separately.