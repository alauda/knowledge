---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.3'
id: KB260700036
sourceSHA: 158f4ee3bbcc58c24accc28426a04b5ac574859e617e3f16e58b6cd6948cc6c7
---

# 在 ACP 上使用 Multus 将高性能 SR-IOV VF 附加到 DPDK Pods 和 KubeVirt VMs

## 问题

在 Alauda 容器平台 4.3 上运行 DPDK/CNF Pods 或 KubeVirt VMs 的用户可能需要通过 Multus 将主机 SR-IOV VF 附加为高性能服务 NIC 或 PCI 直通设备。集群的主要 CNI 可以保持为 kube-ovn。Multus 将次要网络附加到工作负载，而 SR-IOV 网络操作员发现 SR-IOV PF，创建 VF，通过设备插件发布 VF 资源，并生成 Multus 消耗的 `NetworkAttachmentDefinition` 对象。

本文遵循在 ACP 4.3 上使用 Multus 附加 SR-IOV VFs 的用户工作流程：安装 `sriov-network-plugin`，确认 Multus/NAD 基础，配置 `SriovNetworkNodePolicy`，生成 `SriovNetwork`/NAD 对象，并使用来自 DPDK/CNF Pod 或 KubeVirt VM 的 `vfio-pci` SR-IOV VFs。

## 环境

本文适用于以下组合：

| 组件                       | 版本或描述                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Alauda 容器平台         | 4.3                                                                                                         |
| 插件                      | `sriov-network-plugin`                                                                                      |
| 插件包版本                | `sriov-network-plugin v4.3.8`                                                                               |
| 上游基线                  | `k8snetworkplumbingwg/sriov-network-operator:v1.6.0`                                                        |
| 部署命名空间              | 通过 ACP 市场安装时为 `cpaas-system`                                                   |
| 主要 CNI                 | kube-ovn 可以保持为主要 CNI；SR-IOV 用作 Multus 次要网络或 PCI 直通设备 |
| 多 NIC 基础               | ACP 提供 Multus 功能；Pods 或 VMs 通过 NAD 引用 SR-IOV VF                             |

本文涵盖了 DPDK/CNF Pod 和 KubeVirt VM VF 附加的 SR-IOV L5 插件的安装和使用。它不涵盖 OVS-DPDK、用户空间 CNI 或内部 DPDK 应用程序参数。

## 先决条件

### 节点和硬件

准备至少一个满足以下要求的工作节点：

- 节点具有支持 SR-IOV 的物理 NIC PF。
- BIOS 和操作系统中启用了 IOMMU，例如 Intel VT-d 或 AMD-Vi。
- PF 驱动程序支持 VF 创建，并且 PF 未被主要 CNI 或 OVS 以阻止 VF 配置的方式占用。

在节点上，使用以下检查确认 IOMMU 是否已启用：

```bash
cat /proc/cmdline
dmesg | grep -Ei 'DMAR|IOMMU|AMD-Vi'
```

`/proc/cmdline` 通常包含参数，例如 `intel_iommu=on` 或 `amd_iommu=on`，并且 `dmesg` 应包括 IOMMU 初始化日志。创建 VF 后，还需确认 VF 是否具有 IOMMU 组：

```bash
readlink -f /sys/bus/pci/devices/<vf-pci-address>/iommu_group
```

如果路径不存在，通常表示节点没有可用的 IOMMU 隔离，`vfio-pci` 或 PCI 直通场景不应继续。

节点内核还必须启用 VFIO 支持。至少确认 `vfio-pci` 模块可用：

```bash
lsmod | grep vfio
modprobe vfio-pci
```

要在节点重启后自动加载模块，请将其写入系统模块加载配置：

```bash
echo vfio-pci > /etc/modules-load.d/vfio-pci.conf
```

### 标记 SR-IOV 节点

`sriov-network-config-daemon` 默认仅调度标记为 `feature.node.kubernetes.io/sriov-capable=true` 的节点。在安装插件之前，标记实际具有 SR-IOV PF 的节点：

