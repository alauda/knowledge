---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500033
sourceSHA: 21e328fae879196d48d67cee245123e1c7c03fbbb70daed831bfff91c313137b
---

# Pod 在本地 PV 上保持 Pending 状态，调度器消息为 "didn't find available persistent volumes to bind"

## 问题

在 Alauda 容器平台 4.x（kube v1.34.5；topolvm CSI 驱动 `topolvm.cybozu.com`，StorageClass `topolvm-hdd`）上，当 Pod 模板的 `spec.nodeSelector`（或 `spec.affinity.nodeAffinity`）将调度限制缩小到不包括 PV 的 `spec.nodeAffinity` 中指定的节点时，消耗由节点本地 PersistentVolume 支持的 PersistentVolumeClaim 的 Pod 可能会无限期保持在 `Pending` 状态。此时，kube-scheduler 会报告一个两条子句的 `FailedScheduling` 事件，形式为 `0/N nodes are available: X node(s) didn't find available persistent volumes to bind, Y node(s) didn't match Pod's node affinity/selector`，而 Pod 永远不会被调度——无论候选 PV 是仍然 `Available`（此确切消息）还是已经 `Bound`（变体为 `X node(s) didn't match PersistentVolume's node affinity, Y node(s) didn't match Pod's node affinity/selector`），相同的根本机制都适用。

## 根本原因

本地 PV 的 `spec.nodeAffinity` 是一个硬约束：该 PV 不能绑定或挂载到除其亲和性中指定的节点以外的任何节点，因为底层磁盘仅存在于该单一机器上。在 ACP 中，默认的本地块存储路径是 TopoLVM（CSI 驱动 `topolvm.cybozu.com`，StorageClass `topolvm-hdd`，`volumeBindingMode: WaitForFirstConsumer`）；TopoLVM PV 也带有 `nodeAffinity`，将每个卷固定到单个节点，但亲和性键是 `topology.topolvm.cybozu.com/node` 而不是 `kubernetes.io/hostname`。当 Pod 的调度约束排除了该单一节点时，VolumeBinding 和 NodeAffinity 谓词在不相交的节点集上运行，调度器发出上述两条子句的失败消息。

## 解决方案

将 Pod 的调度约束与拥有本地 PV 的节点对齐。两条子句的调度器消息本身命名了这两个谓词及其不相交的节点集合：`didn't find available persistent volumes to bind` 子句计算了 PVC 可以绑定的节点数量，而 `didn't match Pod's node affinity/selector` 子句计算了 Pod 模板允许的节点数量；只有它们的交集是可调度的，而 PV 的 `nodeAffinity` 是对单个节点的硬固定。

标准的补救措施直接源于该机制：如果 Pod 的 `nodeSelector` / `affinity.nodeAffinity` 是偶然的，则删除它，或者更改选择器以匹配 PV 所在节点实际携带的标签。当 PVC 通过 `topolvm-hdd` StorageClass 动态配置时，StorageClass 的 `volumeBindingMode: WaitForFirstConsumer` 会推迟 PV 创建，直到调度器为 Pod 选择了一个可行的节点，因此绑定步骤通常会落在一个已经满足 Pod 模板其他约束的节点上；手动预创建一个节点固定的 PV，然后将 Pod 限制到不相交的集合，是重现问题部分的配置。

## 诊断步骤

在更改任何内容之前，确认 Pod 本身的症状——这两条子句的消息是负载信号，而 `FailedScheduling` 事件的措辞区分了本地 PV 不匹配与一般调度失误：

```bash
kubectl -n <ns> describe pod <pod-name>
```

相关行在 `Events:` 下以 `FailedScheduling` 原因出现；两个子句（PV 可用性子句和节点亲和性子句）出现在同一行，并共同命名不相交的节点集合。

检查候选 PV，以确定每个 PV 固定到哪个节点。在 ACP 中，亲和性是通过 `topology.topolvm.cybozu.com/node` 为 TopoLVM 提供的卷键入的，因此遍历 `spec.nodeAffinity.required.nodeSelectorTerms[].matchExpressions[]` 是读取固定的便携方式，而不是过滤特定标签键：

```bash
kubectl get pv -o yaml
```

交叉检查 Pod 的有效调度约束与 PV 所有者节点的标签——交集必须非空，才能调度 Pod，因为两个谓词（VolumeBinding 和 NodeAffinity）必须接受相同的节点：

```bash
kubectl get pod <pod-name> -n <ns> -o jsonpath='{.spec.nodeSelector}{"\n"}{.spec.affinity}{"\n"}'
kubectl get node <pv-owner-node> --show-labels
```

如果这两个集合没有重叠，请调整 Pod 的选择器 / 亲和性（或 PV 配置侧，对于 `WaitForFirstConsumer` SC），使它们重叠；然后调度器将在下一个同步时重新评估 Pod。
