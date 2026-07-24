---
products:
   - Alauda Container Platform
kind:
   - Solution
ProductsVersion:
   - 4.x
---

# 如何将 NFS PersistentVolume 迁移到 OceanStor Dorado 并原地换绑 PVC

## 概述

`PersistentVolumeClaim.spec.volumeName` 是不可变字段，不能通过更新现有 PVC 使其引用另一个 PersistentVolume。如果要在不改变 PVC 名称的情况下将工作负载迁移到新的 NFS 卷，必须删除并同名重建 PVC，同时将新 PV 预绑定到该 PVC。

本文介绍如何复制数据、将新 PV 预留给原 PVC 名称，以及恢复工作负载。整个过程需要一个停机窗口，已完成 Deployment 和 StatefulSet 工作负载验证。

对于 StatefulSet，由 `volumeClaimTemplates` 生成的 PVC 名称保持不变。迁移后还必须使用更新后的模板重建 StatefulSet，确保以后扩容时使用新的 StorageClass。

## 环境

| 组件 | 版本 |
|------|------|
| 容器平台 | ACP 4.x（在 4.3.1 上验证） |
| 节点操作系统 | Micro OS 5.5 |
| 存储设备 | OceanStor Dorado 6.1.9 |
| OceanStor CSI driver For Dorado | v4.12.0 |
| 源存储 | NFS，由 `nfs.csi.k8s.io` 制备 |
| 目标存储 | Dorado NFS（`volumeType: fs`） |
| 验证的工作负载 | Deployment（RWX）、StatefulSet（RWO，2 个 ordinal） |

> **注意**：本文的数据复制操作适用于 `Filesystem` 模式的卷。`Block` 模式的卷需要使用块级复制方式。PVC 换绑操作只涉及 Kubernetes 对象，也可用于其他存储类型。

## 先决条件

- 一个 ACP 4.x 集群，已安装 OceanStor CSI driver For Dorado，并具备可用的目标 NFS StorageClass。
- 具备 `kubectl` 访问权限，并有权 patch 属于集群级资源的 PersistentVolume。
- 可以停止工作负载的维护窗口。
- 目标阵列具有足够容量创建新卷。
- 一个包含 `rsync` 的镜像，或其他能够保留所需文件元数据的复制工具。
- 当前有效的备份，以及经过确认的工作负载回滚方案。

本文使用以下占位符。请替换为实际环境中的值：

| 占位符 | 说明 |
|--------|------|
| `<namespace>` | 工作负载所在命名空间 |
| `<pvc>` | 迁移后保持不变的现有 PVC 名称 |
| `<tmp-pvc>` | 用于制备目标卷的临时 PVC |
| `<storage-class>` | 由新阵列提供的目标 StorageClass |
| `<workload>` | 工作负载资源，例如 `deploy/app` 或 `sts/web` |
| `<selector>` | 工作负载 Pod 的标签选择器 |
| `<new-pv>` | 为临时目标 PVC 制备的 PV |

## 解决方案

### 1. 确认 PVC 换绑要求

迁移包含两项操作：

- 将数据从源卷复制到目标卷。
- 将原 PVC 名称换绑到目标 PV。

由于 `PersistentVolumeClaim.spec.volumeName` 不能修改，必须删除并重建 PVC。工作负载清单仍可引用原 PVC 名称。

PV 通过 `PersistentVolume.spec.claimRef` 记录 PVC 绑定关系：

| 字段 | 含义 |
|------|------|
| `namespace`、`name` | 卷所属 PVC 的命名空间和名称 |
| `uid` | 具体 PVC 对象的 UID；重建后的 PVC 使用新的 UID |
| `resourceVersion` | 被引用对象的乐观并发控制标识 |

这些字段决定 PV 状态：

| `claimRef` 条件 | PV 状态和行为 |
|------------------|---------------|
| 没有 `claimRef` | `Available`；任何匹配的 PVC 都可以绑定 |
| 存在 `namespace` 和 `name`，但没有 `uid` | `Available`；仅预留给指定名称的 PVC |
| `claimRef` 完整，并且引用的 PVC 存在 | `Bound` |
| `claimRef` 完整，但对应 `uid` 的 PVC 已不存在 | `Released` |

