---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.3'
---

# 如何在 ACP 上通过 Multus 和 SR-IOV 为 DPDK Pod 和 KubeVirt 虚拟机挂载高性能 VF

## 问题

用户在 Alauda Container Platform 4.3 上运行 DPDK/CNF Pod 或 KubeVirt 虚拟机，并希望通过 Multus 挂载宿主机 SR-IOV VF 作为高性能业务网卡或 PCI 直通设备。集群主 CNI 仍然可以是 kube-ovn；Multus 负责把辅助网络接入工作负载，SR-IOV Network Operator 负责发现 SR-IOV PF、创建 VF、通过 device plugin 暴露 VF 资源，并生成 Multus 使用的 `NetworkAttachmentDefinition`。

本文从用户使用路径说明如何在 ACP 4.3 上完成 Multus + SR-IOV 的 VF 接入：安装 `sriov-network-plugin`、确认 Multus/NAD 基座、配置 `SriovNetworkNodePolicy`、生成 `SriovNetwork`/NAD，并分别说明 DPDK/CNF Pod 和 KubeVirt 虚拟机如何使用 `vfio-pci` 类型的 SR-IOV VF。

## 环境

本文适用于以下组合：

| 组件 | 版本或说明 |
| --- | --- |
| Alauda Container Platform | 4.3 |
| 插件 | `sriov-network-plugin` |
| 插件包版本 | `sriov-network-plugin v4.3.3` |
| 上游基线 | `k8snetworkplumbingwg/sriov-network-operator:v1.6.0` |
| 部署命名空间 | `cpaas-system`（通过 ACP 市场安装时） |
| 主 CNI | 可使用 kube-ovn；SR-IOV 作为 Multus 辅助网络或 PCI 直通设备 |
| 多网卡基座 | ACP 已提供 Multus 能力，Pod 或虚拟机通过 NAD 引用 SR-IOV VF |

本文覆盖 SR-IOV L5 插件在 DPDK/CNF Pod 和 KubeVirt 虚拟机 VF 接入场景中的安装与使用；不覆盖 OVS-DPDK、Userspace CNI 或 DPDK 应用内部参数配置。

## 先决条件

### 节点和硬件

至少需要一个满足以下条件的 worker 节点：

- 节点上有支持 SR-IOV 的物理网卡 PF。
- BIOS 和操作系统已经启用 IOMMU，例如 Intel VT-d 或 AMD-Vi。
- PF 驱动支持创建 VF，并且该 PF 未被主 CNI 或 OVS 以不可释放方式占用。
- 节点内核已启用 VFIO 相关能力。至少确认 `vfio-pci` 模块可用：

```bash
lsmod | grep vfio
modprobe vfio-pci
```

如果需要节点重启后自动加载，可将模块写入系统模块加载配置：

```bash
echo vfio-pci > /etc/modules-load.d/vfio-pci.conf
```

## 解决方案

### 安装插件

该能力作为 ACP 4.3 新功能交付，插件包版本为 `sriov-network-plugin v4.3.3`。用户侧从 AC 应用市场获取插件包，再上传到目标 ACP 平台安装。

1. 登录 AC 应用市场，搜索 `SR-IOV 网络插件` 或 `sriov-network-plugin`。
2. 选择适配平台版本为 `v4.3`、插件版本为 `v4.3.3` 的安装包。
3. 下载与目标平台架构匹配的 `sriov-network-plugin.*.v4.3.3.tgz` 包。
4. 保持下载后的 `.tgz` 文件名不变。`violet` 会根据文件名解析插件名、架构和版本，重命名可能导致上传失败。
5. 将下载的插件包上传到目标 ACP 平台。

如果目标平台使用 `violet` 上传离线包，可以参考以下命令：

```bash
export PLATFORM_URL=""
export USERNAME=""
export PASSWORD=""
export CLUSTER_NAME=""
export PACKAGE_FILE="sriov-network-plugin.amd64.v4.3.3.tgz"

violet push "$PACKAGE_FILE" \
  --platform-address "$PLATFORM_URL" \
  --platform-username "$USERNAME" \
  --platform-password "$PASSWORD" \
  --clusters "$CLUSTER_NAME" \
  --target-catalog-source platform
```

上传完成后，进入 **管理员 -> 市场 -> 集群插件**，选择 `sriov-network-plugin` 的 `v4.3.3` 版本并安装到目标业务集群。通过 ACP 市场安装时，SR-IOV 组件默认部署在 `cpaas-system` 命名空间。

### 确认 Multus 基座可用

