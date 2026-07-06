---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.3.x'
---

# 如何在 ACP 上通过 Multus 和 SR-IOV 为业务 Pod 和 KubeVirt 虚拟机提供高性能辅助网卡

## 问题

用户在 Alauda Container Platform 4.3.x 上运行 KubeVirt 虚拟机或容器化网络功能（CNF），并希望通过 Multus 给业务 Pod 或虚拟机挂载宿主机 SR-IOV VF 作为高性能辅助网卡。集群主 CNI 仍然可以是 kube-ovn；Multus 负责把辅助网络接入工作负载，SR-IOV Network Operator 负责发现 SR-IOV PF、创建 VF、通过 device plugin 暴露 VF 资源，并生成 Multus 使用的 `NetworkAttachmentDefinition`。

本文从用户使用路径说明如何在 ACP 4.3.x 上完成 Multus + SR-IOV 的端到端接入：安装 `sriov-network-plugin`、确认 Multus/NAD 基座、配置 `SriovNetworkNodePolicy`、生成 `SriovNetwork`/NAD，并分别完成无 SR-IOV 网卡环境下的控制面验证，以及有 SR-IOV 网卡环境下的 Pod 和 KubeVirt 虚拟机数据面验证。

## 环境

本文适用于以下组合：

| 组件 | 版本或说明 |
| --- | --- |
| Alauda Container Platform | 4.3.x |
| 插件 | `sriov-network-plugin` |
| 插件包版本 | `sriov-network-plugin v4.3.x` |
| 上游基线 | `k8snetworkplumbingwg/sriov-network-operator:v1.6.0` |
| 部署命名空间 | `cpaas-system`（通过 ACP 市场安装时） |
| 主 CNI | 可使用 kube-ovn；SR-IOV 作为 Multus 辅助网络 |
| 多网卡基座 | ACP 已提供 Multus 能力，业务通过 NAD 引用 SR-IOV 辅助网络 |

ACP 打包版本只启用 SR-IOV CNI 路径。`config-daemon` 会通过 `sriov-cni` init container 将 SR-IOV CNI 二进制安装到节点 CNI bin 目录；`ib-sriov-cni`、`ovs-cni`、`rdma-cni` 镜像值为空，operator 渲染 `config-daemon` 时不会部署这些 init containers。

本方案交付的是 SR-IOV VF 编排和 Multus 辅助网络接入能力。DPDK 用户态数据面可以基于 SR-IOV VF 继续扩展，但还需要额外完成 VF 驱动绑定、HugePages、CPU 隔离、NUMA 规划、业务镜像适配和性能压测；这些不属于本插件包开箱即用能力。

## 先决条件

### 平台和权限

准备一个可管理目标集群的 kubeconfig，并确保当前用户可以创建以下资源：

- 命名空间、ServiceAccount、ClusterRole、ClusterRoleBinding
- CRD
- Deployment、DaemonSet
- `sriovnetwork.openshift.io` API 组下的自定义资源
- `k8s.cni.cncf.io/v1` 的 `NetworkAttachmentDefinition`

### 节点和硬件

如果只验证插件控制面，可以没有 SR-IOV 网卡。如果要完成 VF 和虚拟机数据面验证，至少需要一个满足以下条件的 worker 节点：

- 节点上有支持 SR-IOV 的物理网卡 PF。
- BIOS 和操作系统已经启用 IOMMU，例如 Intel VT-d 或 AMD-Vi。
- PF 驱动支持创建 VF，并且该 PF 未被主 CNI 或 OVS 以不可释放方式占用。
- 计划配置 VF 的节点可以进入维护窗口。创建 VF 或切换 VF 驱动可能触发节点 drain 或网络短暂中断。

给参与 SR-IOV 配置的节点打标签，后续 `SriovNetworkNodePolicy` 使用该标签限制作用范围：

```bash
kubectl label node <node-name> feature.node.kubernetes.io/sriov-capable=true
```

## 解决方案

### 安装插件

该能力作为 ACP 4.3.x 新功能交付，插件包版本为 `sriov-network-plugin v4.3.x`。用户侧从 AC 应用市场获取插件包，再上传到目标 ACP 平台安装。