```bash
kubectl label node <node-name> feature.node.kubernetes.io/sriov-capable=true --overwrite
```

仅将此标签应用于将配置 VFs 的节点。没有此标签的节点不会运行 `sriov-network-config-daemon`，也不会获得相应的 `SriovNetworkNodeState`。

## 解决方案

### 安装插件

此功能作为 ACP 4.3 的一部分提供。插件包版本为 `sriov-network-plugin v4.3.8`。从 AC 应用市场下载插件包，将其上传到目标 ACP 平台，然后从平台市场安装。

1. 登录到 AC 应用市场，搜索 `SR-IOV Network Plugin` 或 `sriov-network-plugin`。
2. 选择与平台版本 `v4.3` 兼容且插件版本为 `v4.3.8` 的包。
3. 下载与目标平台架构匹配的 `sriov-network-plugin.*.v4.3.8.tgz` 包。
4. 按照 ACP 用户指南中的 [集群插件](https://docs.alauda.cn/container_platform/4.3/extend/cluster_plugin) 指示上传包并在目标业务集群中安装 `sriov-network-plugin v4.3.8`。

通过 ACP 市场安装时，SR-IOV 组件默认部署在 `cpaas-system` 命名空间中。

### 确认 Multus 基础

SR-IOV 网络通过 Multus 作为次要网络附加到 DPDK/CNF Pods 或 KubeVirt VMs。在配置 SR-IOV 网络之前，请在 **平台管理 -> 市场 -> 集群插件** 中确认目标业务集群中已安装 Multus CNI。如果未安装，请按照产品文档中关于 [多个网络](https://docs.alauda.cn/container_platform/4.3/configure/networking/how_to/kube_ovn/multiple_networks) 的“安装 Multus CNI”部分进行操作。SR-IOV 插件处理节点侧的 VF 编排、SR-IOV CNI 安装和 SR-IOV 相关的 NAD 生成。它不会替代 Multus 元 CNI。

安装后，确认操作员和配置守护进程正在运行：

```bash
kubectl get pods -n cpaas-system | grep sriov-network
```

至少，以下工作负载应为 `Running`：

```text
sriov-network-operator-xxxxx          1/1     Running
sriov-network-config-daemon-xxxxx     1/1     Running
```

如果 `sriov-network-config-daemon` 不可见，请首先确认目标节点已标记为 `feature.node.kubernetes.io/sriov-capable=true`。

### 确认节点上的 SR-IOV PF

PF 是节点上的物理 NIC。VF 是从 PF 创建并分配给 Pod 或 VM 的虚拟 PCI NIC。

首先列出操作员同步的节点状态，并从 `NAME` 列中选择目标节点：

```bash
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n cpaas-system
```

如果列表中缺少具有 SR-IOV NIC 的节点，请首先检查该节点是否具有 `feature.node.kubernetes.io/sriov-capable=true` 标签。配置守护进程仅在与此标签匹配的节点上收集 PF 状态。

如果需要快速的主机侧检查以确认物理 NIC 在查看操作员状态之前是否发布 SR-IOV 功能，请检查 PF 的 PCI 功能。将 `af:00.3` 替换为目标 PF PCI 地址：

```bash
lspci -s af:00.3 -vvv | grep -i capabilities
```

如果输出包含 `Single Root I/O Virtualization (SR-IOV)`，则物理 NIC 发布 SR-IOV 功能，例如：

```text
Capabilities: [160 v1] Single Root I/O Virtualization (SR-IOV)
```

此检查仅证明硬件暴露了 SR-IOV 功能。这并不意味着操作员已经支持该 NIC 或者 VFs 已经创建。继续进行驱动程序、白名单和 `SriovNetworkNodePolicy` 检查。

在具有 SR-IOV PF 的节点上，确认操作员发现物理 NIC：

```bash
kubectl get sriovnetworknodestate <node-name> -n cpaas-system \
  -o jsonpath='{range .status.interfaces[*]}{.name}{"\t"}{.pciAddress}{"\t"}{.vendor}{"\t"}{.deviceID}{"\n"}{end}'
```

输出格式为 `<PF name> <PCI address> <vendor ID> <device ID>`，例如：

```text
p1p1    0000:3d:00.0    19e5    1822
```

记录要使用的 PF 名称，例如 `p1p1`。稍后，`SriovNetworkNodePolicy` 指定目标节点、PF 名称、VF 数量、`resourceName` 和 `deviceType`。以下 DPDK/CNF Pod 和 KubeVirt VM 示例可以共享相同的策略。仅在工作负载需要独立的 VF 池时创建单独的策略。

### 可选：处理不在默认支持列表中的 NIC

如果 `sriov-network-config-daemon` 不断记录如下消息，则表示操作员正在运行，但 NIC PCI ID 不在默认支持列表中。操作员跳过该 PF：

```text
DiscoverSriovDevices(): unsupported device {"device": "0000:3d:00.0 -> driver: 'hinic' ... product: 'Hi1822 Family (4*25GE)'"}
IsSupportedModel(): found unsupported model {"vendorId:": "19e5", "deviceId:": "1822"}
```

将 NIC 添加到 `supported-nic-ids` 白名单中。插件 `v4.3.8` 支持从安装或升级表单配置额外的 NIC，因此用户无需手动编写图表值。在 **平台管理 -> 市场 -> 集群插件** 中安装或升级 `sriov-network-plugin` 时，在 **额外支持的 SR-IOV NICs** 表中添加一行，并填写现场确认的 PCI ID：

| 字段        | 描述                                     | 示例         |
| ------------ | ----------------------------------------------- | --------------- |
| 名称         | 自定义 NIC 名称，仅用作白名单键 | `Huawei_Hi1822` |
| 供应商 ID    | PF 的 PCI 供应商 ID                         | `19e5`          |
| PF 设备 ID | PF 的 PCI 设备 ID                         | `1822`          |
| VF 设备 ID | VF 的 PCI 设备 ID                         | `375e`          |

这些示例值仅显示所需字段格式。它们并不意味着 Huawei Hi1822 是默认内置的。NIC 型号和 VF 设备 ID 在客户环境之间可能有所不同，因此请使用现场的 `lspci` 输出作为真实来源。

如果 VF 设备 ID 不明，请在维护窗口期间暂时创建一个 VF 并检查它。在以下示例中，`0000:3d:00.0` 是 PF PCI 地址：

```bash
echo 1 > /sys/bus/pci/devices/0000:3d:00.0/sriov_numvfs
readlink -f /sys/bus/pci/devices/0000:3d:00.0/virtfn0
lspci -Dnn -s <vf-pci-address>
```

读取结果时，使用 `lspci -Dnn` 输出中的 `<vendor>:<device>` 对。例如：

```text
0000:3d:01.0 Ethernet controller [0200]: Huawei Technologies Co., Ltd. Hi1822 Family Virtual Function [19e5:375e] (rev 45)
```

在这种情况下，`19e5` 是供应商 ID，`375e` 是应在表单中输入的 VF 设备 ID。

仅用于现场验证，您可以暂时修补已安装集群中的 ConfigMap，并重启操作员和配置守护进程：

```bash
kubectl patch cm supported-nic-ids -n cpaas-system --type merge -p \
  '{"data":{"Huawei_Hi1822":"19e5 1822 375e"}}'

kubectl rollout restart deployment/sriov-network-operator -n cpaas-system
kubectl rollout restart daemonset/sriov-network-config-daemon -n cpaas-system
```

此补丁在插件升级或重新安装时不会保留。请使用插件安装或升级表单进行长期配置。如果 `sriov_numvfs` 是手动写入以发现 VF ID，请在让操作员通过 `SriovNetworkNodePolicy` 管理 PF 之前清除手动创建的 VFs：

```bash
echo 0 > /sys/bus/pci/devices/<pf-pci-address>/sriov_numvfs
```

否则，配置守护进程可能会报告 PF 已经有未由 sriov 操作员创建的 VFs，并跳过部分变更流程。

### 配置并使用 DPDK/CNF Pods 的 SR-IOV VF

当 DPDK/CNF Pod 需要用户空间进程直接拥有 VF 时，将 `deviceType` 设置为 `vfio-pci`。在此模式下，VF 不作为 Pod 内的常规 Linux 网络接口使用。数据包处理和地址处理由应用程序拥有，成功通过容器中的 `/dev/vfio/<iommu-group>` 设备进行验证，而不是通过 `ip a` 中的次要接口，如 `net1`。

将以下内容保存为 `sriov-node-policy-pod.yaml`：

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
      - <pf-name>
  numVfs: 8
  deviceType: vfio-pci
  mtu: 1500
```

将 `<pf-name>` 替换为之前记录的 PF 名称，例如 `p1p1`。

应用策略：

```bash
kubectl apply -f sriov-node-policy-pod.yaml
```

确认 SR-IOV 设备插件资源出现在节点可分配资源中：

```bash
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.openshift\.io/sriov_vfio}{"\n"}'
```

如果输出为正整数，例如 `8`，则节点具有八个可调度的 `openshift.io/sriov_vfio` VFs。

如果资源在可分配中长时间未出现，请检查目标节点的同步状态和错误消息：

```bash
kubectl get sriovnetworknodestate <node-name> -n cpaas-system \
  -o jsonpath='{.status.syncStatus}{"\n"}{.status.lastSyncError}{"\n"}'
```

创建一个 `SriovNetwork`。操作员生成相应的 `NetworkAttachmentDefinition`。以下示例在应用程序命名空间 `default` 中创建 NAD。由于 VF 直接由 DPDK/CNF 应用程序拥有，因此不需要配置 Kube-OVN IPAM。

将以下内容保存为 `sriov-network-pod.yaml`：

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

在此示例中，操作员在 `default` 命名空间中生成名为 `pod-sriov-net` 的 NAD。如果应用程序 Pod 在另一个命名空间中运行，请一起更新 `SriovNetwork.spec.networkNamespace`、Pod `metadata.namespace` 和 Pod NAD 引用。

如果服务网络必须使用特定 VLAN，请在 `spec` 下添加 `vlan: <vlan-id>`。如果省略此字段，则网络为未标记。Pod 默认网络仍由 kube-ovn 提供，SR-IOV VF 作为 Multus 次要资源附加。

应用对象并确认 NAD 已生成：

```bash
kubectl apply -f sriov-network-pod.yaml
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n default pod-sriov-net
```

Pod 通过 `k8s.v1.cni.cncf.io/networks` 注释引用 NAD，并通过资源请求请求一个 `vfio-pci` SR-IOV VF。

将以下内容保存为 `sriov-pod.yaml`：

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
      image: <dpdk-cnf-image>
      resources:
        requests:
          openshift.io/sriov_vfio: "1"
        limits:
          openshift.io/sriov_vfio: "1"
```

`default/pod-sriov-net` 值使用 `<NAD namespace>/<NAD name>` 格式。`openshift.io/sriov_vfio` 对应于 `SriovNetworkNodePolicy.spec.resourceName` 和 `SriovNetwork.spec.resourceName`。

应用 Pod 并确认其已调度到具有 VF 资源的节点：

```bash
kubectl apply -f sriov-pod.yaml
kubectl get pod -n default sriov-pod -o wide
```

确认容器已接收到 VFIO 设备：

```bash
kubectl exec -n default sriov-pod -- ls -l /dev/vfio/
```

预期输出包括 `vfio` 控制设备和一个数字 IOMMU 组设备，例如：

```text
crw-------    1 root     root      234, 191 ... 191
crw-rw-rw-    1 root     root       10, 196 ... vfio
```

数字设备，例如 `191`，是当前 Pod 可用的 VFIO 组。

要确认 VF 驱动程序绑定状态，请在主机节点上运行 `dpdk-devbind.py -s`。当目标 VF 在 `使用 DPDK 兼容驱动程序的网络设备` 下出现，并且 `drv=vfio-pci`，则 VF 已绑定到 DPDK 兼容驱动程序：

```text
Network devices using DPDK-compatible driver
============================================
0000:3d:01.0 'Hi1822 Family Virtual Function 375e' numa_node=0 drv=vfio-pci unused=hinic
...
```

如果工作负载使用 Deployment、StatefulSet 或其他控制器，请在 Pod 模板 `metadata.annotations` 中设置 NAD 引用，并在应用程序容器的 `resources.requests` 和 `resources.limits` 中请求 `openshift.io/sriov_vfio`。DPDK 应用程序通常还需要 CPU、HugePages 和启动参数；确切值由业务镜像和应用程序文档决定。参考 Pod 片段为：

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

### 配置并使用 KubeVirt VMs 的 SR-IOV 网络

KubeVirt SR-IOV PCI 直通将 VF 作为 PCI 设备传递给 VM，因此它也使用 `deviceType: vfio-pci`。

如果已经存在 `resourceName: sriov_vfio` 的 `SriovNetworkNodePolicy`，则跳过此策略步骤，继续 VM 的 `SriovNetwork`。仅在没有可重用策略或 VM 需要独立 VF 池时创建以下策略。

将以下内容保存为 `sriov-node-policy-vm.yaml`：

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
      - <pf-name>
  numVfs: 8
  deviceType: vfio-pci
  mtu: 1500
```

将 `<pf-name>` 替换为之前记录的 PF 名称，例如 `p1p1`。

如果您创建了上述策略，请应用它并确认节点资源：

```bash
kubectl apply -f sriov-node-policy-vm.yaml
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.openshift\.io/sriov_vfio}{"\n"}'
```

创建一个 `SriovNetwork`。操作员生成相应的 `NetworkAttachmentDefinition`。以下示例在 VM 命名空间 `kubevirt` 中创建 NAD。如果 VF 后来由 VM 内的 DPDK 应用程序拥有，则不需要 Kube-OVN IPAM。

将以下内容保存为 `sriov-network-vm.yaml`：

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

在此示例中，操作员在 `kubevirt` 命名空间中生成名为 `vm-sriov-net` 的 NAD。如果 VM 在另一个命名空间中运行，请一起更新 `SriovNetwork.spec.networkNamespace`、VM `metadata.namespace` 和 VM NAD 引用。

如果服务网络必须使用特定 VLAN，请在 `spec` 下添加 `vlan: <vlan-id>`。如果省略此字段，则网络为未标记。VM 默认网络仍由 kube-ovn 提供，SR-IOV VF 作为 Multus 次要设备附加并传递给 VM。

应用对象并确认 NAD 已生成：

```bash
kubectl apply -f sriov-network-vm.yaml
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n kubevirt vm-sriov-net
```

VM 次要 NIC 在 VM 模板中配置两个地方：`spec.template.spec.domain.devices.interfaces` 定义 VM 看到的 NIC 类型，`spec.template.spec.networks` 定义 NIC 附加到哪个 Multus NAD。两个列表中的 `name` 值必须匹配。

将 `interfaces[].sriov` 和 `networks[].multus` 添加到 VM 模板中以附加 SR-IOV 次要 NIC。以下示例仅显示与网络和接口相关的字段：

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

在此示例中，VM 和 NAD 都位于 `kubevirt` 命名空间，因此 `networkName` 可以是 NAD 名称 `vm-sriov-net`。要引用另一个命名空间中的 NAD，请使用 `<namespace>/<name>` 格式。

创建 VM 后，确认 virt-launcher Pod 已调度到具有 VF 资源的节点，并检查 VMI 状态：

```bash
kubectl get vmi -n kubevirt sriov-vm
kubectl get pod -n kubevirt -l kubevirt.io=virt-launcher -o wide
```

在来宾操作系统内，确认传递的 SR-IOV VF 是否出现。是否将 VF 绑定到 DPDK、如何在 VM 内为 DPDK 应用程序分配 HugePages，以及如何配置 EAL 参数或服务进程由来宾操作系统和 DPDK 应用程序文档决定。
