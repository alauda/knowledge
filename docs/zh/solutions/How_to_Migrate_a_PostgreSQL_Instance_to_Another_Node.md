---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - '4.0,4.1,4.2,4.3'
id: KB260515007
sourceSHA: eab3672c44b5853b09e36836db09ba38788fa6d5743c9d2a6cfb79a80b9708d6
---

# 如何将 PostgreSQL 实例迁移到另一个节点

## 问题

由 PostgreSQL Operator 管理的 PostgreSQL 集群使用节点本地存储（例如 TopoLVM）。一个或多个实例必须从当前节点迁移——因为该节点正在退役，或者实例必须在特定的计算节点上运行。由于数据存储在节点本地的 PersistentVolume 中，Pod 不能简单地重新调度；该卷被固定在其节点上。

## 环境

- Alauda 应用服务 PostgreSQL Operator（基于 Zalando，`acid.zalan.do/v1` `postgresql` 资源）。
- 节点本地存储，如 TopoLVM（每个 PVC 绑定到一个节点）。
- 至少一个具有足够可用容量的目标节点。由于迁移会重新克隆数据，目标节点在过渡期间应具有大约 **两倍** 实例 PVC 大小的容量。

## 解决方案

迁移依赖于 Operator 的一个特性：当实例的 PVC 和 Pod 被删除时，StatefulSet 会重新创建 Pod，新的 PVC 会在 Pod 被调度的地方进行配置，Patroni 会从当前领导者重新克隆数据。数据通过流复制得以保留，而不是通过移动卷。

> 在 ACP 4.2 和 4.3 上验证：在删除一个副本的 PVC 和 Pod 后，该成员在一个节点上被重新创建，从领导者处重新同步，并且之前写入的行在重新同步的成员上存在。

在下面的示例中，为目标集群设置 `$NAMESPACE` 和 `$CLUSTER_NAME`。用您自己的节点名称替换占位符节点名称。

### 1. 确认当前放置

```bash
kubectl get pod -n $NAMESPACE -o wide | grep $CLUSTER_NAME
kubectl get pvc -n $NAMESPACE -o wide | grep $CLUSTER_NAME
```

注意哪个成员是领导者（不要先删除领导者的卷）：

```bash
kubectl exec -n $NAMESPACE $CLUSTER_NAME-0 -c postgres -- patronictl list
```

### 2. 限制调度到目标节点

为了确保重新创建的 Pod 仅在所需节点上运行，请对其他合格节点进行标记（或使用仅目标节点携带的 `nodeSelector`/标签）。至少保持目标节点可调度。

```bash
# 仅标记目标节点，以便重新创建的 Pod 可以在那里运行，而不能在其他地方运行
kubectl label node <target-node> target=true --overwrite
```

**不要** 标记源节点——同时标记源节点和目标节点会让 Pod 重新调度回源节点。如果您更喜欢使用禁用而不是标签，请禁用所有非目标节点，而跳过下面的 `nodeSelector` 步骤。

如果您使用基于标签的选择器，请在实例上设置它：

```bash
kubectl patch postgresql -n $NAMESPACE $CLUSTER_NAME --type merge \
  -p '{"spec":{"nodeSelector":{"target":"true"}}}'
```

### 3. 一次迁移一个成员

始终先迁移 **非领导者** 成员。一起删除其 PVC 和 Pod——PVC 删除会阻塞，直到挂载它的 Pod 消失，因此并行删除 Pod：

```bash
# 删除数据 PVC（它将在 Pod 消失之前保持在 Terminating 状态）
kubectl delete pvc pgdata-$CLUSTER_NAME-1 -n $NAMESPACE --wait=false

# 删除 Pod 以释放 PVC
kubectl delete pod $CLUSTER_NAME-1 -n $NAMESPACE
```

StatefulSet 会重新创建 `$CLUSTER_NAME-1`；新的 PVC 会在调度的节点上进行配置，Patroni 会从领导者重新克隆。

### 4. 验证成员已重新加入并带有数据

```bash
kubectl get pod -n $NAMESPACE -o wide | grep $CLUSTER_NAME-1
kubectl exec -n $NAMESPACE $CLUSTER_NAME-0 -c postgres -- patronictl list
```

迁移的成员应返回角色 `Replica`，状态 `running`/`streaming`，`Lag in MB` 为 `0`。在成员上进行抽查数据（它是只读的 / 在恢复中）：

```bash
kubectl exec -n $NAMESPACE $CLUSTER_NAME-1 -c postgres -- \
  psql -U postgres -tAc "SELECT pg_is_in_recovery();"   # 期望 t
```

### 5. 如有需要，迁移（前）领导者

要移动领导者，首先执行切换操作，使另一个成员成为领导者，然后对旧领导者重复步骤 3–4：

```bash
kubectl exec -n $NAMESPACE $CLUSTER_NAME-0 -c postgres -- \
  patronictl switchover $CLUSTER_NAME --force
```

### 6. 恢复调度

取消禁用您禁用的任何节点，并在所有成员都在其目标节点上后，删除临时标签/`nodeSelector`。

## 注意事项

- 一次迁移一个成员，并在移动下一个之前等待每个成员完全重新同步（`Lag = 0`），以便集群始终保持健康的法定人数。
- 对于单实例集群，暂时扩展到两个实例，让新成员在目标节点上同步，切换后再缩减回一个——这避免了删除和重新克隆唯一实例所造成的停机。