SR-IOV 网络通过 Multus 作为辅助网络接入 DPDK/CNF Pod 或 KubeVirt 虚拟机。安装 SR-IOV 插件前后，都应在 **管理员 -> 市场 -> 集群插件** 中确认目标业务集群已经安装 Multus CNI。如果尚未安装，先参考产品文档[多网络](https://docs.alauda.cn/container_platform/4.3/configure/networking/how_to/kube_ovn/multiple_networks) 中的“安装 Multus CNI”章节，再继续配置 SR-IOV 网络。SR-IOV 插件负责节点侧 VF 编排、SR-IOV CNI 安装和 SR-IOV 相关 NAD 生成，不替代 Multus 元 CNI。

安装后确认 operator 和 config-daemon 已运行：

```bash
kubectl get pods -n cpaas-system
```

预期至少看到以下工作负载处于 `Running`：

```text
sriov-network-operator-xxxxx          1/1     Running
sriov-network-config-daemon-xxxxx     1/1     Running
```

### 确认节点上的 SR-IOV PF

PF 是节点上的物理网卡，VF 是从 PF 创建出来并分配给 Pod 或虚拟机使用的虚拟 PCI 网卡。

先查看 operator 已同步的节点状态，并从输出的 `NAME` 选择目标节点：

```bash
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n cpaas-system
```

在带 SR-IOV PF 的节点上，确认 operator 能发现物理网卡：

```bash
kubectl get sriovnetworknodestate <node-name> -n cpaas-system \
  -o jsonpath='{range .status.interfaces[*]}{.name}{"\t"}{.pciAddress}{"\t"}{.vendor}{"\t"}{.deviceID}{"\t"}{.totalVfs}{"\n"}{end}'
```

operator 会自动发现节点上的 SR-IOV PF，并写入 `SriovNetworkNodeState.status.interfaces`；但不会自动决定在哪个 PF 上创建多少 VF、使用什么 `resourceName` 或 VF 类型。要创建 VF 并通过 device plugin 暴露资源，需要创建 `SriovNetworkNodePolicy`。

从 `status.interfaces[*].name` 输出中选择一个 PF，例如 `ens5f0`。`nodeSelector` 只匹配节点上已有的 label；先根据 `SriovNetworkNodeState` 确认有 SR-IOV PF 的节点，再使用该节点已有的稳定 label 限制策略作用范围。

后续 DPDK/CNF Pod 和 KubeVirt 虚拟机是两种使用示例。如果它们共用同一个 PF 和 `resourceName`，只需要创建一次 `SriovNetworkNodePolicy`；如果需要同时给不同业务分配独立 VF 池，应使用不同 PF，或规划不同的 `resourceName` 和 VF 数量。

### 为 DPDK/CNF Pod 配置并使用 SR-IOV VF

DPDK/CNF Pod 需要由用户态进程直接接管 VF 时，`deviceType` 使用 `vfio-pci`。这种模式下 VF 不作为 Pod 内的普通 Linux 网卡使用，业务报文处理和地址配置由容器内的 DPDK/CNF 应用负责。

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
      - ens5f0
  numVfs: 4
  deviceType: vfio-pci
  mtu: 1500
```

应用后观察节点同步状态：

```bash
kubectl apply -f sriov-node-policy-pod.yaml
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n cpaas-system
```

确认目标节点变为 `Succeeded`：

```bash
kubectl get sriovnetworknodestate <node-name> -n cpaas-system \
  -o jsonpath='{.status.syncStatus}{"\n"}{.status.lastSyncError}{"\n"}'
```

确认节点资源中出现 SR-IOV device plugin 暴露的资源：

```bash
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.openshift\.io/sriov_vfio}{"\n"}'
```

如果输出为正整数，说明 VF 已经被 device plugin 暴露给 Kubernetes 调度器。

记录目标 VF 的 PCI 地址，并确认该 VF 所在 IOMMU group 中没有混入不应直通给业务的其他设备：

```bash
VF_PCI_ADDR="<vf-pci-address>"
GROUP_PATH="$(readlink -f /sys/bus/pci/devices/$VF_PCI_ADDR/iommu_group)"
ls -l "$GROUP_PATH/devices"
```

如果同一个 group 内包含宿主机还需要使用的其他设备，不应直接将该 VF 用于 `vfio-pci`/PCI 直通场景，应先调整硬件、BIOS、内核 IOMMU 参数或网卡规划。

创建 `SriovNetwork`，由 operator 生成对应的 `NetworkAttachmentDefinition`。以下示例将 NAD 生成到业务命名空间 `default`。由于 VF 会被 DPDK/CNF 应用直接接管，这里不配置 kube-ovn IPAM。

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

上例中 operator 会在 `default` 命名空间生成名为 `pod-sriov-net` 的 NAD。如果业务 Pod 运行在其他命名空间，需要同时替换 `SriovNetwork.spec.networkNamespace`、Pod `metadata.namespace` 和 Pod 中的 NAD 引用。

如果业务网络需要接入指定 VLAN，可在 `spec` 中增加 `vlan: <vlan-id>`；不配置时使用未打标签网络。

Pod 的默认网络仍然使用 kube-ovn 主网络；SR-IOV VF 作为 Multus 辅助资源接入，并由 DPDK/CNF 应用使用。

应用后确认 NAD 已生成：

```bash
kubectl apply -f sriov-network-pod.yaml
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n default pod-sriov-net
```

Pod 通过 `k8s.v1.cni.cncf.io/networks` annotation 引用 NAD，并通过 resource request 申请一个 SR-IOV VF。以下示例将 Pod 的默认网络保留为 kube-ovn，同时申请一个 `vfio-pci` 类型的 SR-IOV VF 给 DPDK/CNF 应用使用。

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
      image: nginx:latest
      resources:
        requests:
          openshift.io/sriov_vfio: "1"
        limits:
          openshift.io/sriov_vfio: "1"
```

