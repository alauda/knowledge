---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.3'
---

# 如何在 ACP 上通过 Multus 和 SR-IOV 为业务 Pod 和 KubeVirt 虚拟机提供高性能辅助网卡

## 问题

用户在 Alauda Container Platform 4.3 上运行 KubeVirt 虚拟机或容器化网络功能（CNF），并希望通过 Multus 给业务 Pod 或虚拟机挂载宿主机 SR-IOV VF 作为高性能辅助网卡。集群主 CNI 仍然可以是 kube-ovn；Multus 负责把辅助网络接入工作负载，SR-IOV Network Operator 负责发现 SR-IOV PF、创建 VF、通过 device plugin 暴露 VF 资源，并生成 Multus 使用的 `NetworkAttachmentDefinition`。

本文从用户使用路径说明如何在 ACP 4.3 上完成 Multus + SR-IOV 的端到端接入：安装 `sriov-network-plugin`、确认 Multus/NAD 基座、配置 `SriovNetworkNodePolicy`、生成 `SriovNetwork`/NAD，并分别完成无 SR-IOV 网卡环境下的控制面验证，以及有 SR-IOV 网卡环境下的 Pod 和 KubeVirt 虚拟机数据面验证。

## 环境

本文适用于以下组合：

| 组件 | 版本或说明 |
| --- | --- |
| Alauda Container Platform | 4.3 |
| 插件 | `sriov-network-plugin` |
| 插件包版本 | `sriov-network-plugin v4.3.1` |
| 上游基线 | `k8snetworkplumbingwg/sriov-network-operator:v1.6.0` |
| 部署命名空间 | `cpaas-system`（通过 ACP 市场安装时） |
| 主 CNI | 可使用 kube-ovn；SR-IOV 作为 Multus 辅助网络 |
| 多网卡基座 | ACP 已提供 Multus 能力，业务通过 NAD 引用 SR-IOV 辅助网络 |

ACP 打包版本启用 SR-IOV CNI 路径，用于完成 SR-IOV VF 编排和 Multus 辅助网络接入。

本文覆盖 SR-IOV L5 插件在 KubeVirt 虚拟机辅助网卡场景中的安装与使用；不覆盖 OVS-DPDK、Userspace CNI 或容器内 DPDK 应用的配置。

## 先决条件

### 节点和硬件

如果只验证插件控制面，可以没有 SR-IOV 网卡。如果要完成 VF 和虚拟机数据面验证，至少需要一个满足以下条件的 worker 节点：

- 节点上有支持 SR-IOV 的物理网卡 PF。
- BIOS 和操作系统已经启用 IOMMU，例如 Intel VT-d 或 AMD-Vi。
- PF 驱动支持创建 VF，并且该 PF 未被主 CNI 或 OVS 以不可释放方式占用。

## 解决方案

### 安装插件

该能力作为 ACP 4.3 新功能交付，插件包版本为 `sriov-network-plugin v4.3.1`。用户侧从 AC 应用市场获取插件包，再上传到目标 ACP 平台安装。

1. 登录 AC 应用市场，搜索 `SR-IOV 网络插件` 或 `sriov-network-plugin`。
2. 选择适配平台版本为 `v4.3`、插件版本为 `v4.3.1` 的安装包。
3. 下载与目标平台架构匹配的包。amd64 平台下载 `sriov-network-plugin.amd64.v4.3.1.tgz`，arm64 平台下载 `sriov-network-plugin.arm64.v4.3.1.tgz`；如果平台不需要区分架构，再下载 `sriov-network-plugin.ALL.v4.3.1.tgz`。
4. 保持下载后的 `.tgz` 文件名不变。`violet` 会根据文件名解析插件名、架构和版本，重命名可能导致上传失败。
5. 将下载的插件包上传到目标 ACP 平台。

如果目标平台使用 `violet` 上传离线包，可以参考以下命令：

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

上传完成后，进入 **管理员 -> 市场 -> 集群插件**，选择 `sriov-network-plugin` 的 `v4.3.1` 版本并安装到目标业务集群。通过 ACP 市场安装时，SR-IOV 组件默认部署在 `cpaas-system` 命名空间。

### 确认 Multus 基座可用

