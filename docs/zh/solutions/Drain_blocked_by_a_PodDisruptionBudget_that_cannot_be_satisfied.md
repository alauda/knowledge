---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500398
sourceSHA: edea1c35d2a2b6cb05bce2db175cfbc061935128b16aead1a475cd139ad382f5
---

# 被无法满足的 PodDisruptionBudget 阻塞的排空

## 问题

在 Alauda 容器平台 (Kubernetes v1.34.5，其中 `policy` API 组仅在 `policy/v1` 提供 `poddisruptionbudgets`，而 `v1beta1` 形状不再注册) 中，当目标 pod 被一个无法容忍更多干扰的 PodDisruptionBudget 选中时，通过驱逐子资源进行的节点排空可能会无限期停滞。驱逐端点以 `HTTP 429 TooManyRequests` 拒绝请求（顶层状态 `reason` 字段），并且 `details.causes[].reason` 为 `DisruptionBudget`；状态中显示的原始消息为 `Cannot evict pod as it would violate the pod's disruption budget.`，而 `causes.message` 字段则命名了有问题的预算以及当前 / 所需的健康 pod 数量（例如，`The disruption budget pdb-canary-block needs 2 healthy pods and has 2 currently`）。

`kubectl drain` 发出这些驱逐调用，而不是直接的 DELETE — 它内置的帮助确认排空“在 API 服务器支持驱逐的情况下驱逐 pods” — 因此，任何选择目标节点上 pods 的 PDB 都会在排空工作流中得到遵守。Alauda 容器平台上的不可变基础设施节点发布路径，在受控轮换期间逐个隔离和排空节点，执行相同的隔离-然后-排空序列（隔离步骤将 `Node.spec.unschedulable=true` 翻转，`kubectl` 然后在节点状态列中呈现 `SchedulingDisabled`），因此也受到驱逐调用的相同 PDB 门限的影响；如果无法满足预算，则发布无法在受影响的节点上取得进展。

## 根本原因

PodDisruptionBudget 管理与其 `selector` 匹配的一组 pods 的自愿干扰。只有驱逐子资源 (`POST .../pods/<name>/eviction`) 在接纳时咨询预算 — 直接对 pod 资源的 `DELETE` 完全绕过检查，因为 PDB 仅对驱逐进行限制。当匹配工作负载的当前健康副本数等于预算的 `minAvailable`（或已经达到 `maxUnavailable` 上限）时，每次驱逐都会使工作负载低于配置的底线，API 服务器会以 `429` 拒绝请求。

典型的错误配置是与 `minAvailable: 1` 配对的单副本工作负载：正在运行的副本同时是最后一个健康 pod 和唯一的驱逐候选，因此预算永远无法满足，排空客户端会永远重试同一个 pod，记录 `error when evicting pods/<name>: Cannot evict pod as it would violate the pod's disruption budget. will retry after 5s` 在每次重试时。相同的失败模式在滚动节点重启期间也会出现：如果连续的排空将工作负载的每个副本集中到一个剩余节点上，驱逐最后一个副本将违反预算，导致该节点的排空无法完成。

## 解决方案

选择适合工作负载的最低影响路径 — 对于无状态工作负载，放宽预算是首选；当工作负载可以容忍短暂的停机时，缩放到零是首选，而直接删除是卡住发布的最后手段。以下四条路径通过改变预算评估的内容或绕过咨询它的驱逐子资源，消除了驱逐拒绝对关键路径的影响。

路径 1 — 在维护窗口期间放宽 PDB。将 `spec.minAvailable` 修补为 `0`，以便后续的驱逐被接纳；驱逐子资源在补丁生效后会对同一个 pod 返回 `201 Success`。排空完成后恢复原始值：

```bash
kubectl patch pdb <name> -n <ns> --type=merge \
  -p '{"spec":{"minAvailable":0}}'
```

路径 2 — 在排空之前将工作负载缩放到零。减少 `replicas` 通过 `/scale` 子资源，这不会调用 `/eviction`，因此不会咨询 PDB，发布没有 pods 可以从任何节点驱逐：

