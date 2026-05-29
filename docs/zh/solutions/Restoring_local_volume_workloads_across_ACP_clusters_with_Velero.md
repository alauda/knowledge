---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500564
sourceSHA: 9788eefe2c838f24da51acdc7176c4b2ab096352f1befff0ed7460d0298c3f4f
---

# 使用 Velero 在 ACP 集群之间恢复本地卷工作负载

## 问题

在 Alauda 容器平台（安装包 `installer-v4.3.0-online`，kubernetes v1.34.5）上，Velero 通过 `chart-velero` ModulePlugin（chart v4.1.0，镜像 `registry.alauda.cn:60080/3rdparty/velero/velero:v1.15.2-v4.1.0`，初始化插件 `velero-plugin-for-aws:v1.11.1-v4.1.0` 和 `velero-plugin-for-change-registry:v4.1.0`）进行分发，并在 `cpaas-system` 命名空间中运行；该控制器仅监视其自身命名空间内的 `Backup` 和 `Restore` 资源，并在备份时按原样封装 Kubernetes API 对象，保留字段，例如 `PersistentVolume` 的 `spec.nodeAffinity` 及其注释，而不对其进行重写。当这样的备份恢复到 *不同* 的 ACP 集群时，这种原样行为与本地类型 `PersistentVolume` 的两个事实发生冲突：本地 PV 通过其 `spec.nodeAffinity` 块绑定到单个节点（一个形状为 `required.nodeSelectorTerms[].matchExpressions[{key,operator,values}]` 的 `VolumeNodeAffinity`，通常以 `kubernetes.io/hostname` 为键），而上游 kube-scheduler 拒绝将引用该 PV 的 Pod 放置到任何不满足该亲和性的节点上，导致 Pod 的事件中出现谓词失败，显示为 `node(s) had volume node affinity conflict`。因此，恢复的 Pods 由于 PV 的 `nodeAffinity` 中编码的源集群主机名在目标集群中不存在而处于 `Pending` 状态。

同样的恢复可能因第二个独立原因而失败：`StorageClass` 是一个集群范围的资源（`storageclasses.storage.k8s.io`，`NAMESPACED=false`），并且不会与工作负载备份的命名空间对象一起拉取，因此恢复的 `PersistentVolumeClaim` 如果其 `spec.storageClassName` 指向一个在目标集群中不存在的 `StorageClass`，则会保持在 `Pending` 状态，并出现 `ProvisioningFailed` 事件，内容为 `storageclass.storage.k8s.io "<name>" not found`；引用该 PVC 的工作负载 Pod 反过来也会保持在 `Pending` 状态，调度条件为 `pod has unbound immediate PersistentVolumeClaims`（`FailedScheduling`）。

## 根本原因

本地类型 `PersistentVolume` 携带两个在跨集群字面复制中无法存活的源集群身份信息：嵌入在 `spec.nodeAffinity` 中的节点主机名和绑定 PVC 上的 `storageClassName` 引用。Velero 的恢复路径准确保留这两个字段，因为 velero 控制器将 API 对象视为不透明的有效负载，并且在恢复过程中不改变 `spec.nodeAffinity`、`storageClassName` 或相关引用。由于源主机名仍然固定，kube-scheduler 的 `VolumeNodeAffinity` 谓词在每个目标节点上都失败，并产生 `volume node affinity conflict` 事件；由于缺少目标 `StorageClass`，上游 PV 控制器对 PVC 发出 `ProvisioningFailed`，而 Pod 则因未绑定的 PVC 而被调度阻塞。

第三个约束决定了哪些卷可以通过 Velero 的文件系统备份（FSB，`--default-volumes-to-fs-backup` 模式）进行备份。FSB 由此平台上 Velero 二进制文件中的 restic 上传器驱动，支持备份和恢复本地卷，但不支持备份或恢复 `hostPath` 卷；包含 hostPath 支持的 Pods 的备份将产生无法在目标端重建的卷，无论上述集群身份问题如何解决。

## 解决方案

在恢复之前，使目标集群与备份达成一致，然后让 Velero 重放命名空间对象。Velero 在恢复时按原样保留 API 对象，因此源备份携带的集群范围和节点固定状态——PVC 引用的 `StorageClass` 和其 `nodeAffinity` 指向源集群主机名的本地 `PersistentVolume`——必须首先存在于目标端。

确保备份的 PVC 引用的目标 `StorageClass` 在恢复运行之前已经存在于目标集群中。`StorageClass` 是集群范围的，并不会与命名空间工作负载自动恢复；如果备份固定了目标集群没有的 `storageClassName`，恢复的 PVC 将保持在 `Pending` 状态，并出现上述 `storageclass.storage.k8s.io "<name>" not found` 事件。