1. 登录 AC 应用市场，搜索 `SR-IOV 网络插件` 或 `sriov-network-plugin`。
2. 选择适配平台版本为 `v4.3`、插件版本为 `v4.3.x` 的安装包。
3. 下载与目标平台架构匹配的包。amd64 平台下载 `sriov-network-plugin.amd64.v4.3.x.tgz`，arm64 平台下载 `sriov-network-plugin.arm64.v4.3.x.tgz`；如果平台不需要区分架构，再下载 `sriov-network-plugin.ALL.v4.3.x.tgz`。
4. 保持下载后的 `.tgz` 文件名不变。`violet` 会根据文件名解析插件名、架构和版本，重命名可能导致上传失败。
5. 将下载的插件包上传到目标 ACP 平台。

如果目标平台使用 `violet` 上传离线包，可以参考以下命令：

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

上传成功后，在 global 集群确认插件版本配置已经生成并可部署：

```bash
kubectl get moduleplugin sriov-network-plugin \
  -o jsonpath='{.status.latestVersion}{"\n"}'
kubectl get moduleconfig sriov-network-plugin-<version> \
  -o jsonpath='{.status.readyForDeploy}{"\n"}'
```

预期分别输出 `v4.3.x` 和 `true`。如果 `ModulePlugin` 存在但没有生成 `ModuleConfig`，或者 `ModuleConfig` 不是 `readyForDeploy=true`，说明插件包元数据不完整，常见原因是包内缺少 `ModulePlugin.spec.logo` 或平台安装配置 `scripts/plugin-config.yaml`，需要使用 AC 市场发布后的完整包重新上传。

上传完成后，进入 **管理员 -> 市场 -> 集群插件**，选择 `sriov-network-plugin` 并安装到目标业务集群。通过 ACP 市场安装时，SR-IOV 组件默认部署在 `cpaas-system` 命名空间。后续命令使用以下变量：

```bash
export SRIOV_NAMESPACE="cpaas-system"
```

安装前确认集群中没有历史手工安装的 SR-IOV 实例。如果曾经在 `sriov-network-operator` 等其他命名空间测试安装过，应先按原安装方式卸载旧实例，避免两个 operator 同时协调同一组 SR-IOV 自定义资源：

```bash
kubectl get pods -A | grep sriov-network
kubectl get sriovoperatorconfig -A
kubectl get sriovnetworknodestate -A
```

SR-IOV 节点守护进程需要使用 `hostNetwork`、`hostPID`、`hostPath` 和 privileged 容器。安装前，确认部署命名空间允许 privileged Pod Security Admission；如果标签缺失，可以补齐：

```bash
kubectl label namespace "$SRIOV_NAMESPACE" \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/audit=privileged \
  pod-security.kubernetes.io/warn=privileged \
  --overwrite
```

### 确认 Multus 基座可用

SR-IOV 网络通过 Multus 作为辅助网卡接入 Pod 或 KubeVirt 虚拟机。安装 SR-IOV 插件前后，都应确认集群已经具备 NAD CRD：

```bash
kubectl get crd network-attachment-definitions.k8s.cni.cncf.io
```

如果该 CRD 不存在，说明 Multus 基座尚未就绪，应先安装或启用 ACP 的 Multus 能力，再继续配置 SR-IOV 网络。SR-IOV 插件负责节点侧 VF 编排、SR-IOV CNI 安装和 SR-IOV 相关 NAD 生成，不替代 Multus 元 CNI。

安装后确认 operator 和 config-daemon 已运行：

```bash
kubectl get pods -n "$SRIOV_NAMESPACE"
```

预期至少看到以下工作负载处于 `Running`：

```text
sriov-network-operator-xxxxx          1/1     Running
sriov-network-config-daemon-xxxxx     1/1     Running
```

确认 CRD 已注册：

```bash
kubectl get crd | grep sriovnetwork.openshift.io
```

确认 `config-daemon` 只包含 `sriov-cni` init container，不包含 `ib-sriov-cni`、`ovs-cni`、`rdma-cni`：

```bash
kubectl get daemonset sriov-network-config-daemon -n "$SRIOV_NAMESPACE" \
  -o jsonpath='{range .spec.template.spec.initContainers[*]}{.name}{"\t"}{.image}{"\n"}{end}'
```