```bash
kubectl scale deployment/<name> -n <ns> --replicas=0
```

路径 3 — 在不经过驱逐子资源的情况下排空。`kubectl drain --disable-eviction` 将排空客户端切换为直接 DELETE 调用；它自己的帮助文本说明该标志旨在“强制排空使用删除，…这将绕过检查 PodDisruptionBudgets”。因为排空不再命中驱逐端点，所以不会发出 `will retry after 5s ... Cannot evict` 的重试，并且任何选择的 PDB 都会被忽略：

```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data --disable-eviction
```

路径 4 — 直接删除阻塞的 pod。`kubectl delete pod` 请求通过 pod 资源（而不是 `/eviction`），因此 PDB 不会限制它；工作负载控制器随后会重新创建副本，如果源节点被隔离，调度程序会将其放置在其他地方：

```bash
kubectl delete pod -n <ns> <pod>
```

直接 DELETE 是破坏性的 — 它跳过了工作负载所有者设置的优雅干扰预算，这正是 PDB 的全部意义。两个特定的工作负载类别在没有额外注意的情况下不得使用路径 3 或路径 4 绕过：

- KubeVirt `virt-launcher` pods。KubeVirt CRDs（`virtualmachineinstances`、`virtualmachines`）和命名空间 `kubevirt` 中的 `virt-controller` 部署在此集群中存在，因此 `virt-launcher` pods 是实际的驱逐目标。绕过 `virt-launcher` pod 上的 PDB 会不优雅地终止包装的虚拟机，而不是触发实时迁移，因此 PDB 绕过路径对 KubeVirt 管理的虚拟化工作负载是不安全的。
- 更一般的对 quorum 敏感的有状态 pods。默认的 Alauda 容器平台安装不提供 Ceph operator，但如果集群上安装了第三方 Ceph 部署（例如 rook-ceph operator）或任何其他基于 quorum 的有状态工作负载，则同样的谨慎适用：在基础集群未完全健康的情况下，绕过前置监视器或 quorum 成员 pod 的 PDB 可能会导致幸存的 quorum 丢失并风险数据丢失。对于任何前置有状态或对 quorum 敏感的工作负载的 PDB，请在应用路径 3 或路径 4 之前确认基础集群是健康的 — PDB 是工作负载所有者的信号，表明自愿干扰现在是不安全的。

在此集群上编写或重新创建 PodDisruptionBudget 时，请使用提供的组/版本（`policy/v1`）；API 服务器不再提供 `v1beta1` 形状：

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: <name>
  namespace: <ns>
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: <label>
```

## 诊断步骤

通过向驱逐子资源发送请求并观察 `429 TooManyRequests` 响应来重现可疑 pod 的症状。状态负载携带 `reason: DisruptionBudget`，原始消息 `Cannot evict pod as it would violate the pod's disruption budget.`，以及命名有问题的预算及其所需与当前健康 pod 数量的 `causes.message` 行 — 该字符串是此失败模式的典型指纹，是确认卡住的排空实际上是 PDB 限制而不是被其他内容阻塞的最便宜的重现方法。

在工作流级别，相同的信号表现为发出 `evicting pod ...` 日志行的排空客户端（排空使用驱逐子资源，因此它记录 `evicting`，而不是 `deleting`），然后每五秒重试同一个 pod，记录 `error when evicting pods/<name>: Cannot evict pod as it would violate the pod's disruption budget. will retry after 5s`，直到预算发生变化。

正在进行控制器驱动的排空的节点 — 例如，不可变基础设施节点轮换 — 在 `kubectl get node` 中报告 `STATUS: Ready,SchedulingDisabled`，因为隔离步骤将 `Node.spec.unschedulable=true`，而 `kubectl` 在 `STATUS` 列中呈现该布尔值。将该信号与 PDB 检查配对，以确认排空是否仅被隔离或也被驱逐拒绝阻塞：

```bash
kubectl get node
kubectl get pdb -A
kubectl describe pdb <name> -n <ns>
```
