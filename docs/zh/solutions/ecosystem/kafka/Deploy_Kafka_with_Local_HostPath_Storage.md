---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 4.3
id: KB260900024
sourceSHA: 3d0f697b8be0b6005fc1ea183b0707280cf6e7efe2e90aa951ffded5bb3ac8d2
---

# 在节点本地磁盘上使用预绑定的持久卷部署 Kafka

:::info 适用版本
Alauda Streaming Service for Kafka 4.3 — KRaft 模式。

对于传统的 Kafka 2.x / ZooKeeper 版本，资源形状有所不同；请参见
[限制和待解决事项](#限制和待解决事项)。
:::

## 目的

Kafka 有时会部署在节点本地磁盘上——裸磁盘、LVM 卷或主机上的普通目录——而不是网络存储类，以提高吞吐量或因为集群根本没有 CSI 存储。

节点本地存储移除了每个其他 Kubernetes 工作负载所依赖的属性：卷不再能够跟随 Pod。如果不加以管理，会产生两个故障，均在实际中出现：

1. 一个代理 Pod 被重新调度，并且启动时的日志目录为空或属于其他 Pod。
2. 在一个实例被删除并重新创建后，代理绑定到彼此的磁盘。

本文档提供了一种部署操作步骤，使代理与磁盘的映射具有确定性，然后解释每个部分在 [为什么这样设计](#为什么这样设计) 中的必要性。

**简而言之：** 使用 `local` 卷，并在声明存在之前为特定的 PersistentVolumeClaim 预留每个 PersistentVolume，使用 `spec.claimRef`。

## 先决条件

- 已安装并运行 Alauda Streaming Service for Kafka。
- 三个工作节点以实现高可用性实例，每个节点都有一个专用磁盘或目录。
- 集群管理员权限。`PersistentVolume` 和 `StorageClass` 是集群范围的，必须由管理员创建，而不是命名空间的拥有者。
- 能够为目标项目标记 StorageClass — 见步骤 2。没有它，每个 PersistentVolumeClaim 都会被入场 webhook 拒绝。
- 节点标签或污点方案，以防止其他工作负载占用 Kafka 节点。请参见
  [使用亲和性、污点和容忍度在专用中间件节点上调度 Kafka](./Kafka_Node_Placement_Affinity_Taints_Guide.md)。

## 操作步骤

一个高可用性实例有 **三个代理和三个控制器**，每个都有自己的卷——**总共六个 PersistentVolumes**，每个节点两个。

由于生成的卷声明名称包含一个无法提前知道的每实例值（见 [名称的派生方式](#名称的派生方式)），该操作步骤分为两个阶段：创建实例，读取它生成的声明名称，然后创建为这些名称保留的卷。声明将处于 `Pending` 状态，直到它们的卷出现。

示例使用命名空间 `demo-space` 中的实例 `rklocal`，在节点 `192.168.131.66`、`192.168.136.224` 和 `192.168.138.211` 上。

### 步骤 1 — 准备磁盘

在每个节点上，挂载专用磁盘，并为代理和控制器各创建一个目录。不要在生产环境中将 Kafka 数据放在根文件系统上：一个失控的日志目录会导致节点崩溃。

```bash
# 在每个 Kafka 节点上
mkdir -p /cpaas/rk-broker /cpaas/rk-controller
```

不需要调整所有权。Kafka 以 UID 1001 运行，对于 `local` 卷，kubelet 会将 Pod 的 `fsGroup` 应用到挂载上，将 `root:root 0755` 目录自动转换为 `drwxrwsr-x`。

:::warning 容量是建议性的
`capacity.storage` 在 `local` 卷上是匹配的元数据，而不是配额。没有任何东西可以阻止 Kafka 将底层磁盘填满。将其设置为实际可用大小，并通过 `log.retention.bytes` / `log.retention.hours` 强制执行保留策略。
:::

### 步骤 2 — 创建 StorageClass 并授予项目

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: kafka-local
  labels:
    # 必需的。没有项目授予，使用此类的每个 PVC 都会被拒绝。
    project.cpaas.io/ALL_ALL: "true"
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: false
```

:::danger 项目标签不是可选的
StorageClass 仅在已授予的项目内可用。没有授予，`pvc-validator.cpaas.io` 入场 webhook 会拒绝每个声明，而失败是间接的——没有 Pod 出现，实例处于空闲状态。拒绝仅在 Kafka 资源的条件中可见：

```
admission webhook "pvc-validator.cpaas.io" denied the request:
StorageClass "kafka-local" is not allowed in project "demo"
```

`project.cpaas.io/ALL_ALL: "true"` 将其授予每个项目，匹配平台自身存储类的标签。要限制它，只授予需要它的项目。
:::

`no-provisioner` 意味着没有东西会动态创建——该类仅用于分组您手动创建的卷。`allowVolumeExpansion: false` 是诚实的：本地卷不能由操作员调整大小。

### 步骤 3 — 创建 Kafka 实例

将两个存储类设置为 `kafka-local`：`spec.storage` 是 **代理** 存储，`spec.controller.storage` 是 **控制器** 存储。它们是具有独立卷的独立节点池。

```yaml
apiVersion: middleware.alauda.io/v1
kind: RdsKafka
metadata:
  name: rklocal
  namespace: demo-space
spec:
  mode: KRaft
  version: "4.2"
  replicas: 3
  storage:
    class: kafka-local
    size: 5Gi
    deleteClaim: false
  resources:
    limits:
      cpu: "1"
      memory: 2Gi
    requests:
      cpu: 200m
      memory: 512Mi
  controller:
    replicas: 3
    roles:
      - controller
    storage:
      class: kafka-local
      size: 5Gi
      deleteClaim: false
    resources:
      limits:
        cpu: 500m
        memory: 500Mi
      requests:
        cpu: 500m
        memory: 500Mi
  config:
    # 复制是这里唯一的容错机制——Pod 不能移动。
    default.replication.factor: "3"
    min.insync.replicas: "2"
    offsets.topic.replication.factor: "3"
    transaction.state.log.replication.factor: "3"
    transaction.state.log.min.isr: "2"
```

`deleteClaim: false` 在实例被移除时保留声明，因此重新安装时重用现有绑定，而不是创建新的绑定。

### 步骤 4 — 读取生成的声明名称

实例立即创建其声明；它们保持 `Pending` 状态，因为尚无匹配的卷。

```bash
kubectl -n demo-space get pvc \
  -o custom-columns='PVC:.metadata.name,STATUS:.status.phase,CLASS:.spec.storageClassName'
```

```
data-rklocal-broker-a28da4-0       Pending   kafka-local
data-rklocal-broker-a28da4-1       Pending   kafka-local
data-rklocal-broker-a28da4-2       Pending   kafka-local
data-rklocal-controller-a28da4-3   Pending   kafka-local
data-rklocal-controller-a28da4-4   Pending   kafka-local
data-rklocal-controller-a28da4-5   Pending   kafka-local
```

注意形状：代理使用节点 ID 0–2，控制器使用 3–5，`a28da4` 是每个实例生成的。**准确复制这些名称**——它们是下一步的输入。

### 步骤 5 — 创建预绑定的 PersistentVolumes

每个声明一个卷，每个卷固定到其节点并为一个声明保留。生成它们而不是手动输入；这里容易出错。

```bash
#!/usr/bin/env bash
set -euo pipefail

NAMESPACE=demo-space
INSTANCE=rklocal
HASH=a28da4          # 来自步骤 4
SC=kafka-local
SIZE=5Gi
NODES=(192.168.131.66 192.168.136.224 192.168.138.211)

emit() {   # $1=pv 名称  $2=主机路径  $3=声明名称  $4=节点
  cat <<YAML
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: $1
spec:
  capacity:
    storage: ${SIZE}
  volumeMode: Filesystem
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ${SC}
  claimRef:                 # 预留——没有 uid，控制平面会填充
    apiVersion: v1
    kind: PersistentVolumeClaim
    namespace: ${NAMESPACE}
    name: $3
  local:
    path: $2
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values: ["$4"]
YAML
}

for i in 0 1 2; do
  emit "rk-broker-$i" /cpaas/rk-broker \
       "data-${INSTANCE}-broker-${HASH}-${i}" "${NODES[$i]}"
done
for i in 0 1 2; do
  emit "rk-controller-$((i+3))" /cpaas/rk-controller \
       "data-${INSTANCE}-controller-${HASH}-$((i+3))" "${NODES[$i]}"
done
```

:::warning 数组索引在不同的 shell 中不同
`bash` 从 0 开始索引数组，`zsh` 从 1 开始。使用 `bash` 运行脚本，并在应用之前检查生成的输出——这里的越界错误会静默地将错误的代理固定到错误的节点。
:::

检查输出，然后应用它。将脚本与实例清单一起保存在版本控制中——它是哪个代理拥有哪个磁盘的权威记录。

### 步骤 6 — 验证

声明在卷出现后立即绑定，Pod 启动。

```bash
kubectl -n demo-space get pvc \
  -o custom-columns='PVC:.metadata.name,STATUS:.status.phase,VOLUME:.spec.volumeName'
kubectl -n demo-space get pod -l strimzi.io/cluster=rklocal \
  -o custom-columns='POD:.metadata.name,NODE:.spec.nodeName'
```

每个声明必须与您为其保留的卷 `Bound`，每个 Pod 必须在该卷的节点上：

```
data-rklocal-broker-a28da4-0       Bound   rk-broker-0
data-rklocal-broker-a28da4-1       Bound   rk-broker-1
data-rklocal-broker-a28da4-2       Bound   rk-broker-2
data-rklocal-controller-a28da4-3   Bound   rk-controller-3
data-rklocal-controller-a28da4-4   Bound   rk-controller-4
data-rklocal-controller-a28da4-5   Bound   rk-controller-5

rklocal-broker-a28da4-0       192.168.131.66
rklocal-broker-a28da4-1       192.168.136.224
rklocal-broker-a28da4-2       192.168.138.211
rklocal-controller-a28da4-3   192.168.131.66
rklocal-controller-a28da4-4   192.168.136.224
rklocal-controller-a28da4-5   192.168.138.211
```

**然后检查每个磁盘是否仅包含一个日志目录。** 这是检测错误绑定的检查，也是唯一的检查——见
[为什么 node.id 检查不起作用](#为什么-nodeid-检查不起作用)。

```bash
# 在每个 Kafka 节点上
ls -1 /cpaas/rk-broker/ /cpaas/rk-controller/
du -sh /cpaas/rk-broker/kafka-log*/ /cpaas/rk-controller/kafka-log*/
```

每个磁盘一个目录，命名为拥有它的节点 ID，是健康的。**一个磁盘上有两个目录**意味着一个代理在其他人的数据旁边格式化了一个新的日志——请参见
[恢复错误绑定](#恢复错误绑定)。

## 清理

`Retain` 是故意的：它阻止已删除的声明破坏数据。代价是 **没有任何东西会自动回收**，清理是手动的、两部分的工作。

删除实例后留下：

| 内容                   | 位置                        | 自动回收？                |
| ---------------------- | ---------------------------- | ------------------------- |
| PersistentVolumeClaims | 命名空间                    | 否 — `deleteClaim: false` 保持它们    |
| PersistentVolumes      | 集群范围                    | 否 — `Retain` 保持它们，状态为 `Released` |
| Kafka 数据             | 每个节点上的目录            | **否 — 从未被 Kubernetes 触及**    |

要完全退役一个实例，在确认数据不再需要后：

```bash
# 1. 删除实例
kubectl -n demo-space delete rdskafka rklocal

# 2. 删除它留下的声明
kubectl -n demo-space delete pvc -l strimzi.io/cluster=rklocal

# 3. 删除卷
kubectl delete pv rk-broker-0 rk-broker-1 rk-broker-2 \
                  rk-controller-3 rk-controller-4 rk-controller-5

# 4. 删除每个节点上的数据——这是人们忘记的步骤
#    在每个 Kafka 节点上运行：
rm -rf /cpaas/rk-broker /cpaas/rk-controller
```

步骤 4 是重要的。删除 Kubernetes 对象不会释放磁盘，稍后指向相同路径的实例会发现另一个集群的日志目录在等待它。如果您打算 **重用** 相同的磁盘用于新实例，首先清除它们是必不可少的。

要保留数据并仅重建实例，请在步骤 1 后停止，并改为遵循
[删除并重新创建实例](#删除并重新创建实例)。

## 单副本（非 HA）部署

一个代理实例对于开发环境或生产者可以缓冲且短暂停机可接受的日志队列是合理的。它不是三节点设计的较小版本——这种权衡是分类的。

:::danger 单副本实例没有任何容错能力
复制因子 1 意味着每个分区只有一个副本，位于一个磁盘上，位于一个节点上。如果该节点重启、被排空或丢失其磁盘，则实例 **宕机**，其数据在此期间 **无法访问**。如果磁盘丢失，数据将丢失。Kafka 的复制是本地磁盘部署中唯一的容错能力，而在 RF=1 时没有容错能力。

请谨慎决定。不要因为三个节点看起来工作量更大而运行单副本。
:::

将 `replicas: 1` 和 `controller.replicas: 1` 设置为 1，并将每个复制因子设置为 1——请求更多副本而没有足够代理的主题无法创建：

```yaml
spec:
  mode: KRaft
  version: "4.2"
  replicas: 1
  storage:
    class: kafka-local
    size: 5Gi
    deleteClaim: false
  controller:
    replicas: 1
    roles:
      - controller
    storage:
      class: kafka-local
      size: 5Gi
      deleteClaim: false
  config:
    default.replication.factor: "1"
    min.insync.replicas: "1"
    offsets.topic.replication.factor: "1"
    transaction.state.log.replication.factor: "1"
    transaction.state.log.min.isr: "1"
```

其他一切保持不变——两阶段操作步骤、`claimRef` 预留、`Retain`。

### 交叉绑定风险在实例之间移动

单副本实例有一个代理声明和一个卷，因此它不能与自己交换磁盘。风险并没有消失——**它移动到实例之间的边界**。多个单副本实例共享一个 `no-provisioner` StorageClass，均从同一未保留卷池中提取，声明没有概念说明卷属于哪个实例。

这是常见的多租户形状：每个团队或命名空间一个小实例，每个实例在其自己的节点磁盘上，全部使用 `kafka-local`。

在持有不同数据的两个单副本集群上进行了测试。没有任何卷上的 `claimRef`，并且一个集群的 Pod 被调度到另一个集群的节点上——当通常的节点被隔离、已满或正在维护时会发生这种情况——第一个集群的声明绑定了 **第二个** 集群的卷。没有任何东西可以阻止一个租户的声明占用另一个租户的磁盘。

### 这里的失败是显而易见的，而不是静默的

这是单副本在多代理情况下表现 *更好* 的唯一地方。

每个单副本代理都是节点 ID 0，因此其日志目录始终是 `kafka-log0`。因此，落在另一个实例磁盘上的代理确实会找到一个 `kafka-log0`——另一个实例的——读取其 `meta.properties`，看到一个外部集群 ID，并拒绝启动：

```
Invalid cluster.id in /var/lib/kafka/data/kafka-log0/meta.properties.
Expected SrBFclR9RLSygr8RwS0G1g, but read TfB1UUCaQb-a6Y-IuwQtOw
```

它会崩溃循环，而受害者的数据则未受影响——事后确认：仍然是一个 `kafka-log0`，仍然是其原始大小。

与多代理情况形成对比，后者的代理具有 *不同* 的节点 ID，因此一个被移位的代理永远找不到自己的目录，静默地格式化一个新的目录并加入空的。**多代理交叉绑定静默丢失数据；单副本跨实例盗用导致停机但保留数据。**

停机仍然是停机。使用 `claimRef` 预留每个卷——在多租户环境中，这比其他地方更重要，因为卷在结构上是可互换的，租户无法相互看到。

## 第二天操作

### 删除并重新创建实例

使用 `deleteClaim: false`，删除实例会留下声明，重新创建它会重用这些声明而无需重新绑定。**在清理期间不要删除声明**，除非您也打算丢弃数据——这是导致交叉绑定的步骤。

:::danger 删除实例会破坏 KRaft 集群 ID
保留声明是 **不够的**。KRaft 集群 ID 存在于 Kafka 资源的 `status.clusterId` 中，每个池的 `status.clusterId` 作为后备——删除这些资源会删除它。会生成一个全新的随机 ID，随后每个代理都拒绝在其保留的磁盘上启动：

```
Invalid cluster.id in /var/lib/kafka/data/kafka-log0/meta.properties.
Expected 5jdttJxLSUOG-QJ7r__PYA, but read zUekwp_oQdSh47pToRAmcQ
```

数据是完整的；集群只是无法在没有原始 ID 的情况下重新组装。
:::

**在删除之前，记录集群 ID：**

```bash
kubectl -n demo-space get kafka rklocal -o jsonpath='{.status.clusterId}'
```

**要在之后恢复它**，修补状态 *并* 触发一次协调。仅修补是不够的：操作员在每个协调循环结束时会覆盖 `status`，并且仅在一个循环的 *开始* 读取集群 ID。这是一个竞争条件，因此请验证并重复，直到成功：

```bash
CID=<记录的集群 ID>
until [ "$(kubectl -n demo-space get cm rklocal-broker-a28da4-0 -o jsonpath='{.data.cluster\.id}')" = "$CID" ]; do
  kubectl -n demo-space patch kafka rklocal --subresource=status --type=merge \
    -p "{\"status\":{\"clusterId\":\"$CID\"}}"
  kubectl -n demo-space annotate kafka rklocal recovery-trigger="$(date +%s%N)" --overwrite
  sleep 10
done
kubectl -n demo-space delete pod -l strimzi.io/cluster=rklocal
```

如果您不再拥有 ID，请从任何保留的 `kafka-log*/meta.properties` 中读取它——它也会出现在代理的 `Invalid cluster.id … but read <ID>` 错误中。

### 替换故障节点

代理的身份是其节点 ID，数据位于故障节点的磁盘上。

- **磁盘存活**：将其移动到替换节点，挂载到相同路径，并将卷的 `nodeAffinity` 编辑为新主机名。代理将以其数据重新启动并重新加入，而无需复制流量。
- **磁盘丢失**：删除声明和卷，使用相同的名称和相同的 `claimRef` 重新创建两者，让代理从其对等体重新复制。仅在其他代理持有每个分区的同步副本时安全——首先检查 `--under-replicated-partitions`，并逐个处理代理。

### 扩展磁盘

本地卷不能由操作员扩展。在主机上扩展文件系统，然后更新卷上的 `capacity.storage`。

增加 `spec.storage.size` 是一个被接受的更改，因此会尝试调整大小；使用 `allowVolumeExpansion: false`，它会立即停止并记录 `PvcResizingWarning`。无害，但会留下一个持续的警告。不要 *减少* 大小——缩小会被拒绝并导致整个存储块被忽略。

无论哪种方式，声明的 `status.capacity` 始终报告原始大小。没有 CSI 驱动程序支持 `no-provisioner` 类，因此没有东西会更新它。在节点上使用 `df`。

## 故障排除

### 创建实例后没有任何反应

没有 Pod，没有声明，实例本身没有错误。检查 Kafka 资源的条件以查看是否有入场拒绝：

```bash
kubectl -n demo-space get kafka rklocal -o jsonpath='{.status.conditions[0].message}'
```

`StorageClass "…" is not allowed in project "…"` 意味着 StorageClass 尚未授予项目——见步骤 2。

### 声明保持 `Pending`

将其与应绑定的卷进行比较。四个字段必须一致：`storageClassName`、`accessModes`、`volumeMode` 和容量（卷 ≥ 声明请求）。还要确认保留的名称完全匹配——`claimRef.name` 中的拼写错误会使双方永远等待，没有其他症状。

```bash
kubectl -n demo-space describe pvc data-rklocal-broker-a28da4-0
kubectl describe pv rk-broker-0
```

### Pod 因卷节点亲和性冲突而保持 `Pending`

调度程序无法找到同时满足 Pod 的约束和卷的 `nodeAffinity` 的节点。通常，卷中的主机名与节点的实际 `kubernetes.io/hostname` 不匹配。

```bash
kubectl get node --show-labels | grep hostname
```

### 恢复已释放的卷

当其声明被删除时，卷会变为 `Released`。使用 `Retain`，数据是完整的，但它不会再次绑定，因为其 `claimRef` 现在携带已删除声明的 UID。

仅删除 **UID 和 resourceVersion**，保留命名空间和名称。这将使其返回 `Available` 状态，同时保留预留：

```bash
kubectl patch pv rk-broker-0 --type=json -p='[
  {"op": "remove", "path": "/spec/claimRef/uid"},
  {"op": "remove", "path": "/spec/claimRef/resourceVersion"}
]'
```

**不要** 清除整个 `claimRef`。这会使卷再次成为自由代理，并重新引入此设计存在的竞争条件。

### 恢复错误绑定

症状：一个磁盘上有多个 `kafka-log*` 目录，一个主题丢失了消息，或者一个代理因 `Invalid cluster.id` 崩溃循环。实例可能报告健康，代理 `1/1 Running`——见
[错误磁盘上的代理做了什么](#错误磁盘上的代理做了什么)。

1. **停止。** 不要删除任何日志目录，也不要删除声明以“重置”代理。每个字节仍然在磁盘上；删除是实际丢失数据的唯一方法。
2. **通过目录大小而不是 `meta.properties` 确定每个磁盘的真实所有者。** 新格式化的目录也携带一个有效的 `node.id`，因此该文件无法告诉您谁拥有磁盘。持有真实数据的目录可以：

   ```bash
   # 在每个 Kafka 节点上
   du -sh /cpaas/rk-broker/kafka-log*/
   grep -H "" /cpaas/rk-broker/kafka-log*/meta.properties
   ```

   大目录是实际数据，其 `<N>` 是磁盘的真实所有者；小目录（几十 KB）是一个错误绑定的代理创建的空日志。孤立目录也携带 *原始* 集群 ID。
3. 记录该原始集群 ID——您在步骤 6 中需要它。
4. 删除实例，然后删除声明。数据在 `Retain` 卷上，未被触及。
5. 将每个卷的 `claimRef` 设置为真正拥有该磁盘的代理的声明，然后像上面一样清除过时的 UID。验证所有卷报告 `Available`，并与预期声明匹配。
6. 重新创建实例并恢复集群 ID，按照
   [删除并重新创建实例](#删除并重新创建实例)。
7. 重新验证：每个磁盘上恰好一个 `kafka-log*` 目录。

一旦每个代理回到其自己的磁盘，留下的空目录是无害的——代理只会读取自己的 `kafka-log<N>`。在步骤 5 中删除它们，一旦您写下哪个是哪个，以恢复“每个磁盘一个目录”的不变性。

此过程在一个实时集群上进行了测试：一个主题从 1000 条消息降至 0，恢复到所有 1000 条消息。

## 为什么这样设计

以上所有内容基于四个选择。本节解释每个选择。

### 使用 `local` 卷，而不是 `hostPath`

两者都指向主机上的路径，但在重要的地方有所不同：

|                     | `hostPath`                                                                                                            | `local`                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `spec.nodeAffinity` | 可选——没有它也会被接受                                                                                              | **必需**——API 服务器拒绝没有它的卷                                  |
| 调度程序意识       | 不会将 Pod 限制在持有数据的节点上                                                                                   | 通过卷的 `nodeAffinity` 过滤候选节点                                   |
| 如果 Pod 移动      | kubelet 在它落在的任何节点上解析相同的路径，当 `type` 为 `DirectoryOrCreate` 或未设置时会创建                     | Pod 只能调度到拥有卷的节点                                           |
| `fsGroup` 所有权    | **不应用**——kubelet 不会更改主机路径的所有权                                                                          | 应用——kubelet 将组所有权调整为 Pod 的 `fsGroup`                      |

没有 `nodeAffinity` 的 `hostPath` 卷是故障模式 1 的直接原因：Pod 被重新调度，kubelet 在 *新* 节点上解析相同的路径，Kafka 启动时指向一个空目录或属于其他人的目录。

在 ACP v4.3 上确认了这两个差异。API 服务器拒绝省略 `nodeAffinity` 的 `local` 卷，因此错误配置甚至无法表达：

```
The PersistentVolume "…" is invalid: spec.nodeAffinity:
  Required value: Local volume requires node affinity
```

`fsGroup` 行首先咬人。Kafka 以 UID 1001 运行，`hostPath` 目录为 `root:root 0755`；因为 kubelet 不会将 `fsGroup` 应用到主机路径，代理无法写入并崩溃循环：

```
Error while writing meta.properties file /var/lib/kafka/data/kafka-log0:
  java.nio.file.AccessDeniedException: /var/lib/kafka/data/kafka-log0
```

使用 `local` 卷时不会发生这种情况。从相同的 `root:root 0755` 目录，kubelet 在挂载时将其调整为 `drwxrwsr-x`，实例第一次以默认权限启动。

如果您必须保留 `hostPath`，请显式设置 `nodeAffinity`——在存在时会被尊重——并使目录可写或以 root 身份运行 Pod，遵循
[以 root 用户身份运行 Kafka Pod](./How_to_Run_Kafka_as_Root_User.md)。

### 名称的派生方式

卷声明名称由实例名称、生成的池名称和节点 ID 构成：

| 对象           | 名称                                    |
| -------------- | --------------------------------------- |
| 代理 Pod       | `<instance>-broker-<hash>-<nodeId>`     |
| 控制器 Pod     | `<instance>-controller-<hash>-<nodeId>` |
| 声明           | `data-<podName>`                        |

代理使用节点 ID 0–2，控制器使用 3–5。`<hash>` 是 **每个实例生成的**——在同一集群上观察到的两个实例分别携带 `cb42e1` 和 `a28da4`——因此在实例存在之前无法预测。这就是操作步骤分为两个阶段的原因。

每个声明固定为 `accessModes: [ReadWriteOnce]` 和 `volumeMode: Filesystem`，从存储块中获取其类和大小。

### 为什么修复必须在卷侧

有两个选项看起来可以解决每个代理的放置，但都不可用：

- **`storage.selector` 不存在。** 实例的存储块仅接受 `class`、`size` 和 `deleteClaim`。即使在底层资源上，选择器也会将 *相同* 的标签选择器应用于池中的每个声明，因此它可以缩小候选集，但无法说明“代理 0 获取这个”。
- **每个代理的存储类覆盖被忽略。** 该字段已弃用且不被读取。

这使得卷侧成为唯一的选择，其中 `spec.claimRef` 为一个特定声明保留一个卷。

### 预绑定的工作原理

`claimRef` 是预留机制。设置为一个 `{namespace, name}`，该名称尚不存在，卷保持 `Available` 状态，控制平面将仅将其绑定到该声明。当声明出现时，预绑定卷在普通的“查找任何匹配卷”搜索运行之前进行匹配，因此它优先——并且它与 `WaitForFirstConsumer` 一起工作，这使得两阶段操作成为可能。

省略 `uid`。仅带有命名空间和名称的 `claimRef` 是预留；控制平面在绑定时填充 UID。携带 *过时* UID 的 `claimRef`——在声明被删除后留下的——不匹配任何内容，并使卷停留在 `Released` 状态。

### 交叉绑定失败的根本原因

报告是同时重启所有代理 Pod 会打乱绑定。机制接近，但触发条件不同，而差异决定了修复。

**绑定的声明永远不会更改其卷。** 一旦设置，`spec.volumeName` 是不可变的，声明在 Pod 重启、重新调度或滚动时不会被删除。这一点得到了直接验证：所有代理 Pod 同时删除，每个 Pod 返回到其原始节点，声明绑定到相同的卷，测试主题仍然持有所有 1000 条消息，且完整的 ISR。

**绑定在声明创建时决定，并且是先到先得。** Kubernetes 根据存储类、容量、访问模式和卷模式进行匹配。没有身份概念：任何满足请求的卷都是候选者，且相同的卷同样满足所有声明。初始绑定在测试中从未按名称排序——一次运行将代理 0/1/2 绑定到卷 c/b/a，另一次绑定到 c/a/b。

因此，交叉绑定发生在 **声明创建时**，而不是 Pod 重启时：

- 实例被删除并重新创建，声明被移除。
- 命名空间被删除并重新创建。
- 手动删除声明以“重置”代理。
- Pod 名称发生变化：实例被重命名，或在扩展周期后重新分配节点 ID。

在所有这些情况下，新声明与仍持有数据的保留卷竞争，最终的映射与输入的映射没有关系。

### 代理在错误磁盘上的行为

这就是使故障危险的原因，并不是大多数人所期望的。

Kafka 的日志目录是根据代理的 **自身** 节点 ID 命名的：`<mountPath>/kafka-log<nodeId>`。落在外部磁盘上的代理根本不读取其他代理的 `meta.properties`——它查找自己的 `kafka-log<N>`，没有找到一个，并得出该磁盘是新的结论。

**常见结果是静默的。** 它在孤立目录旁边格式化一个新的、空的 `kafka-log<N>`，启动时报告 `1/1 Running`，并作为一个空副本加入。没有任何东西记录错误。

**响亮的结果是例外。** 只有当代理保留一个已经包含 *它自己的* `kafka-log<N>` 的磁盘时，它才会崩溃，并且集群 ID 此后发生了变化。

在三个代理的测量中，经过一次声明重建，交换了代理 1 和 2：

| 代理 | 落在       | 结果                                                                           |
| ---- | ----------- | -------------------------------------------------------------------------------- |
| 0    | 自己的磁盘 | `CrashLoopBackOff` — `Invalid cluster.id`                                        |
| 1    | 代理 2 的磁盘 | `Running 1/1` — 空的 `kafka-log1` 在代理 2 的 904K `kafka-log2` 旁边格式化 |
| 2    | 代理 1 的磁盘 | `Running 1/1` — 空的 `kafka-log2` 在代理 1 的 904K `kafka-log1` 旁边       |

三分之二报告健康。主题从 1000 条消息降至 **0**，而原始数据的每个字节仍然在孤立目录中的磁盘上。

#### 为什么 node.id 检查不起作用

从代理 Pod 内读取 `meta.properties` 并 **不** 找到错误绑定。代理 1 读取 `kafka-log1/meta.properties`，其中显示 `node.id=1`——它匹配，因为代理刚刚几分钟前写入了该文件。可靠的信号是 **一个磁盘上有多个 `kafka-log*` 目录**，这就是为什么步骤 6 检查这一点。

## 限制和待解决事项

- **固定的代理无法故障转移。** 这是设计，而不是缺陷。如果一个节点宕机，该代理将宕机，直到它返回。可用性来自复制因子 3 和 `min.insync.replicas: 2`；有了这些，一个节点宕机是健康集群。两个节点宕机是停机，没有存储配置会改变这一点。
- **集群范围的对象。** 卷和 StorageClasses 不能由命名空间范围的租户创建，授予 StorageClass 给项目是平台管理员的操作。两者必须在租户创建实例之前完成。
- **测试内容。** 在 ACP v4.3 上，使用三个工作节点：通过实例 API 完整操作步骤，包括在卷之前创建声明的两阶段绑定，以及同时删除所有 Pod。故障和恢复场景——交叉绑定、集群 ID 丢失、错误绑定恢复和单副本情况——在底层 Kafka 资源上进行了测试，使用了 `hostPath` 和 `local` 卷；它们覆盖的卷侧机制是相同的。节点故障和磁盘更换 **未** 测试。
- **Kafka 2.x / ZooKeeper 线。** 传统的基于 ZooKeeper 的线没有单独的控制器池：存储位于代理和 ZooKeeper 部分下，声明名称为 `data-<cluster>-kafka-<n>` 和 `data-<cluster>-zookeeper-<n>`，ZooKeeper 需要自己的三个卷。卷侧设计——`claimRef` 预绑定加上 `nodeAffinity`——保持不变，这是重要的部分。
