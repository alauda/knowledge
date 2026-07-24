---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB260700088
sourceSHA: 74e14867aa7cb2c4405a45bfc63134a1f9376f7b72fb2a7ce076f2bfb2cdb504
---

# 如何将 NFS PersistentVolumes 迁移到 OceanStor Dorado 并在原地重新绑定 PVC

## 概述

`PersistentVolumeClaim.spec.volumeName` 是不可变的。现有的 PVC 不能更新以引用不同的 PersistentVolume。要在不更改 PVC 名称的情况下将工作负载迁移到新的 NFS 卷，请删除并使用相同名称重新创建 PVC，并将新的 PV 预绑定到该声明。

本指南描述了如何复制数据、为原始 PVC 名称保留新的 PV，并恢复工作负载。该操作步骤需要一个维护窗口。它已针对 Deployment 和 StatefulSet 工作负载进行了验证。

对于 StatefulSet，从 `volumeClaimTemplates` 生成的 PVC 名称保持不变。迁移后，必须使用更新的模板重新创建 StatefulSet，以便后续的扩展操作使用新的 StorageClass。

## 环境

| 组件                           | 版本                                           |
| ------------------------------ | ---------------------------------------------- |
| 容器平台                       | ACP 4.x (在 4.3.1 上验证)                     |
| 节点操作系统                   | Micro OS 5.5                                   |
| 存储设备                       | OceanStor Dorado 6.1.9                         |
| OceanStor CSI 驱动程序        | v4.12.0                                       |
| 源存储                         | NFS，由 `nfs.csi.k8s.io` 提供                  |
| 目标存储                       | Dorado NFS (`volumeType: fs`)                  |
| 验证的工作负载                 | Deployment (RWX)，StatefulSet (RWO, 2 ordinals) |

> **注意**：数据复制操作适用于 `Filesystem` 模式卷。`Block` 模式卷需要块级复制方法。PVC 重新绑定操作仅使用 Kubernetes 对象，并且可以应用于其他存储类型。

## 先决条件

- 已安装 OceanStor CSI 驱动程序的 ACP 4.x 集群，并且有可用的目标 NFS StorageClass。
- 具有补丁 PersistentVolumes 权限的 `kubectl` 访问权限，这些资源是集群范围的。
- 可以停止工作负载的维护窗口。
- 目标阵列上有足够的容量用于新的卷。
- 包含 `rsync` 或其他保留所需文件元数据的复制工具的镜像。
- 当前备份和经过验证的工作负载回滚计划。

本指南中使用了以下占位符。请将其替换为您环境中的值：

| 占位符           | 描述                                                  |
| ---------------- | ----------------------------------------------------- |
| `<namespace>`    | 工作负载命名空间                                      |
| `<pvc>`          | 现有 PVC 名称，保持不变                              |
| `<tmp-pvc>`      | 用于提供目标卷的临时 PVC                            |
| `<storage-class>`| 由新阵列支持的目标 StorageClass                     |
| `<workload>`     | 工作负载资源，例如 `deploy/app` 或 `sts/web`       |
| `<selector>`     | 工作负载 Pods 的标签选择器                          |
| `<new-pv>`       | 为临时目标 PVC 提供的 PV                            |

## 解决方案

### 1. 审查 PVC 重新绑定要求

迁移有两个操作：

- 将数据从源卷复制到目标卷。
- 将原始 PVC 名称重新绑定到目标 PV。

PVC 必须被删除并重新创建，因为 `PersistentVolumeClaim.spec.volumeName` 不能更改。工作负载清单可以继续引用原始 PVC 名称。

PV 在 `PersistentVolume.spec.claimRef` 中记录其 PVC 绑定：

| 字段               | 意义                                                             |
| -------------------| ----------------------------------------------------------------- |
| `namespace`, `name`| 拥有该卷的声明的命名空间和名称                                   |
| `uid`              | 特定 PVC 对象的 UID；重新创建的 PVC 具有不同的 UID               |
| `resourceVersion`  | 引用对象的乐观并发令牌                                           |

这些字段决定 PV 状态：

