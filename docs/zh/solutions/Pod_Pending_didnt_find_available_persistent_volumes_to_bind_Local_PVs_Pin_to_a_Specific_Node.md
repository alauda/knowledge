---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500033
sourceSHA: 9308f01460065d68a4ae03c9253f46271eccee9bd6e7a99318535afa02660436
---

# Pod Pending: `didn't find available persistent volumes to bind` — 本地 PV 固定到特定节点

## 问题

一个 Pod（通常是 StatefulSet 成员 — Prometheus、数据库、队列代理）保持 Pending 状态。`kubectl describe pod` 显示调度器未找到 **任何** 节点，既满足匹配的本地 PV，又满足 Pod 自身的节点亲和性：

```text
0/6 nodes are available:
  3 node(s) didn't find available persistent volumes to bind,
  3 node(s) didn't match Pod's node affinity/selector.
preemption: 0/6 nodes are available: 6 Preemption is not helpful for scheduling.
```

该消息异常清晰地说明了交集失败：三个节点携带本地 PV，但未通过 Pod 的 nodeSelector，另外三个节点满足 nodeSelector，但没有匹配的本地 PV。调度器没有同时满足两个约束的候选项，因此 Pod 永远无法调度。

## 根本原因

由本地存储操作员（或任何等效工具，从节点附加磁盘中提供 PV）创建的本地 PV 带有一个 `nodeAffinity` 字段，该字段将 PV 硬性固定到其切割自的特定节点：

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: local-pv-abcd
spec:
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values: [node-3]
```

这种亲和性是一个硬性约束：PV 只能被在指定节点上运行的 Pod 消耗。PV 不能以任何有意义的方式“迁移”到另一个节点 — 它所代表的磁盘物理上附加在一台机器上。

当 Pod 的模板携带其自己的 `nodeSelector`（或 `affinity` 段）将 Pod 限制到 *不同* 的节点集时 — 例如，一个期望在控制平面上运行的监控 Pod，而本地 PV 是从工作节点的磁盘中切割出来的 — 两个约束的交集为空。调度器如实报告“没有节点同时满足”，因此 Pod 保持 Pending。

没有任何约束可以在不产生后果的情况下放宽：放弃 PV 的 nodeAffinity 将允许 Pod 尝试挂载不存在的磁盘，而放弃 Pod 的 nodeSelector 可能会将 Pod 放置在缺少选择器所要强制的无关要求的节点上。

## 解决方案

将 Pod 的调度约束与拥有本地 PV 的节点对齐。

### 第一步 — 列出 Pod 期望的本地 PV 所在的节点

```bash
# 列出绑定的 PV 及其主机名亲和性。
kubectl get pv -o json | \
  jq -r '.items[]
         | select(.spec.nodeAffinity != null) |
         (.spec.nodeAffinity.required.nodeSelectorTerms[0]
            .matchExpressions[] |
          select(.key == "kubernetes.io/hostname") |
          .values[]) as $host |
         "\(.metadata.name)\t\(.status.phase)\t\($host)\t\(.spec.storageClassName)"'
```

输出：

```text
local-pv-abcd   Available   node-3   local-block
local-pv-efgh   Available   node-4   local-block
local-pv-ijkl   Available   node-5   local-block
```

Pod 的 PVC 可以绑定的 PV 是那些 `storageClassName` 与 PVC 的存储类匹配的行。注意它们的 `hostname` 值 — 这些是 Pod **必须** 能够调度到的节点。

### 第二步 — 检查 Pod 当前的调度约束

```bash
kubectl -n <ns> get deployment <name> -o jsonpath='{.spec.template.spec.affinity}{"\n"}' | jq
kubectl -n <ns> get deployment <name> -o jsonpath='{.spec.template.spec.nodeSelector}{"\n"}' | jq
```

识别任何将 Pod 限制到不包括拥有 PV 的节点的 `nodeSelector` 或 `affinity`。

### 第三步 — 更新 Pod 的模板以允许拥有 PV 的节点

两种形状，选择更接近意图的一种：

**如果 Pod 的 nodeSelector 是偶然的**（例如，标签是从另一个工作负载中复制而来），则将其删除。调度器将自由地将 Pod 放置在 PV 的节点亲和性和正常约束允许的任何地方：

```yaml
# 修改前
spec:
  template:
    spec:
      nodeSelector:
        node-role.kubernetes.io/infra: ""

