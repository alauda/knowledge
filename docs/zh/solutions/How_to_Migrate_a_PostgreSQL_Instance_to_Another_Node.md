---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - '4.0,4.1,4.2,4.3'
id: KB260515007
sourceSHA: 68545d5287dbfbc24261231c54b484401a71c97c16407e79865eea4f4aefd110
---

# 如何将 PostgreSQL 实例迁移到其他节点

## 问题

由 PostgreSQL Operator 管理的 PostgreSQL 集群使用节点本地存储（例如 TopoLVM）。由于节点下线，或某个实例需要运行在指定的计算节点上，需要将一个或多个实例迁出当前节点。由于数据位于节点本地的 PersistentVolume 上，Pod 无法被直接重新调度——卷被固定在其所在节点上。

## 环境

- Alauda Application Services PostgreSQL Operator（基于 Zalando，`acid.zalan.do/v1` 的 `postgresql` 资源）。
- 节点本地存储，例如 TopoLVM（每个 PVC 绑定到单个节点）。
- 至少一个有足够空闲容量的目标节点。由于迁移会重新克隆数据，目标节点在迁移期间应具备约为实例 PVC 大小**两倍**的容量。

## 解决方案

迁移依赖 Operator 的一个特性：当某个实例的 PVC 与 Pod 被删除后，StatefulSet 会重建该 Pod，在 Pod 被调度到的节点上重新供给一个新的 PVC，Patroni 则从当前 Leader 重新克隆数据。数据通过流复制得以保留，而非通过移动卷。

> 已在 ACP 4.2 与 4.3 上验证：删除某副本的 PVC 与 Pod 后，该成员在节点上被重建，从 Leader 重新同步，先前写入的数据行在重新同步后的成员上依然存在。

以下示例中，请为目标集群设置 `$NAMESPACE` 与 `$CLUSTER_NAME`，并将占位节点名替换为实际节点名。

### 1. 确认当前分布

```bash
kubectl get pod -n $NAMESPACE -o wide | grep $CLUSTER_NAME
kubectl get pvc -n $NAMESPACE -o wide | grep $CLUSTER_NAME
```

确认哪个成员是 Leader（不要先删除 Leader 的卷）：

```bash
kubectl exec -n $NAMESPACE $CLUSTER_NAME-0 -c postgres -- patronictl list
```

### 2. 将调度限制到目标节点

为使重建的 Pod 只落在期望的节点上，将其他可调度节点设置为不可调度（cordon），或使用仅目标节点具备的 `nodeSelector`/标签，并至少保留目标节点可调度。

```bash
# 示例：为源节点与目标节点打标签，然后基于标签选择
kubectl label node <source-node> <target-node> target=true --overwrite
```

如使用基于标签的选择器，在实例上设置：

```bash
kubectl patch postgresql -n $NAMESPACE $CLUSTER_NAME --type merge \
  -p '{"spec":{"nodeSelector":{"target":"true"}}}'
```

### 3. 逐个迁移成员

务必先迁移**非 Leader** 成员。同时删除其 PVC 与 Pod——PVC 的删除会阻塞，直到挂载它的 Pod 消失，因此需并行删除 Pod：

```bash
# 删除数据 PVC（在 Pod 消失前会一直处于 Terminating）
kubectl delete pvc pgdata-$CLUSTER_NAME-1 -n $NAMESPACE --wait=false

# 删除 Pod 以释放 PVC
kubectl delete pod $CLUSTER_NAME-1 -n $NAMESPACE
```

StatefulSet 会重建 `$CLUSTER_NAME-1`；在被调度的节点上供给新的 PVC，Patroni 从 Leader 重新克隆。

### 4. 验证成员已带数据重新加入

```bash
kubectl get pod -n $NAMESPACE -o wide | grep $CLUSTER_NAME-1
kubectl exec -n $NAMESPACE $CLUSTER_NAME-0 -c postgres -- patronictl list
```

迁移后的成员应恢复为 `Replica` 角色，状态 `running`/`streaming`，`Lag in MB` 为 `0`。在该成员上抽查数据（它是只读 / 处于恢复状态）：

```bash
kubectl exec -n $NAMESPACE $CLUSTER_NAME-1 -c postgres -- \
  psql -U postgres -tAc "SELECT pg_is_in_recovery();"   # 期望为 t
```

### 5. 如需迁移（原）Leader

要迁移 Leader，先执行切换（switchover）让其他成员成为 Leader，然后对原 Leader 重复第 3–4 步：

```bash
kubectl exec -n $NAMESPACE $CLUSTER_NAME-0 -c postgres -- \
  patronictl switchover $CLUSTER_NAME --force
```

### 6. 恢复调度

待所有成员都位于期望节点后，取消对任何节点的 cordon，并移除临时标签/`nodeSelector`。

## 说明

- 逐个迁移成员，并在迁移下一个之前等待每个成员完全重新同步（`Lag = 0`），以使集群始终保持健康的法定数量。
- 对于单实例集群，临时扩容到两个实例，让新成员在目标节点上完成同步，执行切换后再缩容回一个实例——以避免对唯一实例执行删除并重新克隆所导致的停机。
