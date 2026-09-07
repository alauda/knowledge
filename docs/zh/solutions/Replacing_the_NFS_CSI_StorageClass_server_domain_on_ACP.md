---
kind:
  - Solution
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.2.x,4.3.x,4.4.x'
id: KB260900019
sourceSHA: 02922f603fc6b6c5d61f1af7807ce5ff201981f4a502b7dd5795980d4f8ec2f7
---

# 在 ACP 上切换 NFS CSI StorageClass 服务器域

## 问题

NFS CSI StorageClass (`provisioner: nfs.csi.k8s.io`) 将 NFS 服务器存储在 `parameters.server` 中。当 PVC 被创建时，CSI 驱动程序将该服务器写入生成的 PV 的 `spec.csi.volumeAttributes.server` 和 `spec.csi.volumeHandle` 中。

Kubernetes 不允许在原地更改现有 StorageClass 的 `parameters` 字段、PV CSI 源或已绑定 PVC 的 `storageClassName` 和 `volumeName`。因此，切换新旧 PVC 需要两个操作：

1. 删除并重新创建具有 **相同名称** 和新服务器域的 StorageClass，以便后续创建的 PVC 使用新域。
2. 重新创建每个现有 PVC/PV 对象，以便现有声明使用具有新域的新 PV。

现有 PVC 的迁移需要一个卸载窗口。当旧域和新域暴露相同的逻辑 NFS 服务器和导出时，NFS 数据不会被复制；新 PV 是对同一子目录的另一个 CSI 引用。

## 前提条件

仅在以下所有条件都为真时使用此操作步骤：

- StorageClass 的提供者为 `nfs.csi.k8s.io`。
- 旧域和新域标识相同的逻辑 NFS 服务器和相同的导出。
- 导出路径、子目录、数据、UID/GID 映射、权限、ACL 和挂载选项兼容。
- 新域可以从每个可能挂载 PVC 的节点访问。
- 每个 PVC 或应用程序都有可用的维护窗口。

旧域和新域不需要解析为相同的 IP。NFS 服务器可以通过多个 IP、VIP 或故障转移地址暴露相同的导出。IP 检查仅证明网络可达性；它们并不能证明存储身份。

如果新域标识不同的 NFS 后端，请停止并使用数据复制和后端迁移操作步骤。

## Kubernetes 和 NFS CSI 限制

`StorageClass.parameters` 在创建后是不可变的。以下服务器端干运行必须被拒绝：

```bash
kubectl patch storageclass <storage-class-name> --type=merge \
  --dry-run=server \
  -p '{"parameters":{"server":"<new-domain>"}}'
```

PV CSI 源在创建后也是不可变的。`spec.csi.volumeAttributes.server` 和 `spec.csi.volumeHandle` 不能被补丁。已绑定的 PVC 不能重新定向到另一个 PV；其 `spec.volumeName` 已由绑定器设置。

NFS CSI 驱动程序在 `NodePublishVolume` 中使用 `volumeAttributes.server`。其 `volumeHandle` 也包含服务器作为第一个组件，必须在替换 PV 中一致更新。StorageClass 参数通常命名为 `subDir`，而生成的 PV 属性通常显示为 `subdir`；保留原始 PV 中的拼写和数值。

## 操作步骤

### 1. 确认 NFS 服务器和导出

请 NFS 管理员确认两个域标识相同的逻辑 NFS 服务器和导出。从工作节点或等效的调试 Pod 验证 DNS 和 NFS 端口的可达性：

```bash
getent hosts <old-domain>
getent hosts <new-domain>
nc -vz <new-domain> 2049
```

仅对于 NFSv3，可以使用 `showmount -e <new-domain>` 检查导出。NFSv4 通常没有 rpcbind/mountd 端点用于 `showmount`；请在步骤 3 中通过 PVC/Pod 挂载测试验证导出。

如果新端点不可达或无法建立导出/数据身份，请不要继续。

### 2. 删除并重新创建同名 StorageClass

在此操作期间，冻结新 PVC 的创建、自动扩展和冲突的 GitOps 协调。保持原始备份不变，并为新域创建一个工作副本：

```bash
SC=<storage-class-name>
WORKDIR="nfs-domain-migration-$(date +%Y%m%d%H%M%S)"
mkdir -p "$WORKDIR"

kubectl get csidriver nfs.csi.k8s.io
kubectl get storageclass "$SC" -o yaml --show-managed-fields=false \
  > "$WORKDIR/storageclass.yaml"
cp "$WORKDIR/storageclass.yaml" "$WORKDIR/storageclass.new.yaml"
```

按如下方式编辑 `storageclass.new.yaml`：

- 保持 `metadata.name` 不变。
- 仅将 `parameters.server` 更改为 `<new-domain>`。
- 保持 `share`、mountOptions、reclaimPolicy、volumeBindingMode、labels 和 annotations 不变。
- 删除 `creationTimestamp`、`resourceVersion`、`uid` 和 `generation`。