`Released` 状态的 PV 不会自动恢复为 `Available`。因此，将新 PV 预留给原 PVC 时必须执行两次 merge patch。第一次设置目标 `namespace` 和 `name`。merge patch 会保留未指定的字段，因此旧 `uid` 仍然存在，PV 会停留在 `Released`。第二次必须将 `uid` 和 `resourceVersion` 显式设置为 `null`。

开始迁移前，请确认最终 PVC 与目标 PV 满足以下要求：

- 请求容量不超过 PV 容量。
- PV 支持 PVC 的访问模式。
- `storageClassName` 与 PV 完全一致。

### 2. 制备目标卷

先读取源 PVC，确保临时 PVC 使用兼容的访问模式和容量：

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
  # 设置为源 PVC 的访问模式（用上一条命令读取）。
  # ReadWriteMany 对应已验证的 Deployment；已验证的 StatefulSet 使用
  # ReadWriteOnce。不要无意中放宽访问模式。
  accessModes: ["ReadWriteMany"]
  storageClassName: <storage-class>
  resources:
    requests:
      # 必须大于等于源卷。后续换绑步骤会针对同一个卷创建最终 PVC，
      # 因此容量在这里就固定下来了。
      storage: 2Gi
```

等待 PVC 完成绑定：

```bash
kubectl -n <namespace> wait --for=jsonpath='{.status.phase}'=Bound \
  pvc/<tmp-pvc> --timeout=180s
```

对于 StatefulSet，需要为每个 ordinal 创建一个目标 PVC。

### 3. 执行首次数据复制

创建一个同时挂载源 PVC 和目标 PVC 的临时 Pod：

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

在应用仍运行时执行首次复制，将大部分数据复制工作放在停机窗口之前完成：

```bash
kubectl -n <namespace> exec migrator -- \
  rsync -aHAX --numeric-ids --delete --exclude='/.snapshot' /src/ /dst/
```

建议使用 `rsync`，这样最终同步只需传输发生变化的数据。注意以下参数及其适用边界：

- `-H` 保留硬链接，`-A` 保留 POSIX ACL，`-X` 保留扩展属性。
- `--numeric-ids` 按数字值而非用户名/组名同步 UID/GID，从而在源端和目标端主机的名称到 ID 映射不同时仍保持属主正确。它**不能**绕过 NFS squash：`root_squash` 和 `all_squash` 是 NFS 服务端对客户端凭据的映射，与任何 `rsync` 参数无关。
- `-aHAX` 不包含 `--sparse`。如果数据中包含稀疏文件（例如虚拟机镜像、预分配的数据库文件），请加上 `-S`，避免把空洞按实际数据写入，并据此规划目标卷容量。
- `--exclude='/.snapshot'` 防止 `--delete` 尝试删除目标卷中只读的 `.snapshot` 目录。前导斜杠表示只匹配卷根目录。

如果不排除该目录，`rsync` 可能报告以下错误并以非零状态码退出：

```text
rmdir: '/data/.snapshot': Permission denied
rm:    can't remove '/data/.snapshot': Permission denied
```

由于复制通过 NFS 进行，复制进程必须能读取每个源文件，并能在目标端设置属主。请以 UID 0 运行 migrator，确认源端导出不对 root 做 squash，且目标端导出允许 `chown`；否则 `0600` 文件可能读不到，或属主无法恢复。全量复制前先用一个代表性文件测试。

如果没有包含 `rsync` 的镜像，可以使用以下命令在 Pod 内复制，它会保留权限、属主和符号链接，但每次都会复制全部数据：

```bash
kubectl -n <namespace> exec migrator -- sh -c 'tar -C /src -cf - . | tar -C /dst -xpf -'
```

普通 `tar` 如果不使用 `--xattrs --acls`，不会保留 POSIX ACL 和扩展属性，还会将稀疏文件展开为完整大小。请根据工作负载的文件元数据要求选择复制方式。

源 PVC 由 `nfs.csi.k8s.io` 制备，其 `CSIDriver.spec.attachRequired` 为 `false`。NFS 卷不通过 `VolumeAttachment` 挂接，因此 migrator Pod 与应用同时挂载源 PVC 不会触发 `Multi-Attach error`，跨节点也不会。migrator 可以运行在任意节点。对于 iSCSI、RBD 这类 `attachRequired` 为 `true` 的挂接型驱动，`ReadWriteOnce` 源卷才要求 migrator 与应用位于同一节点。无论哪种驱动，复制一个仍在写入的卷之前都要评估应用一致性。

由于源卷和目标卷都是 NFS，也可以在一台能够同时访问两个 NFS 服务器的主机上执行复制。此方式完全不经过集群内的 Pod，但要求集群外具备相应的网络访问能力。

### 4. 将两个 PV 的回收策略设置为 Retain

设置后续操作使用的变量，并记录目标 PV 和源 PV 名称：

```bash
NS=<namespace>; PVC=<pvc>; TMP=<tmp-pvc>; WORKLOAD=<workload>
NEWPV=$(kubectl -n $NS get pvc $TMP -o jsonpath='{.spec.volumeName}')
OLDPV=$(kubectl -n $NS get pvc $PVC -o jsonpath='{.spec.volumeName}')
```

删除任一 PVC 前，必须将两个 PV 都改为 `Retain`：

```bash
kubectl patch pv $NEWPV -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl patch pv $OLDPV -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