| `claimRef` 条件                                               | PV 状态和行为                        |
| ------------------------------------------------------------ | ------------------------------------ |
| 无 `claimRef`                                                | `Available`；任何匹配的 PVC 可以绑定  |
| 存在 `namespace` 和 `name`，但缺少 `uid`                    | `Available`；为命名 PVC 保留         |
| 完整的 `claimRef`，且引用的 PVC 存在                        | `Bound`                              |
| 完整的 `claimRef`，但具有该 `uid` 的 PVC 不再存在           | `Released`                           |

`Released` 状态的 PV 不会自动返回到 `Available`。因此，保留新的 PV 需要两个合并补丁。第一个补丁设置目标 `namespace` 和 `name`。由于合并补丁保留未指定的字段，因此过时的 `uid` 保留，PV 保持 `Released`。第二个补丁必须显式将 `uid` 和 `resourceVersion` 设置为 `null`。

在开始之前，确认最终 PVC 在以下所有方面将与目标 PV 匹配：

- 请求的容量不超过 PV 容量。
- PVC 访问模式被 PV 支持。
- `storageClassName` 与 PV 完全匹配。

### 2. 提供目标卷

读取源 PVC，以便临时 PVC 使用兼容的访问模式和容量：

```bash
kubectl -n <namespace> get pvc <pvc> \
  -o custom-columns=\
NAME:.metadata.name,MODES:.spec.accessModes,SIZE:.spec.resources.requests.storage
```

在目标 StorageClass 上创建临时 PVC：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <tmp-pvc>
  namespace: <namespace>
spec:
  # 设置为源 PVC 的访问模式，在上一个命令中读取。
  # ReadWriteMany 与验证的 Deployment 匹配；验证的 StatefulSet
  # 使用 ReadWriteOnce。请勿无意中扩大模式。
  accessModes: ["ReadWriteMany"]
  storageClassName: <storage-class>
  resources:
    requests:
      # 必须 >= 源卷。后面的重新绑定步骤会针对同一卷创建最终声明，
      # 因此其容量在此处固定。
      storage: 2Gi
```

等待 PVC 被绑定：

```bash
kubectl -n <namespace> wait --for=jsonpath='{.status.phase}'=Bound \
  pvc/<tmp-pvc> --timeout=180s
```

对于 StatefulSet，每个序号创建一个目标 PVC。

### 3. 复制初始数据

创建一个临时 Pod，挂载源和目标 PVC：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: migrator
  namespace: <namespace>
spec:
  restartPolicy: Never
  containers:
    - name: m
      image: <image-with-rsync>
      command: ["sh", "-c", "sleep infinity"]
      volumeMounts:
        - {name: src, mountPath: /src}
        - {name: dst, mountPath: /dst}
  volumes:
    - name: src
      persistentVolumeClaim: {claimName: <pvc>}
    - name: dst
      persistentVolumeClaim: {claimName: <tmp-pvc>}
```

在应用程序仍在运行时运行初始复制。此步骤在维护窗口之前移动大部分数据：

```bash
kubectl -n <namespace> exec migrator -- \
  rsync -aHAX --numeric-ids --delete --exclude='/.snapshot' /src/ /dst/
```

尽可能使用 `rsync`，以便最终步骤仅传输更改的数据。注意以下选项及其限制：

- `-H` 保留硬链接，`-A` 保留 POSIX ACL，`-X` 保留扩展属性。
- `--numeric-ids` 按数字值同步 UID/GID，而不是按用户和组名称，这样在源和目标主机具有不同的名称到 ID 映射时可以保持所有权正确。它不会覆盖 NFS 压缩：`root_squash` 和 `all_squash` 由 NFS 服务器应用于客户端的凭据，与任何 `rsync` 标志无关。
- `-aHAX` 不包括 `--sparse`。如果数据包含稀疏文件，例如虚拟机镜像或预分配的数据库文件，请添加 `-S`，以便不会将孔写入为真实数据，并相应地调整目标卷的大小。
- `--exclude='/.snapshot'` 防止 `--delete` 尝试删除目标卷的只读 `.snapshot` 目录。前导斜杠将匹配限制为卷根。

如果没有排除，`rsync` 可能会报告以下错误并以非零状态退出：

```text
rmdir: '/data/.snapshot': Permission denied
rm:    can't remove '/data/.snapshot': Permission denied
```

由于复制跨 NFS 进行，复制过程必须能够读取每个源文件并在目标上设置所有权。以 UID 0 运行迁移器，确认源导出不压缩根，并确认目标导出允许 `chown`。否则，`0600` 文件可能无法读取或无法恢复所有权。在完整复制之前测试一个代表性文件。