然后替换对象：

```bash
kubectl delete storageclass "$SC"
kubectl apply -f "$WORKDIR/storageclass.new.yaml"
kubectl get storageclass "$SC" \
  -o jsonpath='server={.parameters.server}{"\n"}'
```

在对象缺失的短暂时间内，引用此 StorageClass 的新 PVC 不能被创建。现有绑定的 PVC 继续使用其当前的 PV。

### 3. 验证新 PVC

使用原始 StorageClass 名称创建临时 PVC 和 Pod。测试工作负载必须写入和读取标记文件。在 PVC 处于 `Bound` 状态且 Pod 准备就绪后，找到其 PV 并检查服务器：

```bash
kubectl get pvc -n <test-namespace> <test-pvc> \
  -o jsonpath='pv={.spec.volumeName}{"\n"}'
kubectl get pv <test-pv> \
  -o jsonpath='server={.spec.csi.volumeAttributes.server}{"\n"}handle={.spec.csi.volumeHandle}{"\n"}'
kubectl -n <test-namespace> exec <test-pod> -- \
  sh -c 'echo nfs-domain-cutover > /mnt/domain-marker && cat /mnt/domain-marker'
```

生成的 PV 必须在 `volumeAttributes.server` 和 `volumeHandle` 的第一个组件中包含 `<new-domain>`。如果此测试失败，请仅删除临时 PVC/Pod，并在清理生成的元数据后从未更改的 `storageclass.yaml` 备份中恢复 StorageClass。请勿开始现有 PVC 的迁移。

### 4. 迁移现有 PVC

在此阶段开始时，列出所有引用 StorageClass 的 PVC。PVC 的 `spec.volumeName` 标识 PV；仅在处理该 PVC 时检索完整的 PV YAML。

```bash
kubectl get pvc -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,SC:.spec.storageClassName,PV:.spec.volumeName,PHASE:.status.phase' \
  | tee "$WORKDIR/pvc-inventory.txt"
```

一次处理一个 PVC 或一个应用程序。`Pending` PVC 没有绑定的 PV 进行迁移，必须单独调查。

#### 4.1 停止工作负载并保存对象

对于每个绑定的 PVC，找到实际挂载它的 Pods，然后检查它们的拥有者并手动停止 Deployment、StatefulSet 或其他工作负载：

```bash
PVC_NS=<pvc-namespace>
PVC_NAME=<pvc-name>
OLD_PV=<old-pv-name>

kubectl -n "$PVC_NS" get pods \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.volumes[*]}{.persistentVolumeClaim.claimName}{" "}{end}{"\n"}{end}' \
  | grep -w "$PVC_NAME"

POD_NAME=<pod-name>
kubectl -n "$PVC_NS" get pod "$POD_NAME" \
  -o jsonpath='{range .metadata.ownerReferences[*]}{.kind}/{.name}{"\n"}{end}'

# 使用上面返回的工作负载类型和名称。
kubectl -n "$PVC_NS" scale deployment/<workload-name> --replicas=0
kubectl -n "$PVC_NS" wait --for=delete "pod/${POD_NAME}" --timeout=120s
```

如果多个 Pods 挂载 PVC，请在继续之前等待每个 Pod 被删除。保存对象而不包含 `managedFields`：

```bash
kubectl get pv "$OLD_PV" -o yaml --show-managed-fields=false \
  > "$WORKDIR/pv-${OLD_PV}.backup.yaml"
kubectl -n "$PVC_NS" get pvc "$PVC_NAME" -o yaml \
  --show-managed-fields=false \
  > "$WORKDIR/pvc-${PVC_NS}-${PVC_NAME}.backup.yaml"
```

在迁移工作负载经过验证之前，请保留这些备份。

#### 4.2 保护旧 PV 并保留数据

将旧 PV 的回收策略设置为 `Retain`，并在删除 PVC 之前读取它：

```bash
kubectl patch pv "$OLD_PV" --type=merge \
  -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl get pv "$OLD_PV" \
  -o jsonpath='reclaim={.spec.persistentVolumeReclaimPolicy}{"\n"}'
```

仅在输出为 `Retain` 时继续。在删除 PVC 之后，旧 PV 必须保持为 `Released`；其 NFS 子目录必须保持完整。

#### 4.3 准备并创建替换 PV

将保存的 PV YAML 复制到新文件中。请勿应用原始备份。删除新 PV 清单中的以下字段：

- `metadata.creationTimestamp`、`resourceVersion`、`uid`、`generation` 和 `finalizers`；
- `status`；
- 绑定控制器注释，如 `pv.kubernetes.io/bind-completed` 和 `pv.kubernetes.io/bound-by-controller`；
- `spec.claimRef.uid` 和其他旧的 claimRef 元数据，仅保留 PVC 的命名空间和名称。

修改这些字段：

