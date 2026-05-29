---
kind:
  - BestPractices
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500557
sourceSHA: 335b7ffd9000c5f2a542c483a5ede735a665d147cabfcf48884768c26eff5f3d
---

# 为 ACP 集群调整大小以承载 KubeVirt 虚拟机工作负载

## 问题

规划一个 Alauda 容器平台集群，该集群将在 kube-version v1.34.5 上通过 Alauda 虚拟化 (KubeVirt) 模块运行虚拟机，并使用 `kubevirt-hyperconverged-operator.v4.3.5` (KubeVirt operatorVersion v1.7.0-alauda.1-dirty) 在命名空间 `kubevirt` 中，需要为每个工作节点调整大小，以便每个 VirtualMachineInstance 的资源请求加上每个 VMI 启动器的开销之和适合节点的可分配容量，而不是其原始硬件容量。相同的计划还必须包括足够的备用工作节点容量，以吸收单节点故障或排空，而不驱逐任何正在运行的虚拟机。

## 根本原因

工作节点的可分配资源是调度器实际提供给 Pod 的资源；它是节点的原始容量减去 kubelet 的 `kubeReserved`、`systemReserved` 和 `evictionHard` 内存阈值，在任何工作负载放置之前。在参考集群中，每个节点报告的容量为 8 个 CPU 核心和 \~16.0 GiB 的内存，但可分配的 CPU 为 7800m 和 \~14.1 GiB，反映出 `kubeReserved` 和 `systemReserved` 各为 100m / 902Mi，加上 `evictionHard.memory.available: 100Mi`；`cpuManagerPolicy` 为 `none`，因此没有核心从共享池中固定出来。对于承载虚拟机工作负载的三个工作节点，这大约提供了 23.4 个 CPU 核心和 \~42.3 GiB 的可分配资源，供虚拟机及其启动器开销使用。

每个 VirtualMachineInstance 实际上是一个 virt-launcher Pod，来宾声明的 CPU 和内存在该 Pod 的 `VMI.spec.domain.resources` 下以标准的 `requests` 和 `limits` 形式出现，分别对应 `cpu` 和 `memory` 键——这就是调度器在将 VMI 绑定到节点时所看到的形状。由于 `VMI.spec.domain.resources.overcommitGuestOverhead` 保持默认值 `false`，调度器还会在来宾声明的值之上考虑每个 VMI 启动器的开销，因此节点容量规划必须为来宾请求和 KubeVirt 添加的开销表面进行预算。在 ACP 中，`HyperConverged` CR 暴露了控制该开销表面的可调参数：`vmiCPUAllocationRatio` 默认值为 `10`（每个 vCPU 转换为启动器 Pod 上的十分之一物理线程的 CPU 请求），而 `higherWorkloadDensity.memoryOvercommitPercentage` 默认值为 `100`（无内存超分配），因此在默认设置下“添加到来宾内存上的开销”规则成立。KubeVirt 每节点代理作为 `virt-handler` DaemonSet 运行，由 `kubernetes.io/os=linux` 选择，因此启动器开销适用于参与虚拟机工作负载的每个节点。

控制平面的大小必须随着相同的工作负载增长，因为每个 VirtualMachine、VirtualMachineInstance 和 DataVolume CR 及其持续的状态更新都通过 kube-apiserver 和 etcd 进行汇聚。在 ACP 中，控制平面作为 kubeadm 风格的静态 Pod 在 `kube-system` 中运行（etcd、kube-apiserver、kube-controller-manager、kube-scheduler），在 etcd 上的基础容器请求为 `cpu=100m, memory=100Mi`，在 kube-apiserver 上为 `cpu=250m`——这些是底线，而不是在虚拟机负载下的稳态，`kubevirt.io`、`cdi.kubevirt.io`、`hco.kubevirt.io`、`snapshot.kubevirt.io`、`migrations.kubevirt.io` 和 `instancetype.kubevirt.io` 组中的 34 个 CRD 增加了控制平面必须吸收的调和循环。

## 解决方案