# 修改后（移除 nodeSelector）
spec:
  template:
    spec:
      # 让 PVC 的 PV 级 nodeAffinity 驱动调度。
      # 调度器将把这个 Pod 放在拥有本地 PV 的节点上。
```

**如果 Pod 的 nodeSelector 是有意的**（例如，Pod 确实应该在特定子集的节点上运行），**则在这些节点上提供本地 PV**。可以扩展本地存储操作员的 `LocalVolumeSet` / 等效 CR，以包括预期放置的节点，或者调度工作负载以确保拥有 PV 的节点包含在选择器中：

```yaml
# 带有更广泛 nodeSelector 的 LocalVolumeSet。
apiVersion: local.storage.alauda.io/v1alpha1
kind: LocalVolumeSet
metadata:
  name: local-block-osds
spec:
  nodeSelector:
    nodeSelectorTerms:
      - matchExpressions:
          - key: node-role.kubernetes.io/infra
            operator: Exists
  # ... 过滤器 ...
```

然后在重新部署 Pod 之前，等待在 `infra` 节点上提供新的 PV。

### 第四步 — 观察 Pod 调度

在对齐约束后，触发新的 Pod 尝试（滚动重启，或简单地删除 Pending Pod 以便控制器重新创建它）：

```bash
kubectl -n <ns> rollout restart deployment/<name>
# 或
kubectl -n <ns> delete pod -l <selector>
```

监控：

```bash
kubectl -n <ns> get pod -l <selector> -w
```

Pod 应该在一个调度周期内转变为 `Running` 状态。验证绑定的 PV：

```bash
kubectl -n <ns> get pvc <pvc-name> -o jsonpath='{.spec.volumeName}{"\n"}'
```

返回的 PV 名称应该是步骤 1 中列表中的一个。

## 诊断步骤

确认具体的失败模式。关键部分是调度器的两个条款解释：

```bash
kubectl get events -n <pod-ns> --field-selector reason=FailedScheduling | \
  grep "didn't find available persistent volumes to bind"
```

在同一行中找到此消息与互补的 `didn't match Pod's node affinity/selector` 是确切的标志 — 如果消息不同（例如，“didn't have free ports”，“exceeded quota”），则问题不同。

交叉检查 PVC 的绑定状态：

```bash
kubectl -n <pod-ns> get pvc
```

处于 `Pending` 状态的 PVC 应该已经绑定到本地 PV 是下游症状。PVC 本身的事件将重复调度器的投诉：

```bash
kubectl -n <pod-ns> describe pvc <pvc-name>
```

列出可以满足 PVC 的候选 PV（匹配存储类、可用、容量足够大）：

```bash
PVC_SC=<pvc-storage-class>
PVC_SIZE_GIB=<pvc-requested-gib>
kubectl get pv -o json | \
  jq -r --arg sc "$PVC_SC" '.items[]
         | select(.spec.storageClassName == $sc)
         | select(.status.phase == "Available")
         | "\(.metadata.name)  \(.spec.capacity.storage)  \(.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[])"'
```

如果没有 PV 显示，问题不是调度而是提供 — 本地存储操作员没有切割出足够的 PV。如果 PV 显示在 Pod 的模板禁止的节点上，则修复是上述步骤 3。

修复后，PVC 转变为 `Bound`，Pod 转变为 `Running`，并且不应再累积任何 `FailedScheduling` 事件。