预期只出现类似输出：

```text
sriov-cni    build-harbor.alauda.cn/3rdparty/sriov/sriov-cni:v2.10.0
```

### 无 SR-IOV 网卡环境的控制面验证

如果当前环境没有 SR-IOV 网卡，验证目标是证明插件可以正常部署、CRD 可以注册、operator 可以同步节点状态，并且不会额外部署 `ovs-cni`、`rdma-cni`、`ib-sriov-cni`。

检查 `SriovNetworkNodeState`：

```bash
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n "$SRIOV_NAMESPACE"
```

查看具体节点状态：

```bash
kubectl get sriovnetworknodestate <node-name> -n "$SRIOV_NAMESPACE" \
  -o jsonpath='{.status.syncStatus}{"\n"}'
```

在无 SR-IOV 网卡环境中，`status.interfaces` 可能为空；这是硬件条件限制，不代表插件部署失败。只要 operator、config-daemon、CRD 和 `syncStatus` 正常，即可认为控制面 smoke 验证通过。

### 有 SR-IOV 网卡环境的 VF 验证

在带 SR-IOV PF 的节点上，先确认 operator 能发现物理网卡：

```bash
kubectl get sriovnetworknodestate <node-name> -n "$SRIOV_NAMESPACE" \
  -o jsonpath='{range .status.interfaces[*]}{.name}{"\t"}{.pciAddress}{"\t"}{.vendor}{"\t"}{.deviceID}{"\t"}{.totalVfs}{"\n"}{end}'
```

选择一个 PF，例如 `ens5f0`，创建 `SriovNetworkNodePolicy`。以下示例创建 4 个 VF，并通过 device plugin 暴露名为 `intel_sriov_netdevice` 的资源：

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

应用后观察节点同步状态：

```bash
kubectl apply -f sriov-node-policy.yaml
kubectl get sriovnetworknodestates.sriovnetwork.openshift.io \
  -n "$SRIOV_NAMESPACE"
```

确认目标节点变为 `Succeeded`：

```bash
kubectl get sriovnetworknodestate <node-name> -n "$SRIOV_NAMESPACE" \
  -o jsonpath='{.status.syncStatus}{"\n"}{.status.lastSyncError}{"\n"}'
```

确认节点资源中出现 SR-IOV device plugin 暴露的资源：

```bash
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.openshift\.io/intel_sriov_netdevice}{"\n"}'
```

如果输出为正整数，说明 VF 已经被 device plugin 暴露给 Kubernetes 调度器。

### 创建 SR-IOV 辅助网络

创建 `SriovNetwork`，由 operator 生成对应的 `NetworkAttachmentDefinition`。以下示例将 NAD 生成到业务命名空间 `kubevirt`：

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

应用后确认 NAD 已生成：

```bash
kubectl apply -f sriov-network.yaml
kubectl get network-attachment-definitions.k8s.cni.cncf.io -n kubevirt vm-sriov-net
```

查看 NAD 的有效 CNI 配置：

```bash
kubectl get network-attachment-definitions.k8s.cni.cncf.io vm-sriov-net -n kubevirt \
  -o jsonpath='{.spec.config}{"\n"}' | jq .
```

### 使用测试 Pod 验证 VF 分配

在业务命名空间创建测试 Pod，显式请求 SR-IOV 资源并引用 NAD：

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

确认 Pod 被调度到 SR-IOV 节点并进入 `Running`：

```bash
kubectl get pod sriov-test -n kubevirt -o wide
```

进入 Pod 检查辅助网卡：

```bash
kubectl exec -n kubevirt sriov-test -- ip link
kubectl exec -n kubevirt sriov-test -- ip addr
```

如果网络侧已经配置好二层或三层连通性，可以继续执行 ping 或业务流量验证：