> **警告**：确认两个 PV 都使用 `Retain` 后才能继续。PV 仍使用 `reclaimPolicy: Delete` 时删除 PVC，可能会删除底层卷。新 PV 使用 `Retain` 是为了保护已迁移的数据，旧 PV 使用 `Retain` 是为了保留回滚路径。遗漏此检查点是整个流程中唯一可能造成不可逆数据丢失的情况。

检查两个 PV 的回收策略：

```bash
kubectl get pv $NEWPV $OLDPV \
  -o custom-columns=NAME:.metadata.name,POLICY:.spec.persistentVolumeReclaimPolicy
```

### 5. 停止工作负载并完成最终同步

记录副本数，停止工作负载，并等待其 Pod 删除：

```bash
REPLICAS=$(kubectl -n $NS get $WORKLOAD -o jsonpath='{.spec.replicas}')
kubectl -n $NS scale $WORKLOAD --replicas=0
kubectl -n $NS wait --for=delete pod -l <selector> --timeout=300s
```

执行最终同步并比较文件校验和：

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

`set -eu` 与 NUL 分隔（`-print0` / `sort -z` / `xargs -0`）是必需的：否则含空格的文件名会被拆成多个参数，而 `md5sum` 失败只写到 stderr，于是两个空的 `.sum` 文件可能比较相等并输出 `CONTENT_OK`，即使数据不同。该检查之后紧接着就是删除 PVC，因此绝不能容许假阳性。

该检查只比对普通文件的内容。属主、权限、ACL、扩展属性、符号链接目标和硬链接关系不在此校验范围内，需按工作负载要求单独核对（见常见问题）。只有校验和一致时才能继续。

### 6. 删除 PVC 并使用原名称重建

删除 migrator Pod 和两个 PVC：

```bash
kubectl -n $NS delete pod migrator
kubectl -n $NS delete pvc $TMP $PVC
```

两个 PV 都会进入 `Released` 状态，并保留数据。

将新 PV 预留给原 PVC 名称。必须按以下顺序执行两次 merge patch：

```bash
kubectl patch pv $NEWPV --type merge -p \
  "{\"spec\":{\"claimRef\":{\"apiVersion\":\"v1\",\"kind\":\"PersistentVolumeClaim\",\"namespace\":\"$NS\",\"name\":\"$PVC\"}}}"

kubectl patch pv $NEWPV --type merge -p \
  '{"spec":{"claimRef":{"uid":null,"resourceVersion":null}}}'
```