如果没有包含 `rsync` 的镜像，以下命令在 Pod 内运行并保留权限、所有权和符号链接，但每次传输所有数据：

```bash
kubectl -n <namespace> exec migrator -- sh -c 'tar -C /src -cf - . | tar -C /dst -xpf -'
```

普通的 `tar` 不带 `--xattrs --acls` 不会保留 POSIX ACL 或扩展属性，并将稀疏文件展开到其完整大小。根据工作负载的元数据要求选择复制方法。

源 PVC 由 `nfs.csi.k8s.io` 提供，其 `CSIDriver.spec.attachRequired` 为 `false`。NFS 卷不会通过 `VolumeAttachment` 附加，因此在应用程序也挂载它的情况下，将源 PVC 挂载到迁移器 Pod 上不会导致 `Multi-Attach error`，即使跨节点也是如此。迁移器可以在任何节点上运行。对于如 iSCSI 或 RBD 等基于附加的驱动程序，其中 `attachRequired` 为 `true`，`ReadWriteOnce` 源则要求迁移器和应用程序共享一个节点。在所有情况下，在复制仍在写入的卷之前评估应用程序一致性。

由于两个卷都使用 NFS，因此复制也可以在可以访问两个 NFS 服务器的主机上运行。这完全避免了集群内的 Pod，但需要适当的网络访问。

### 4. 用保留策略保护两个 PV

为剩余的操作步骤设置变量并记录目标和源 PV 名称：

```bash
NS=<namespace>; PVC=<pvc>; TMP=<tmp-pvc>; WORKLOAD=<workload>
NEWPV=$(kubectl -n $NS get pvc $TMP -o jsonpath='{.spec.volumeName}')
OLDPV=$(kubectl -n $NS get pvc $PVC -o jsonpath='{.spec.volumeName}')
```

在删除任何 PVC 之前，将两个 PV 的状态更改为 `Retain`：

```bash
kubectl patch pv $NEWPV -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl patch pv $OLDPV -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

> **警告**：在两个 PV 都使用 `Retain` 之前，请勿继续。在其 PV 仍使用 `reclaimPolicy: Delete` 时删除 PVC 可能会删除底层卷。必须保留新的 PV 以保护迁移的数据，旧的 PV 必须保留以保留回滚路径。这是唯一一个遗漏可能导致不可逆数据丢失的检查点。

验证两个策略：

```bash
kubectl get pv $NEWPV $OLDPV \
  -o custom-columns=NAME:.metadata.name,POLICY:.spec.persistentVolumeReclaimPolicy
```

### 5. 停止工作负载并完成最终同步

记录副本计数，停止工作负载，并等待其 Pods 被删除：

```bash
REPLICAS=$(kubectl -n $NS get $WORKLOAD -o jsonpath='{.spec.replicas}')
kubectl -n $NS scale $WORKLOAD --replicas=0
kubectl -n $NS wait --for=delete pod -l <selector> --timeout=300s
```

运行最终同步并比较文件校验和：

```bash
kubectl -n $NS exec migrator -- \
  rsync -aHAX --numeric-ids --delete --exclude='/.snapshot' /src/ /dst/

kubectl -n $NS exec migrator -- sh -c '
  set -eu
  for d in /src /dst; do
    ( cd "$d" && find . -type f -not -path "./.snapshot/*" -print0 \
        | sort -z | xargs -0 -r md5sum ) > /tmp/$(basename "$d").sum
  done
  diff /tmp/src.sum /tmp/dst.sum && echo CONTENT_OK'
```

`set -eu` 和 NUL 分隔 (`-print0` / `sort -z` / `xargs -0`) 处理是必需的：如果没有它们，包含空格的文件名会分成多个参数，而失败的 `md5sum` 只写入 stderr，因此两个空的 `.sum` 文件可能比较相等并打印 `CONTENT_OK`，即使数据不同。此检查紧接着 PVC 删除，因此不接受假阳性。

此检查仅比较常规文件内容。所有权、权限、ACL、扩展属性、符号链接目标和硬链接关系在此处未进行验证；请根据工作负载的要求单独检查它们（请参见 FAQ）。在校验和匹配之前请勿继续。

### 6. 删除并在原始名称下重新创建 PVC

删除迁移器 Pod 和两个 PVC：

```bash
kubectl -n $NS delete pod migrator
kubectl -n $NS delete pvc $TMP $PVC
```

两个 PV 进入 `Released` 状态并保留其数据。

为原始 PVC 名称保留新的 PV。按以下顺序运行两个合并补丁：

```bash
kubectl patch pv $NEWPV --type merge -p \
  "{\"spec\":{\"claimRef\":{\"apiVersion\":\"v1\",\"kind\":\"PersistentVolumeClaim\",\"namespace\":\"$NS\",\"name\":\"$PVC\"}}}"

