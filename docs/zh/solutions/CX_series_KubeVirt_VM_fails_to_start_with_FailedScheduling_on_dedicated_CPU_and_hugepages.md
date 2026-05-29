---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500663
sourceSHA: 2f6dc070a3e87e50f306b9c1c0b1f3f16d2ddf48c4a92da31df8e4b573d8342f
---

# CX系列 KubeVirt 虚拟机因专用 CPU 和大页而无法启动，显示 FailedScheduling

## 问题

在 `kubevirt` 命名空间中部署的 Alauda 容器平台与 KubeVirt v1.7.0-alauda.2（HCO 操作员 1.17.0），引用 CX 系列集群实例类型如 `cx1.large` 的虚拟机保持在 `ErrorUnschedulable` 状态，其虚拟机实例从未达到 `Running`。相关的 `virt-launcher-<vm>-xxxxx` pod 被卡在 `Pending` 状态，默认调度器发出 `Warning FailedScheduling` 事件，如 `0/4 nodes are available: 4 node(s) didn't match Pod's node affinity/selector` — 有时在更大的集群中会跟随 `1 Insufficient hugepages-2Mi, 3 node(s) didn't match Pod's node affinity/selector`。

```bash
kubectl get vm,vmi -n <ns>
kubectl get events -n <ns> --field-selector reason=FailedScheduling
```

## 根本原因

CX（计算专用）系列的 `virtualmachineclusterinstancetypes.instancetype.kubevirt.io` 由 kubevirt-operator 包作为 common-instancetypes 集合的一部分（版本 `v1.5.1`）提供，包含 M、N、O、RT 和 U 系列。`cx1.large` 对象携带 `spec.cpu.dedicatedCPUPlacement: true`，`spec.cpu.isolateEmulatorThread: true`，`spec.cpu.numa.guestMappingPassthrough: {}` 和 `spec.memory.hugepages.pageSize: 2Mi` — 因此每个 CX 系列工作负载都要求固定 CPU、vNUMA 直通和 2 MiB 大页。

当虚拟机引用这样的实例类型时，virt-controller 将这些要求 1:1 转换为 virt-launcher Pod 规格。计算容器的配置为 `requests.hugepages-2Mi: 4Gi`（与 `memory.guest` 相对应），`requests.cpu: 3`（客体核心加上来自 `isolateEmulatorThread` + `ioThreadsPolicy: auto` 的 IO/模拟线程保留），生成的 Pod 运行在 `qosClass: Guaranteed` — 这是 kubelet 的 CPU 管理器静态策略可以固定的唯一 QoS 类。virt-controller 还注入了一个硬性 `nodeSelector`，包含 `cpumanager=true`，`kubevirt.io/schedulable=true`，`machine-type.node.kubevirt.io/q35=true` 和 `kubernetes.io/arch=amd64`。`cpumanager=true` 标签仅由 KubeVirt 节点标记器 / virt-handler 设置在节点上，一旦该节点上的 kubelet 以 `--cpu-manager-policy=static` 运行。

开箱即用，ACP 节点携带 `cpuManagerPolicy: none` 并宣传 `allocatable.hugepages-2Mi: 0` — 在新集群中的每个节点上都经过验证。由于没有节点携带 `cpumanager=true`，kube-scheduler 在节点亲和性/选择阶段排除了所有节点，永远不会达到大页谓词 — 这就是事件的 `4 node(s) didn't match Pod's node affinity/selector` 形式。如果至少有一个节点被重新标记为 `cpumanager=true`，但仍然没有 `hugepages-2Mi`，调度器将缩小到该节点并发出 `Insufficient hugepages-2Mi`，同时报告其余节点为亲和性不匹配 — 这就是混合的 `1 Insufficient hugepages-2Mi, 3 node(s) didn't match Pod's node affinity/selector` 形式。`cx1.large` CRD 本身在其 `instancetype.kubevirt.io/description` 注释中逐字陈述了先决条件：*CX 系列实例类型的要求：必须启用 CPU 管理器。节点上必须有可用的大页。*

## 解决方案

选择至少一个将承载 CX 系列虚拟机的工作节点，并在节点操作系统层面进行准备。ACP 不提供任何操作员管理的 CRD 用于大页保留或 kubelet CPU 管理器 — 这两个参数在目录外直接在节点上配置。

通过添加 Linux 内核命令行保留（例如 `hugepagesz=2M hugepages=N`，其中 `N` 是覆盖所有在此调度的 CX 虚拟机的页面数）来在所选节点上保留 2 MiB 大页，然后重启节点以便 kubelet 开始报告这些页面。重启后，保留将在 `node.status.allocatable.hugepages-2Mi` 中可见：

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.allocatable.hugepages-2Mi}{"\n"}{end}'
```

通过在该节点的 kubelet 配置文件中设置 `cpuManagerPolicy: static` 来启用 kubelet CPU 管理器静态策略，并重启 kubelet。通过 kubelet 的 `/configz` 端点确认该策略：

```bash
kubectl get --raw /api/v1/nodes/<node-name>/proxy/configz | python3 -c 'import sys,json; print(json.load(sys.stdin)["kubeletconfig"]["cpuManagerPolicy"])'
```

一旦 kubelet 以 `cpuManagerPolicy: static` 运行，KubeVirt 节点标记器 / virt-handler 在该节点上设置 `cpumanager=true` 标签，这正是 virt-controller 的启动器 `nodeSelector` 过滤的内容：

```bash
kubectl get nodes -L cpumanager
```

在至少一个节点上同时存在大页保留和 `cpumanager=true` 后，下一次对 CX 绑定的虚拟机的调和将清除 `FailedScheduling` 事件，启动器 Pod 将被绑定。

对于不需要固定核心、vNUMA 或大页的通用工作负载，请引用 U 系列实例类型（`u1.medium`，`u1.large`，`u1.xlarge`，...）而不是 CX。U 系列主体仅携带 `spec.cpu.guest` 和 `spec.memory.guest` — 没有 `dedicatedCPUPlacement`，没有 `isolateEmulatorThread`，没有 `numa`，没有 `hugepages` 块 — 因此 virt-launcher 在没有任何节点侧准备的情况下以正常的 Burstable-QoS 方式调度：

```bash
kubectl get virtualmachineclusterinstancetype u1.medium -o yaml
```

## 诊断步骤

确认虚拟机引用了 CX 系列实例类型：

```bash
kubectl get vm <vm-name> -n <ns> -o jsonpath='{.spec.instancetype}{"\n"}'
```

检查实例类型以查看其是否要求固定 CPU 和大页 — 每个 CX 变体都是如此：

```bash
kubectl get virtualmachineclusterinstancetype cx1.large -o yaml
```

阅读被卡住的启动器 Pod 上的 `FailedScheduling` 事件，并查看启动器的 `nodeSelector` 以查看过滤掉未准备节点的 `cpumanager=true` 要求：

```bash
kubectl get events -n <ns> --field-selector reason=FailedScheduling
kubectl get pod -n <ns> -l kubevirt.io/created-by=<vmi-uid> \
  -o jsonpath='{.items[0].spec.nodeSelector}{"\n"}'
```

检查当前是否有任何节点携带 `cpumanager=true` 以及它们宣传的巨大页面：

```bash
kubectl get nodes -L cpumanager
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\thugepages-2Mi="}{.status.allocatable.hugepages-2Mi}{"\n"}{end}'
```

如果每个节点报告 `cpumanager=false` 和 `hugepages-2Mi=0`，则集群没有满足任何 CX 系列启动器的节点 — 要么按照上述描述准备一个节点，要么将虚拟机重新绑定到 U 系列实例类型。