- 将 `metadata.name` 设置为新 PV 名称，例如 `<old-pv-name>-migrated`；
- 将 `spec.persistentVolumeReclaimPolicy` 设置为 `Retain`；
- 将 `spec.csi.volumeAttributes.server` 更改为 `<new-domain>`；
- 替换 `spec.csi.volumeHandle` 中的第一个服务器组件，保持共享和子目录后缀不变；
- 保持容量、访问模式、volumeMode、mountOptions、share、subdirectory 和其他 CSI 属性不变，除非驱动程序写入了 PV 名称属性。

替换 PV 示例：

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: <old-pv-name>-migrated
  annotations:
    pv.kubernetes.io/provisioned-by: nfs.csi.k8s.io
spec:
  capacity:
    storage: <same-capacity>
  accessModes:
    - ReadWriteMany
  volumeMode: Filesystem
  persistentVolumeReclaimPolicy: Retain
  storageClassName: <storage-class-name>
  mountOptions:
    - nfsvers=4.1
  claimRef:
    namespace: <pvc-namespace>
    name: <pvc-name>
  csi:
    driver: nfs.csi.k8s.io
    volumeHandle: <new-domain>#<original-share-and-subdirectory-suffix>
    volumeAttributes:
      server: <new-domain>
      share: <same-share>
      subdir: <same-subdir>
```

#### 4.4 准备并创建替换 PVC

将保存的 PVC YAML 复制到新文件中。删除 `metadata.creationTimestamp`、`resourceVersion`、`uid`、`generation`、`finalizers`、`status` 和绑定控制器注释。仅将 `spec.volumeName` 更改为新 PV 名称；保持原始 StorageClass 名称、容量、访问模式、volumeMode、标签和所需注释不变。

替换 PVC 示例：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <pvc-name>
  namespace: <pvc-namespace>
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: <same-capacity>
  volumeMode: Filesystem
  storageClassName: <storage-class-name>
  volumeName: <old-pv-name>-migrated
```

在检查两个新清单后，切换对象：

```bash
kubectl -n "$PVC_NS" delete pvc "$PVC_NAME" --wait=true
kubectl wait --for=jsonpath='{.status.phase}'=Released \
  "pv/${OLD_PV}" --timeout=120s
kubectl create -f "$WORKDIR/pv-${NEW_PV}.yaml"
kubectl create -f "$WORKDIR/pvc-${PVC_NS}-${PVC_NAME}.new.yaml"
kubectl wait --for=jsonpath='{.status.phase}'=Bound \
  -n "$PVC_NS" "pvc/${PVC_NAME}" --timeout=120s
```

PVC 名称和工作负载的 `claimName` 保持不变。新 PVC 静态绑定到替换 PV，并且不得触发另一个子目录的动态提供。

#### 4.5 启动并验证工作负载

重新启动工作负载并验证：

- Pod 正在运行/就绪；
- 替换 PV 具有新服务器和句柄；
- 原始文件存在；
- 应用程序的读取和写入成功；
- 日志中没有过时的文件句柄、权限或挂载错误。

验证后，可以删除旧 PV 对象，同时保持其为 `Retain`；删除该对象不会删除 NFS 目录。如有需要，恢复替换 PV 的原始回收策略。

### 5. 结束

在所有绑定的 PVC 迁移完成后，检查目标 PV 和 StorageClass：

```bash
kubectl get pv -o custom-columns=\
NAME:.metadata.name,SC:.spec.storageClassName,SERVER:.spec.csi.volumeAttributes.server,CLAIM:.spec.claimRef.name,PHASE:.status.phase
kubectl get storageclass <storage-class-name> \
  -o jsonpath='server={.parameters.server}{"\n"}'
```

所有目标 PVC 必须处于 `Bound` 状态，所有使用的 Pods 必须健康，且没有目标 PV 仍引用旧域。保持旧 NFS 域和后端可用，直到观察窗口和回滚窗口结束。

## 回滚

如果在 PVC 迁移之前 StorageClass 验证失败，请在删除生成的元数据后，从原始 `storageclass.yaml` 备份中重新创建同名 StorageClass。

如果某个 PVC 迁移失败，请停止其工作负载，删除替换 PVC/PV，并从备份中恢复旧 PV/PVC。旧 PV 必须为 `Retain`，并且旧 NFS 域必须仍然可解析。

如果已经迁移了多个 PVC，仅恢复 StorageClass 是不够的。反向迁移每个已经切换的 PVC/PV。在回滚不再需要之前，请勿删除旧域或后端。

## 不同的 IP 地址

仅在 NFS 管理员确认两个域暴露相同的逻辑 NFS 服务器和导出，并且新端点通过可达性、挂载、数据和权限检查时，才接受不同的 IP 地址。

如果域标识不同的 NFS 后端，请首先在维护窗口期间复制数据并完成最终一致性同步。只有在此之后，才执行 PV/PVC 对象替换。在这种情况下，仅更改主机名可能会挂载一个空或不相关的目录，并可能导致回滚丢失在新后端上进行的写入。