根据可分配资源而不是容量来调整工作池的大小，并在每个来宾请求之上预算每个 VMI 启动器的开销。对于每个计划的虚拟机，获取在 VirtualMachine 中声明的来宾 CPU 和内存，将其视为将在 virt-launcher Pod 上出现的 Pod 级别 `requests`，并在求和之前添加 KubeVirt 启动器的开销——预计一个节点将承载的所有 VMI 的总和必须适合该节点的可分配资源。将 `overcommitGuestOverhead` 保持在默认值 `false`，以便调度器继续考虑该开销；如果在 `HyperConverged` CR 上调整了 `vmiCPUAllocationRatio` 或 `memoryOvercommitPercentage`，则在调整大小之前根据新的比例重新计算每个 VMI 请求的占用。

为 N+1 故障域提供足够的备用工作节点容量：当一个工作节点丢失或排空时，池中的剩余工作节点必须共同保持重新承载在缺失节点上运行的每个 VMI 所需的可分配余量。在一个小集群中——例如，三个工作节点加一个控制平面节点——这意味着每个单独的工作节点应运行不超过 `(总虚拟机占用) / (工作节点数 - 1)` 的工作负载，以便存活的两个工作节点仍然可以吸收第三个工作节点的份额。

根据工作负载生成的 API 写入速率来调整控制平面的大小，而不仅仅是基础容器请求；在 `kube-system` 中观察到的 etcd 和 kube-apiserver 的底线是最低限度，两个 Pod 的 CPU 和内存余量应根据虚拟机、VMI 和 DataVolume 对象的数量以及其状态字段变化的速率进行提高。

一个代表性的 VMI 规格——调度器将在 virt-launcher Pod 上看到的形状——符合标准的上游形式：

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstance
spec:
  domain:
    resources:
      requests:
        cpu: "2"
        memory: "4Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
      overcommitGuestOverhead: false
```

## 诊断步骤

在承诺调整大小计划之前确认每个节点的可分配资源——这是调度器将用于接纳 virt-launcher Pods 的值，并且它已经净化了 `kubeReserved`、`systemReserved` 和 `evictionHard`：

```bash
kubectl get nodes -o custom-columns=\
NAME:.metadata.name,\
CPU_CAP:.status.capacity.cpu,\
CPU_ALLOC:.status.allocatable.cpu,\
MEM_CAP:.status.capacity.memory,\
MEM_ALLOC:.status.allocatable.memory
```

检查合并的 kubelet 配置，以验证解释容量与可分配之间差异的保留和驱逐值：

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | jq '.kubeletconfig | {kubeReserved, systemReserved, evictionHard, cpuManagerPolicy}'
```

列出现有的 VMI 及其 virt-launcher Pods 上的资源请求，以查看虚拟机工作负载的实际调度器视图——请注意，下面的列投影 `.spec.containers[0]`，这是标准 virt-launcher Pod 形状上的启动器容器；如果 Pod 携带 container-disk 或其他侧车，则应按容器名称（例如 `compute`）进行投影，以确保读取启动器自身的请求：

```bash
kubectl get vmi -A
kubectl get pod -A -l kubevirt.io=virt-launcher \
  -o custom-columns=\
NS:.metadata.namespace,\
POD:.metadata.name,\
NODE:.spec.nodeName,\
CPU_REQ:.spec.containers[0].resources.requests.cpu,\
MEM_REQ:.spec.containers[0].resources.requests.memory
```

验证每个预期承载 VMI 的节点上的 KubeVirt 代理是否健康，因为启动器开销依赖于此：

```bash
kubectl -n kubevirt get ds virt-handler
```

检查 `kube-system` 中控制平面静态 Pod 的资源占用与工作负载将创建的 VM、VMI 和 DataVolume 对象的预期 API 和 etcd 写入速率：

```bash
kubectl -n kube-system get pod \
  -l 'tier=control-plane' \
  -o custom-columns=\
NAME:.metadata.name,\
NODE:.spec.nodeName,\
CPU_REQ:.spec.containers[*].resources.requests.cpu,\
MEM_REQ:.spec.containers[*].resources.requests.memory
kubectl get crd \
  -o name | grep -E '(kubevirt|cdi|hco|snapshot|migrations|instancetype)\.kubevirt\.io$' \
  | wc -l
```