kubectl patch pv $NEWPV --type merge -p \
  '{"spec":{"claimRef":{"uid":null,"resourceVersion":null}}}'
```

第二个合并补丁是必需的。如果没有它，过时的 `uid` 将保留在 `claimRef` 中，PV 将保持 `Released`。

确认新的 PV 是 `Available` 并为原始 PVC 名称保留：

```bash
kubectl get pv $NEWPV -o custom-columns=\
NAME:.metadata.name,STATUS:.status.phase,CLAIM:.spec.claimRef.name,UID:.spec.claimRef.uid
```

```text
NAME             STATUS      CLAIM      UID
pvc-0464141b-…   Available   app-data   <none>
```

使用其原始名称重新创建 PVC，并将其预绑定到新的 PV：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <pvc>            # 不变
  namespace: <namespace>
spec:
  accessModes: ["ReadWriteMany"]      # 与源 PVC 匹配 (StatefulSet 为 ReadWriteOnce)
  storageClassName: <storage-class>   # 必须与新 PV 完全匹配
  resources:
    requests:
      storage: 2Gi                    # 必须 <= PV 容量
  volumeName: <new-pv>
```

在重新启动工作负载之前，等待 PVC 变为 `Bound`。

### 7. 重启并验证工作负载

恢复记录的副本计数：

```bash
kubectl -n $NS scale $WORKLOAD --replicas=$REPLICAS
```

确认工作负载使用目标 NFS 挂载并验证应用程序数据：

```bash
kubectl -n $NS exec <pod> -- sh -c 'mount | grep " /data "'
```

对于经过验证的 Deployment，使用 `ReadWriteMany`，以下检查成功：

| 检查                     | 结果                                                          |
| ------------------------- | ------------------------------------------------------------- |
| 文件校验和               | 与迁移前的基线匹配                                          |
| 权限和所有权             | 保留，包括一个由 `1000:1000` 拥有的模式为 `600` 的文件      |
| 符号链接                 | 保留，包括相对目标                                          |
| Deployment 清单          | 不变并继续引用原始 PVC 名称                                  |
| 挂载点                   | 更改为目标 NFS 导出                                        |
| 并发写入                 | 两个副本和一个外部主机观察到彼此的写入                      |

对于经过验证的 StatefulSet，使用 `ReadWriteOnce` 和两个序号，每个序号保留其自己的数据和 PVC 名称，并且两个挂载点都更改为目标阵列，而没有跨卷数据。

### 8. 使用目标 StorageClass 重新创建 StatefulSet

将迁移单独应用于每个 StatefulSet 序号，例如 `data-web-0` 和 `data-web-1`。每个序号都有自己的源和目标卷。

重新绑定 PVC 不会更新 StatefulSet 的 `volumeClaimTemplates`。如果模板仍包含旧的 StorageClass，则后续扩展会在旧存储上创建新的 PVC，并将 StatefulSet 分割到不同的存储系统：

```text
data-web-0   Bound   <dorado-storage-class>   <- 迁移
data-web-1   Bound   <dorado-storage-class>   <- 迁移
data-web-2   Bound   <old-storage-class>      <- 从模板新创建
```

`volumeClaimTemplates` 不能就地更改：

```text
The StatefulSet "web" is invalid: spec: Forbidden: updates to statefulset spec for
fields other than 'replicas', 'ordinals', 'template', 'updateStrategy',
'revisionHistoryLimit', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds'
are forbidden
```

使用 `--cascade=orphan` 删除 StatefulSet，更新 `volumeClaimTemplates` 中的 `storageClassName`，然后重新创建它：

```bash
kubectl -n <namespace> delete sts <name> --cascade=orphan
# 编辑 volumeClaimTemplates 中的 storageClassName，然后：
kubectl apply -f <statefulset>.yaml
```

