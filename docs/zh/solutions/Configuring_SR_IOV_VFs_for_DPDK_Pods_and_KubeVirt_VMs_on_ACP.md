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
| 插件包版本 | `sriov-network-plugin v4.3.8` |
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
- PF 驱动支持创建 VF，且 PF 未被主 CNI 或 OVS 占用到无法配置 VF。

在节点上可以通过以下方式确认 IOMMU 已启用：

```bash
cat /proc/cmdline
dmesg | grep -Ei 'DMAR|IOMMU|AMD-Vi'
```

`/proc/cmdline` 中通常应包含 `intel_iommu=on` 或 `amd_iommu=on` 等参数；`dmesg` 中应能看到 IOMMU 初始化相关日志。创建 VF 后，还可以确认 VF 存在 IOMMU group：

```bash
readlink -f /sys/bus/pci/devices/<vf-pci-address>/iommu_group
```

如果该路径不存在，通常表示当前节点没有可用的 IOMMU 隔离，`vfio-pci`/PCI 直通场景不应继续配置。

节点内核还需要启用 VFIO 相关能力。至少确认 `vfio-pci` 模块可用：

```bash
lsmod | grep vfio
modprobe vfio-pci
```

如果需要节点重启后自动加载，可将模块写入系统模块加载配置：

```bash
echo vfio-pci > /etc/modules-load.d/vfio-pci.conf
```

### 标记 SR-IOV 节点

`sriov-network-config-daemon` 默认只调度到带有 `feature.node.kubernetes.io/sriov-capable=true` 标签的节点。安装插件前，先给实际带 SR-IOV PF 的节点打标签：

```bash
kubectl label node <node-name> feature.node.kubernetes.io/sriov-capable=true --overwrite
```

只给计划配置 VF 的节点打这个标签。没有该标签的节点不会运行 `sriov-network-config-daemon`，也不会生成对应的 `SriovNetworkNodeState`。

## 解决方案

### 安装插件

该能力作为 ACP 4.3 新功能交付，插件包版本为 `sriov-network-plugin v4.3.8`。先从 AC 应用市场下载插件包，再上传到目标 ACP 平台安装。