```bash
kubectl exec -n kubevirt sriov-test -- ping -c 3 192.168.100.1
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

创建 VM 后，确认 virt-launcher Pod 被调度到有 VF 资源的节点，并检查 VMI 状态：

```bash
kubectl get vmi -n kubevirt sriov-vm
kubectl get pod -n kubevirt -l kubevirt.io=virt-launcher -o wide
```

进入虚拟机操作系统后，确认出现额外网卡，并按业务网络规划配置 IP 或使用 DHCP 获取地址。

### 与 DPDK 的关系和边界

上游 `sriov-cni` 可用于给工作负载分配 SR-IOV VF；VF 进一步绑定到 `vfio-pci` 等用户态驱动后，可以作为 DPDK 数据面的一部分使用。因此，本方案是 DPDK 高性能网络链路中的 SR-IOV 接入基础，但并不等同于完整 DPDK 方案。

如果客户业务明确要求 DPDK，需要在本方案之外继续确认并验证以下内容：

- 节点 BIOS、IOMMU、VFIO 驱动、HugePages、CPU 隔离和 NUMA 亲和性。
- VF 是使用内核 `netdevice` 模式，还是绑定 `vfio-pci` 供 DPDK 用户态进程使用。
- DPDK 路径是业务容器直接消费 SR-IOV VF，还是使用 kube-ovn OVS-DPDK、Userspace CNI、vhostuser 等方案。
- 使用客户真实 CNF 镜像或 `testpmd`、Trex 等工具完成 PPS、带宽、时延和抖动基线压测。

在没有完成上述硬件、驱动、资源隔离和压测验证前，不应把本插件包描述为完整的 DPDK 产品化交付。

## 诊断步骤

### operator 或 config-daemon 未运行

检查 Pod 状态和事件：

```bash
kubectl get pods -n "$SRIOV_NAMESPACE" -o wide
kubectl describe pod -n "$SRIOV_NAMESPACE" <pod-name>
kubectl logs -n "$SRIOV_NAMESPACE" deploy/sriov-network-operator
```

如果 `config-daemon` 卡在 init 阶段，先确认 init container 列表是否只有 `sriov-cni`。如果仍然出现 `ovs-cni`、`rdma-cni` 或 `ib-sriov-cni`，说明安装的不是 ACP 修正后的插件包或 operator 镜像版本。

### 节点没有发现 SR-IOV PF

检查 `SriovNetworkNodeState`：

```bash
kubectl get sriovnetworknodestate <node-name> -n "$SRIOV_NAMESPACE" -o yaml
```

如果 `status.interfaces` 为空，继续在节点侧确认硬件和内核状态：

```bash
lspci -nn | grep -i ethernet
ip link show
```

确认 BIOS/IOMMU 已启用，并且目标 PF 驱动支持 SR-IOV。

### policy 同步失败

查看同步状态和错误：

```bash
kubectl get sriovnetworknodestate <node-name> -n "$SRIOV_NAMESPACE" \
  -o jsonpath='{.status.syncStatus}{"\n"}{.status.lastSyncError}{"\n"}'
```

常见原因包括：

- `nodeSelector` 没有匹配任何节点。
- `nicSelector.pfNames` 写错，或者 PF 名称在目标节点上不存在。
- PF 已被其他网络组件占用，无法创建 VF。
- 节点未启用 IOMMU 或驱动不支持请求的 VF 数量。

### Pod 或 VM 无法分配 VF

确认节点 allocatable 中存在资源：

```bash
kubectl get node <node-name> \
  -o jsonpath='{.status.allocatable.openshift\.io/intel_sriov_netdevice}{"\n"}'
```

确认 Pod 或 virt-launcher 事件：

```bash
kubectl describe pod -n kubevirt <pod-name>
```

如果事件提示资源不足，检查 `SriovNetworkNodePolicy.spec.resourceName`、Pod resource request、`SriovNetwork.spec.resourceName` 三者是否一致。

## 限制

- 无 SR-IOV 网卡环境只能完成控制面 smoke 验证，不能证明 VF 创建、device plugin 资源暴露或虚拟机数据面连通性。
- 本方案不替换集群主 CNI。kube-ovn 继续承担 Pod 主网络，SR-IOV 网络作为 Multus 辅助网络使用。
- 当前 ACP 打包版本不部署 `ovs-cni`、`rdma-cni`、`ib-sriov-cni`。如果业务需要 OVS、RDMA 或 InfiniBand SR-IOV，需要单独评估镜像、operator 渲染逻辑和验证范围。