孤立删除将 Pods 和 PVC 保留在原地。重新创建的 StatefulSet 通过其标签选择器采用现有 Pods。在验证中，Pod 年龄保持连续，重启计数保持为零，确认 Pods 没有重启。请在迁移后立即执行此步骤，以便未来的扩展使用目标 StorageClass。

### 9. 审查风险和回滚操作

| 步骤                        | 失败的后果                                                    | 回滚                                                                         |
| --------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 初始数据复制               | 没有应用程序中断；源仍然可用                                 | 删除临时 PVC 并重试                                                        |
| 将两个 PV 设置为 `Retain`   | 遗漏此保护可能会在删除 PVC 时销毁卷                         | 删除后无法恢复；这是唯一不可逆的检查点                                     |
| 停止工作负载               | 停机时间开始                                                | 恢复记录的副本计数                                                        |
| 最终同步和验证             | 校验和不匹配表示复制不完整                                   | 恢复工作负载；源保持不变                                                  |
| 删除 PVC                   | PV 变为 `Released`；数据保持完整，因为两个都使用 `Retain`  | 重新创建原始 PVC 并将其绑定到旧 PV                                        |
| 保留新 PV                  | 绑定未完成；没有数据被删除                                   | 重新应用两个合并补丁                                                      |
| 重新创建 PVC               | 如果其字段不匹配，PVC 保持 `Pending`                        | 删除 PVC，纠正它并重新创建                                                |
| 重启工作负载               | 卷未正确挂载                                                | 扩展到零并重新绑定原始 PVC 名称到旧 PV                                     |
| 重新创建 StatefulSet       | 如果选择器不匹配，控制器不会采用现有 Pods                  | 修正清单并重新创建 StatefulSet；孤立 Pods 保持运行                         |

在确认两个 PV 都为 `Retain` 后，后续的每个迁移步骤都是可逆的。旧 PV 提供了回滚路径。要恢复它，请使用相同的两个补丁程序将旧 PV 保留为原始 PVC 名称，并重新创建 PVC，`volumeName` 设置为旧 PV。

在删除任何 PVC 之前，运行此检查并确认两行都显示 `Retain`：

```bash
kubectl get pv $NEWPV $OLDPV \
  -o custom-columns=NAME:.metadata.name,POLICY:.spec.persistentVolumeReclaimPolicy
```

### 10. 在成功迁移后完成

两个 PV 保持为 `Retain`，这将清理决策留给管理员。在工作负载在目标卷上运行足够长的时间以关闭回滚窗口后：

- 旧 PV 保持为 `Released`。一旦确认备份并且不再需要回滚路径，删除旧 PV 并回收源系统上的底层卷。删除 PV 对象不会释放源侧存储。
- 决定目标 PV 的最终回收策略。它保持为 `Retain`，因此后续 PVC 删除不会删除阵列侧卷。仅在卷的生命周期应遵循其 PVC 时恢复为 `Delete`。

## 常见问题解答

### 重新创建 PVC 时必须匹配什么？

PVC 请求不得超过 PV 容量。其访问模式必须是 PV 支持的模式的子集。其 `storageClassName` 必须与 PV 完全匹配。对于静态 PV，在 PV 和 PVC 上设置 `storageClassName: ""`；省略 PVC 字段可能导致 Kubernetes 替换为默认 StorageClass。

### 为什么 PV 在第一次补丁后仍保持 Released？

第一个合并补丁更改 `claimRef.namespace` 和 `claimRef.name`，但保留过时的 `uid`，因为未指定的字段不会被删除。第二个合并补丁必须将 `uid` 和 `resourceVersion` 设置为 `null`。然后，PV 可以在保持为命名 PVC 保留的同时变为 `Available`。

### 迁移后如何检查文件所有权？

源和目标 NFS 服务器可以应用不同的压缩策略，该映射发生在服务器上，而不是在 `rsync` 中。以 UID 0 运行复制，针对不压缩根的源导出和允许 `chown` 的目标导出。使用 `--numeric-ids` 使 ID 按值匹配而不是按名称，并在复制后验证代表性文件。根据应用程序的要求确认 UID/GID 值、权限、ACL、扩展属性、硬链接、符号链接和稀疏文件处理。