1. 登录 AC 应用市场，搜索 `SR-IOV 网络插件` 或 `sriov-network-plugin`。
2. 选择适配平台版本为 `v4.3`、插件版本为 `v4.3.8` 的安装包。
3. 下载与目标平台架构匹配的 `sriov-network-plugin.*.v4.3.8.tgz` 包。
4. 按照 ACP 用户手册中的[集群插件](https://docs.alauda.cn/container_platform/4.3/extend/cluster_plugin)说明上传插件包，并将 `sriov-network-plugin v4.3.8` 安装到目标业务集群。

通过 ACP 市场安装时，SR-IOV 组件默认部署在 `cpaas-system` 命名空间。

### 确认 Multus 基座可用

SR-IOV 网络通过 Multus 作为辅助网络接入 DPDK/CNF Pod 或 KubeVirt 虚拟机。配置 SR-IOV 网络之前，先在 **平台管理 -> 市场 -> 集群插件** 中确认目标业务集群已经安装 Multus CNI。如果尚未安装，先参考产品文档[多网络](https://docs.alauda.cn/container_platform/4.3/configure/networking/how_to/kube_ovn/multiple_networks) 中的“安装 Multus CNI”章节。SR-IOV 插件负责节点侧 VF 编排、SR-IOV CNI 安装和 SR-IOV 相关 NAD 生成，不替代 Multus 元 CNI。

安装后确认 operator 和 config-daemon 已运行：

```bash
kubectl get pods -n cpaas-system | grep sriov-network
```

预期至少看到以下工作负载处于 `Running`：

```text
sriov-network-operator-xxxxx          1/1     Running
sriov-network-config-daemon-xxxxx     1/1     Running
```

如果看不到 `sriov-network-config-daemon`，先确认目标节点已经带有 `feature.node.kubernetes.io/sriov-capable=true` 标签。

### 确认节点上的 SR-IOV PF

PF 是节点上的物理网卡，VF 是从 PF 创建出来并分配给 Pod 或虚拟机使用的虚拟 PCI 网卡。

先查看 operator 已同步的节点状态，并从输出的 `NAME` 列中选择目标节点：

```bash
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n cpaas-system
```

如果带 SR-IOV 网卡的节点没有出现在列表中，先检查该节点是否已经打上 `feature.node.kubernetes.io/sriov-capable=true` 标签；config-daemon 只会在该标签匹配的节点上采集 PF 状态。

如果需要先在宿主机侧快速判断某张物理网卡是否具备 SR-IOV 能力，可以直接查看该 PF 的 PCI capability。以下命令中，`af:00.3` 替换为目标 PF 的 PCI 地址：

```bash
lspci -s af:00.3 -vvv | grep -i capabilities
```

如果输出中包含 `Single Root I/O Virtualization (SR-IOV)`，说明这张物理网卡声明了 SR-IOV capability，例如：

```text
Capabilities: [160 v1] Single Root I/O Virtualization (SR-IOV)
```

这个检查只说明硬件具备 SR-IOV capability，不等于 operator 已经支持或已经创建出 VF；后续仍需继续确认 driver、白名单和 `SriovNetworkNodePolicy` 配置。

在带 SR-IOV PF 的节点上，确认 operator 能发现物理网卡：

```bash
kubectl get sriovnetworknodestate <node-name> -n cpaas-system \
  -o jsonpath='{range .status.interfaces[*]}{.name}{"\t"}{.pciAddress}{"\t"}{.vendor}{"\t"}{.deviceID}{"\n"}{end}'
```

输出格式为 `<PF 名称> <PCI 地址> <vendor ID> <device ID>`，例如：

```text
p1p1    0000:3d:00.0    19e5    1822
```

记录要使用的 PF 名称，例如 `p1p1`。后续创建 `SriovNetworkNodePolicy` 时，会在 policy 中指定目标节点、PF 名称、VF 数量、`resourceName` 和 `deviceType`。DPDK/CNF Pod 和 KubeVirt 虚拟机示例可以共用同一个 policy；只有需要独立 VF 池时，才需要创建不同的 policy。

### 处理不在默认支持列表中的网卡（可选）

如果 `sriov-network-config-daemon` 日志持续出现类似以下信息，说明 operator 已经运行，但该网卡的 PCI ID 不在默认支持列表中，operator 会跳过该 PF：

```text
DiscoverSriovDevices(): unsupported device {"device": "0000:3d:00.0 -> driver: 'hinic' ... product: 'Hi1822 Family (4*25GE)'"}
IsSupportedModel(): found unsupported model {"vendorId:": "19e5", "deviceId:": "1822"}
```

这类场景需要把网卡加入 `supported-nic-ids` 白名单。插件 `v4.3.8` 支持通过安装或升级表单配置额外网卡，不需要手工编写 chart values。在 **平台管理 -> 市场 -> 集群插件** 中安装或升级 `sriov-network-plugin` 时，在“额外支持的 SR-IOV 网卡”表格中新增一行，并按现场确认的 PCI ID 填写：

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| 名称 | 自定义网卡名称，只用于生成白名单键名 | `Huawei_Hi1822` |
| Vendor ID | PF 的 PCI vendor ID | `19e5` |
| PF Device ID | PF 的 PCI device ID | `1822` |
| VF Device ID | VF 的 PCI device ID | `375e` |

以上示例只说明字段格式，不表示插件默认内置 Huawei Hi1822。不同客户环境的网卡型号和 VF device ID 可能不同，应以现场 `lspci` 输出为准。

如果还不知道 VF device ID，可以在维护窗口中临时创建 1 个 VF 后查看。以下示例中的 `0000:3d:00.0` 是 PF 的 PCI 地址：

```bash
echo 1 > /sys/bus/pci/devices/0000:3d:00.0/sriov_numvfs
readlink -f /sys/bus/pci/devices/0000:3d:00.0/virtfn0
lspci -Dnn -s <vf-pci-address>
```

判断时以 `lspci -Dnn` 输出中方括号内的 `<vendor>:<device>` 为准。例如：

```text
0000:3d:01.0 Ethernet controller [0200]: Huawei Technologies Co., Ltd. Hi1822 Family Virtual Function [19e5:375e] (rev 45)
```

其中 `19e5` 是 vendor ID，`375e` 才是要填写到表单中的 VF Device ID。

仅在现场验证时，可以临时 patch 已安装集群中的 ConfigMap，并重启 operator 和 config-daemon：

```bash
kubectl patch cm supported-nic-ids -n cpaas-system --type merge -p \
  '{"data":{"Huawei_Hi1822":"19e5 1822 375e"}}'

kubectl rollout restart deployment/sriov-network-operator -n cpaas-system
kubectl rollout restart daemonset/sriov-network-config-daemon -n cpaas-system
```

这种 patch 在插件升级或重装后可能丢失；长期配置应使用插件安装或升级表单。若为了查看 VF ID 手动写过 `sriov_numvfs`，在让 operator 通过 `SriovNetworkNodePolicy` 接管前，先清理手工创建的 VF：

```bash
echo 0 > /sys/bus/pci/devices/<pf-pci-address>/sriov_numvfs
```

否则 config-daemon 可能提示该 PF 已有 VF 但不是由 sriov operator 创建，并跳过部分变更流程。

### 为 DPDK/CNF Pod 配置并使用 SR-IOV VF

DPDK/CNF Pod 需要由用户态进程直接接管 VF 时，`deviceType` 使用 `vfio-pci`。这种模式下 VF 不作为 Pod 内的普通 Linux 网卡使用，业务报文处理和地址配置由容器内应用负责；成功标准是容器内出现 `/dev/vfio/<iommu-group>` 设备，而不是 `ip a` 出现 `net1`。

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

将 `<pf-name>` 替换为前面记录的 PF 名称，例如 `p1p1`。

应用 policy：

```bash
kubectl apply -f sriov-node-policy-pod.yaml
```

确认节点资源中出现 SR-IOV device plugin 暴露的资源：

```bash
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.openshift\.io/sriov_vfio}{"\n"}'
```

如果输出为正整数，例如 `8`，说明当前节点有 8 个可调度的 `openshift.io/sriov_vfio` VF。

如果资源长时间未出现在 allocatable 中，再查看目标节点的同步状态和错误信息：

```bash
kubectl get sriovnetworknodestate <node-name> -n cpaas-system \
  -o jsonpath='{.status.syncStatus}{"\n"}{.status.lastSyncError}{"\n"}'
```

创建 `SriovNetwork`，由 operator 生成对应的 `NetworkAttachmentDefinition`。以下示例将 NAD 生成到业务命名空间 `default`；VF 由 DPDK/CNF 应用直接接管，因此这里不配置 kube-ovn IPAM。

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

如果业务网络需要接入指定 VLAN，可在 `spec` 中增加 `vlan: <vlan-id>`；不配置时流量不携带 VLAN tag（untagged）。Pod 的默认网络仍由 kube-ovn 提供，SR-IOV VF 作为 Multus 辅助资源接入。

应用后确认 NAD 已生成：

```bash
kubectl apply -f sriov-network-pod.yaml
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n default pod-sriov-net
```

Pod 通过 `k8s.v1.cni.cncf.io/networks` annotation 引用 NAD，并通过 resource request 申请一个 `vfio-pci` 类型的 SR-IOV VF。

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

其中 `default/pod-sriov-net` 使用 `<NAD 命名空间>/<NAD 名称>` 格式；`openshift.io/sriov_vfio` 与 `SriovNetworkNodePolicy.spec.resourceName` 和 `SriovNetwork.spec.resourceName` 对应。

应用后确认 Pod 被调度到有 VF 资源的节点：

```bash
kubectl apply -f sriov-pod.yaml
kubectl get pod -n default sriov-pod -o wide
```

确认容器内已经拿到 VFIO 设备：

```bash
kubectl exec -n default sriov-pod -- ls -l /dev/vfio/
```

预期至少看到 `vfio` 控制设备和一个数字命名的 IOMMU group 设备，例如：

```text
crw-------    1 root     root      234, 191 ... 191
crw-rw-rw-    1 root     root       10, 196 ... vfio
```

其中数字设备（如 `191`）表示当前 Pod 可用的 VFIO group。

如需辅助确认 VF 驱动绑定状态，可在宿主机节点上运行 `dpdk-devbind.py -s`。当目标 VF 出现在 `Network devices using DPDK-compatible driver` 区域，且显示 `drv=vfio-pci` 时，表示该 VF 已绑定到 DPDK 兼容驱动：

```text
Network devices using DPDK-compatible driver
============================================
0000:3d:01.0 'Hi1822 Family Virtual Function 375e' numa_node=0 drv=vfio-pci unused=hinic
...
```

如果业务使用 Deployment、StatefulSet 等控制器，在 Pod template 的 `metadata.annotations` 中设置 NAD 引用，并在业务容器的 `resources.requests` 和 `resources.limits` 中申请 `openshift.io/sriov_vfio`。DPDK 应用通常还需要 CPU、HugePages 和启动参数等配置，具体取值由业务镜像和应用文档决定。参考配置片段如下：

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

KubeVirt SR-IOV PCI 直通场景需要把 VF 作为 PCI 设备传递给虚拟机，因此同样使用 `deviceType: vfio-pci`。

如果同一个 PF 已经有 `resourceName: sriov_vfio` 的 `SriovNetworkNodePolicy`，跳过本段，直接创建虚拟机使用的 `SriovNetwork`。只有没有可复用 policy，或虚拟机需要独立 VF 池时，才创建以下 policy。

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

将 `<pf-name>` 替换为前面记录的 PF 名称，例如 `p1p1`。

如果创建了上述 policy，应用并确认节点资源：

```bash
kubectl apply -f sriov-node-policy-vm.yaml
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.openshift\.io/sriov_vfio}{"\n"}'
```

创建 `SriovNetwork`，由 operator 生成对应的 `NetworkAttachmentDefinition`。以下示例将 NAD 生成到虚拟机所在命名空间 `kubevirt`；如果 VF 后续由虚拟机内的 DPDK 应用接管，这里不配置 kube-ovn IPAM。

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

如果业务网络需要接入指定 VLAN，可在 `spec` 中增加 `vlan: <vlan-id>`；不配置时流量不携带 VLAN tag（untagged）。虚拟机默认网络仍由 kube-ovn 提供，SR-IOV VF 作为 Multus 辅助设备直通给虚拟机。

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