SR-IOV 网络通过 Multus 作为辅助网卡接入 Pod 或 KubeVirt 虚拟机。安装 SR-IOV 插件前后，都应在 **管理员 -> 市场 -> 集群插件** 中确认目标业务集群已经安装 Multus CNI。如果尚未安装，先参考产品文档[安装 Multus CNI](https://docs.alauda.cn/container_platform/4.3/configure/networking/how_to/kube_ovn/multiple_networks#%E5%AE%89%E8%A3%85-multus-cni)，再继续配置 SR-IOV 网络。SR-IOV 插件负责节点侧 VF 编排、SR-IOV CNI 安装和 SR-IOV 相关 NAD 生成，不替代 Multus 元 CNI。

安装后确认 operator 和 config-daemon 已运行：

```bash
kubectl get pods -n cpaas-system
```

预期至少看到以下工作负载处于 `Running`：

```text
sriov-network-operator-xxxxx          1/1     Running
sriov-network-config-daemon-xxxxx     1/1     Running
```

### 无 SR-IOV 网卡环境的控制面验证

如果当前环境没有 SR-IOV 网卡，验证目标是证明插件可以正常部署，并且 operator 可以同步节点状态。

检查 `SriovNetworkNodeState`：

```bash
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n cpaas-system
```

查看具体节点状态：

```bash
kubectl get sriovnetworknodestate <node-name> -n cpaas-system \
  -o jsonpath='{.status.syncStatus}{"\n"}'
```

在无 SR-IOV 网卡环境中，`status.interfaces` 可能为空。只要 operator、config-daemon 和 `syncStatus` 正常，即可认为控制面 smoke 验证通过。

### 有 SR-IOV 网卡环境的 VF 验证

在带 SR-IOV PF 的节点上，先确认 operator 能发现物理网卡：

```bash
kubectl get sriovnetworknodestate <node-name> -n cpaas-system \
  -o jsonpath='{range .status.interfaces[*]}{.name}{"\t"}{.pciAddress}{"\t"}{.vendor}{"\t"}{.deviceID}{"\t"}{.totalVfs}{"\n"}{end}'
```

operator 会自动发现节点上的 SR-IOV PF，并写入 `SriovNetworkNodeState.status.interfaces`；但不会自动决定在哪个 PF 上创建多少 VF、使用什么 `resourceName` 或 VF 类型。要创建 VF 并通过 device plugin 暴露资源，需要创建 `SriovNetworkNodePolicy`。

选择一个 PF，例如 `ens5f0`，创建 `SriovNetworkNodePolicy`。`nodeSelector` 只匹配节点上已有的 label；先根据 `SriovNetworkNodeState` 确认有 SR-IOV PF 的节点，再使用该节点已有的稳定 label 限制策略作用范围。以下示例使用 `kubernetes.io/hostname` 选中单个节点，创建 4 个 VF，并通过 device plugin 暴露名为 `sriov_vf` 的资源：

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

`deviceType: vfio-pci` 用于 KubeVirt SR-IOV PCI 直通场景。operator 会根据该策略配置 VF 驱动并通过 device plugin 暴露资源；不要在虚拟机内部对宿主机 VF 执行 `dpdk-devbind.py`。

应用后观察节点同步状态：

```bash
kubectl apply -f sriov-node-policy.yaml
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
  -o jsonpath='{.status.allocatable.openshift\.io/sriov_vf}{"\n"}'
```

如果输出为正整数，说明 VF 已经被 device plugin 暴露给 Kubernetes 调度器。

### 创建 SR-IOV 辅助网络

创建 `SriovNetwork`，由 operator 生成对应的 `NetworkAttachmentDefinition`。以下示例将 NAD 生成到业务命名空间 `kubevirt`，并使用 kube-ovn IPAM 给 SR-IOV 辅助网卡分配地址：

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

其中 `provider` 使用 `<NAD 名称>.<NAD 命名空间>.ovn` 格式。上例中 operator 会在 `kubevirt` 命名空间生成名为 `vm-sriov-net` 的 NAD，因此 provider 为 `vm-sriov-net.kubevirt.ovn`。

创建与该 provider 匹配的 Kube-OVN Subnet。`cidrBlock`、`gateway` 和 `excludeIps` 按业务网络规划调整：

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

KubeVirt 虚拟机的默认网络仍然使用 kube-ovn 主网络；SR-IOV 网络作为 Multus 辅助网卡接入，并通过上述 kube-ovn Subnet 完成辅助网卡 IPAM。

应用后确认 NAD 已生成：

```bash
kubectl apply -f sriov-network.yaml
kubectl apply -f sriov-subnet.yaml
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n kubevirt vm-sriov-net
```

查看 NAD 的有效 CNI 配置：

```bash
kubectl get network-attachment-definitions.k8s.cni.cncf.io vm-sriov-net -n kubevirt \
  -o jsonpath='{.spec.config}{"\n"}' | jq .
```

### 在 KubeVirt 虚拟机中使用 SR-IOV 网络

虚拟机可以通过 Multus 引用同一个 NAD。以下示例只展示网络和接口相关字段：

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

进入虚拟机操作系统后，确认出现额外网卡。kube-ovn Subnet 负责平台侧辅助网络地址分配；虚拟机内部是否能拿到该地址，还取决于 guest OS 中的 DHCP 客户端、cloud-init 或系统网络配置。