对于备份中的每个本地 `PersistentVolume`，在恢复之前手动预创建一个匹配的目标 PV。预创建的 PV 必须重用与源 PV 相同的 `metadata.name`，以便恢复的 PVC 的 `spec.volumeName` 仍然解析为它，并且绑定在恢复中得以保留。其 `spec.nodeAffinity` 必须指向目标集群中实际存在的节点主机名——一个 `kubernetes.io/hostname In [<destination-node>]` 条款——以便调度器可以放置引用它的工作负载。标准的本地 PV 形状适用：`spec.local.path`（一个 `LocalVolumeSource`）命名所选节点上的磁盘路径，`spec.nodeAffinity` 携带以 `kubernetes.io/hostname` 为键的 `required.nodeSelectorTerms[].matchExpressions` 块。一个最小的清单：

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: <same-name-as-source-pv>
spec:
  capacity:
    storage: <same-as-source>
  accessModes:
    - ReadWriteOnce
  storageClassName: <destination-storageclass-name>
  local:
    path: /var/lib/<workload>/data
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - <destination-node-hostname>
```

`spec.local.path` 引用的目录必须在命名的目标节点上已经存在，才能绑定 PV；本地卷提供者不会自行创建该路径，无法在挂载时找到目录的 kubelet 将使依赖的 Pod 因挂载失败而卡住，而没有任何 Velero 侧的诊断信息。

当工作负载使用文件系统备份（FSB）时，本地卷内容通过恢复时的 restic 上传器流入目标 PV 的文件系统。卷为 `hostPath` 而非本地类型的备份无法以这种方式传输——FSB 不支持 hostPath 卷——并且在上述任何内容产生可用的目标工作负载之前需要不同的数据移动路径。

在 ACP 上，限制任何 `Backup` 或 `Restore` CR 的安装侧先决条件不是 `DataProtectionApplication` CR，而是 velero `ClusterPluginInstance` 本身：`cpins.spec.config.backupsEnabled=true` 加上填充的 `BackupStorageLocation` 三元组（bucket、s3Url、region）和匹配的 `credentials`（secretId、secretKey）必须在 `velero` cpins 上设置，控制器才会允许恢复——默认 cpins 的 `backupsEnabled:false` 和空的 BSL，针对该状态提交的恢复 CR 在任何下面的诊断触发之前都会失败验证。

在配置好 velero cpins 并在目标 `StorageClass` 和重命名的本地 PV 到位后，触发针对备份的 Velero 恢复。Velero 在 `cpaas-system` 命名空间中的控制器监视该命名空间中的 `Restore` 资源，并使用上游 velero 二进制文件处理它们。

## 诊断步骤

检查恢复的 PVC，以确认其绑定的 PV 名称和它所请求的 `storageClassName`；同一命令还会显示它期望的 `accessModes` 和 `capacity`：

```bash
kubectl describe pvc -n <ns> <pvc-name>
```

这里提到的 `ProvisioningFailed` 事件，内容为 `storageclass.storage.k8s.io "<name>" not found`，意味着目标集群缺少命名的 `StorageClass`，PVC 在供应时被阻塞；依赖的 Pod 将显示 `FailedScheduling`，并伴随 `pod has unbound immediate PersistentVolumeClaims`，直到该 PVC 绑定。

检查每个本地 `PersistentVolume` 以读取 `spec.nodeAffinity` 块——打印的 `kubernetes.io/hostname` `matchExpressions` 是调度器正在匹配的确切节点身份：

```bash
kubectl describe pv <pv-name>
```

如果由本地 PV 支持的 Pod 处于 `Pending` 状态，并显示 `node(s) had volume node affinity conflict`，则 PV 的 `nodeAffinity` 下的主机名在目标集群中不存在；在跨集群恢复场景中，这是 Velero 保留源集群主机名不变的残留，解决方法是上述解决方案中描述的预创建目标 PV。

直接针对 `cpaas-system` 中的控制器部署驱动 Velero 自身的恢复报告，以列出每个资源的恢复结果（创建/失败）以及恢复发出的警告：

```bash
kubectl exec -n cpaas-system deploy/velero -- \
  ./velero restore describe <restore-name> --details
```

针对其中一个本地 PV 的警告形式为 `PersistentVolume "<name>" already exists ... the in-cluster version is different than the backed-up version`，这是目标集群已经在同名下手动预创建 PV 的预期信号，Velero 保持了集群内对象不变，而不是覆盖它。