第二次 merge patch 不能省略。否则 `claimRef` 中仍保留旧 `uid`，PV 会一直停留在 `Released`。

确认新 PV 已变为 `Available`，并预留给原 PVC 名称：

```bash
kubectl get pv $NEWPV -o custom-columns=\
NAME:.metadata.name,STATUS:.status.phase,CLAIM:.spec.claimRef.name,UID:.spec.claimRef.uid
```

```text
NAME             STATUS      CLAIM      UID
pvc-0464141b-…   Available   app-data   <none>
```

使用原名称重建 PVC，并将其预绑定到新 PV：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <pvc>            # 保持不变
  namespace: <namespace>
spec:
  accessModes: ["ReadWriteMany"]      # 与源 PVC 一致（StatefulSet 为 ReadWriteOnce）
  storageClassName: <storage-class>   # 必须与新 PV 完全一致
  resources:
    requests:
      storage: 2Gi                    # 必须小于等于 PV 容量
  volumeName: <new-pv>
```

PVC 变为 `Bound` 后才能恢复工作负载。

### 7. 恢复并验证工作负载

恢复之前记录的副本数：

```bash
kubectl -n $NS scale $WORKLOAD --replicas=$REPLICAS
```

确认工作负载使用目标 NFS 挂载点，并检查应用数据：

```bash
kubectl -n $NS exec <pod> -- sh -c 'mount | grep " /data "'
```

在经过验证的 `ReadWriteMany` Deployment 场景中，以下检查均通过：

| 检查项 | 结果 |
|--------|------|
| 文件校验和 | 与迁移前基线一致 |
| 权限和属主 | 保持不变，包括权限为 `600`、属主为 `1000:1000` 的文件 |
| 符号链接 | 保持不变，包括相对路径目标 |
| Deployment 清单 | 未修改，仍引用原 PVC 名称 |
| 挂载点 | 已切换到目标 NFS 导出 |
| 并发写入 | 两个副本和一台集群外主机可以互相看到写入内容 |

在经过验证的 `ReadWriteOnce`、两个 ordinal 的 StatefulSet 场景中，每个 ordinal 都保留了各自的数据和 PVC 名称，两个挂载点均切换到目标阵列，并且没有发生串卷。

### 8. 使用目标 StorageClass 重建 StatefulSet

需要为每个 StatefulSet ordinal 分别执行迁移，例如 `data-web-0` 和 `data-web-1`。每个 ordinal 都有独立的源卷和目标卷。

换绑 PVC 不会更新 StatefulSet 的 `volumeClaimTemplates`。如果模板仍使用旧 StorageClass，以后扩容时会在旧存储上创建新 PVC，导致同一个 StatefulSet 使用不同的存储系统：

```text
data-web-0   Bound   <dorado-storage-class>   <- 已迁移
data-web-1   Bound   <dorado-storage-class>   <- 已迁移
data-web-2   Bound   <old-storage-class>      <- 新建，来自模板
```

`volumeClaimTemplates` 不能原地修改：

```text
The StatefulSet "web" is invalid: spec: Forbidden: updates to statefulset spec for
fields other than 'replicas', 'ordinals', 'template', 'updateStrategy',
'revisionHistoryLimit', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds'
are forbidden
```

使用 `--cascade=orphan` 删除 StatefulSet，修改 `volumeClaimTemplates` 中的 `storageClassName`，然后重建：

```bash
kubectl -n <namespace> delete sts <name> --cascade=orphan
# 修改 volumeClaimTemplates 中的 storageClassName，然后：
kubectl apply -f <statefulset>.yaml
```

使用 `--cascade=orphan` 删除 StatefulSet 时，原有 Pod 和 PVC 会保留。重建后的 StatefulSet 通过标签选择器收养现有 Pod。验证过程中，Pod 存活时长保持连续，重启次数始终为 0，说明 Pod 没有重启。请在迁移完成后立即执行此步骤，确保以后扩容时使用目标 StorageClass。

### 9. 检查风险和回滚操作

| 步骤 | 出错后果 | 回滚方式 |
|------|----------|----------|
| 首次数据复制 | 应用不受影响，源卷仍可用 | 删除临时 PVC 后重试 |
| 将两个 PV 设置为 `Retain` | 遗漏此保护会在删除 PVC 时销毁卷 | 删除后无法恢复；这是唯一不可逆的检查点 |
| 停止工作负载 | 开始停机 | 恢复之前记录的副本数 |
| 最终同步和校验 | 校验和不一致表示复制不完整 | 恢复工作负载；源卷未发生变化 |
| 删除 PVC | 两个 PV 变为 `Released`；由于使用 `Retain`，数据仍然保留 | 重建原 PVC，并绑定到旧 PV |
| 预留新 PV | 无法完成绑定，但不会删除数据 | 重新执行两次 merge patch |
| 重建 PVC | 字段不匹配时 PVC 停留在 `Pending` | 删除 PVC，修正后重建 |
| 恢复工作负载 | 卷无法正确挂载 | 缩容到零，将原 PVC 名称换绑回旧 PV |
| 重建 StatefulSet | 标签选择器不匹配时，控制器无法收养现有 Pod | 修正清单并重建 StatefulSet；孤儿 Pod 会继续运行 |

确认两个 PV 都使用 `Retain` 后，后续迁移步骤均可回退。旧 PV 是回滚路径。需要恢复时，使用相同的两次 patch 操作将旧 PV 预留给原 PVC 名称，再将 PVC 的 `volumeName` 设置为旧 PV 并重建。

删除任一 PVC 前，请执行以下检查，并确认两行都显示 `Retain`：

```bash
kubectl get pv $NEWPV $OLDPV \
  -o custom-columns=NAME:.metadata.name,POLICY:.spec.persistentVolumeReclaimPolicy