其中 `default/pod-sriov-net` 使用 `<NAD 命名空间>/<NAD 名称>` 格式；`openshift.io/sriov_vfio` 与 `SriovNetworkNodePolicy.spec.resourceName` 和 `SriovNetwork.spec.resourceName` 对应。

应用后确认 Pod 被调度到有 VF 资源的节点：

```bash
kubectl apply -f sriov-pod.yaml
kubectl get pod -n default sriov-pod -o wide
```

如果业务使用 Deployment、StatefulSet 等控制器，在 Pod template 的 `metadata.annotations` 中设置 `k8s.v1.cni.cncf.io/networks`，并在业务容器的 `resources.requests` 和 `resources.limits` 中申请 `openshift.io/sriov_vfio`。VF 资源只负责把 PCI 设备分配给 Pod；DPDK 应用通常还需要 CPU、HugePages 和启动参数等配置，具体取值由业务镜像和 DPDK 应用文档决定。参考配置片段如下：

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

### 为 KubeVirt 虚拟机配置并使用 SR-IOV 网络

KubeVirt SR-IOV PCI 直通场景需要把 VF 作为 PCI 设备传递给虚拟机，因此 `deviceType` 使用 `vfio-pci`。

如果已经为同一个 PF 创建过 `resourceName: sriov_vfio` 的 `SriovNetworkNodePolicy`，可直接继续创建虚拟机使用的 `SriovNetwork`。如果虚拟机需要使用独立 VF 池，再创建单独的 policy。

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
      - ens5f0
  numVfs: 4
  deviceType: vfio-pci
  mtu: 1500
```

应用后观察节点同步状态：

```bash
kubectl apply -f sriov-node-policy-vm.yaml
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n cpaas-system
```

确认节点资源中出现 SR-IOV device plugin 暴露的资源：

```bash
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.openshift\.io/sriov_vfio}{"\n"}'
```

如果前面没有检查过目标 VF 的 IOMMU group，在继续创建虚拟机使用的 `SriovNetwork` 前，先完成同样的 IOMMU group 检查。

创建 `SriovNetwork`，由 operator 生成对应的 `NetworkAttachmentDefinition`。以下示例将 NAD 生成到虚拟机所在命名空间 `kubevirt`。如果该 VF 后续由虚拟机内的 DPDK 应用接管，不需要在这里配置 kube-ovn IPAM。

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

上例中 operator 会在 `kubevirt` 命名空间生成名为 `vm-sriov-net` 的 NAD。如果虚拟机运行在其他命名空间，需要同时替换 `SriovNetwork.spec.networkNamespace`、VM `metadata.namespace` 和 VM 中的 NAD 引用。

如果业务网络需要接入指定 VLAN，可在 `spec` 中增加 `vlan: <vlan-id>`；不配置时使用未打标签网络。

KubeVirt 虚拟机的默认网络仍然使用 kube-ovn 主网络；SR-IOV VF 作为 Multus 辅助设备直通给虚拟机。

应用后确认 NAD 已生成：

```bash
kubectl apply -f sriov-network-vm.yaml
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n kubevirt vm-sriov-net
```

虚拟机辅助网卡配置在 VM 模板的两处：`spec.template.spec.domain.devices.interfaces` 定义虚拟机内看到的网卡类型，`spec.template.spec.networks` 定义这张网卡连接到哪个 Multus NAD。两处的 `name` 必须一致。

在 VM 模板中同时增加 `interfaces[].sriov` 和 `networks[].multus`，即可为虚拟机挂载 SR-IOV 辅助网卡。以下示例只展示网络和接口相关字段：

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

上例中 VM 和 NAD 都在 `kubevirt` 命名空间，因此 `networkName` 可以只写 NAD 名称 `vm-sriov-net`。如果引用其他命名空间的 NAD，使用 `<namespace>/<name>` 格式。

创建 VM 后，确认 virt-launcher Pod 被调度到有 VF 资源的节点，并检查 VMI 状态：

```bash
kubectl get vmi -n kubevirt sriov-vm
kubectl get pod -n kubevirt -l kubevirt.io=virt-launcher -o wide
```

进入虚拟机操作系统后，确认出现直通的 SR-IOV VF。后续是否把该 VF 绑定给 DPDK、如何在虚拟机内部为 DPDK 应用分配 HugePages、如何配置 EAL 参数和业务进程，由虚拟机内的业务系统和 DPDK 应用文档决定。