```

### 10. 迁移成功后的收尾

两个 PV 都保留为 `Retain`，清理决策交由管理员完成。当工作负载在目标卷上运行足够长、回滚窗口关闭之后：

- 旧 PV 仍处于 `Released`。在确认已有备份、不再需要回滚路径后，删除旧 PV 并在源系统上回收其底层卷。删除 PV 对象并不会释放源端存储。
- 决定目标 PV 的最终回收策略。它保持 `Retain`，因此后续删除 PVC 不会删除阵列上的卷。对于共享或对外提供的卷,保留 `Retain`，此时卷需要手工清理。只有当卷的生命周期应跟随 PVC 时，才恢复为 `Delete`。

## 常见问题

### 重建 PVC 时必须匹配哪些字段？

PVC 请求容量不得超过 PV 容量。PVC 的访问模式必须是 PV 所支持模式的子集。`storageClassName` 必须与 PV 完全一致。对于静态 PV，PV 和 PVC 都应设置 `storageClassName: ""`；如果省略 PVC 中的该字段，Kubernetes 可能会填入默认 StorageClass。

### 为什么第一次 patch 后 PV 仍处于 Released？

第一次 merge patch 修改了 `claimRef.namespace` 和 `claimRef.name`，但未指定的旧 `uid` 会被保留。第二次 merge patch 必须将 `uid` 和 `resourceVersion` 都设置为 `null`。完成后，PV 可以恢复为 `Available`，同时仍预留给指定名称的 PVC。

### 迁移后应如何检查文件属主？

源端和目标端 NFS 服务器可能使用不同的 squash 策略，而该映射发生在服务端,不在 `rsync` 中。请以 UID 0 运行复制,针对不对 root 做 squash 的源端导出和允许 `chown` 的目标端导出;使用 `--numeric-ids` 让 ID 按数值而非名称匹配,并在复制后检查代表性文件。根据应用要求确认 UID/GID、权限、ACL、扩展属性、硬链接、符号链接以及稀疏文件处理结果。
