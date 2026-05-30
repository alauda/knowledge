---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500790
sourceSHA: 7969d1e21976b766df0c2f3a8bbf24baaef661d9370415fe55f3c7cd936b6793
---

# ACP 中因过时的 VolumeSnapshotContent 对象导致的 VolumeSnapshot 创建延迟

## 问题

在安装了 `snapshot` ModulePlugin 的 Alauda 容器平台上（`ClusterPluginInstance/snapshot`，chart `chart-volume-snapshot` v4.4.0-beta.4），上游 Kubernetes CSI 快照 API 组 `snapshot.storage.k8s.io` 已在集群中注册：`VolumeSnapshot`（命名空间），`VolumeSnapshotContent`（集群范围）和 `VolumeSnapshotClass`（集群范围）均服务于 `v1`。`snapshot-controller` 部署在 `cpaas-system` 命名空间中（镜像 `registry.alauda.cn:60080/3rdparty/k8scsi/snapshot-controller:v8.5.0-bea122af`，上游 `kubernetes-csi/external-snapshotter` v8.5.0），监视 `VolumeSnapshot` 和 `VolumeSnapshotContent` 对象，并通过驱动 CSI 驱动程序来提供后备快照，从而协调绑定。

症状：创建 `VolumeSnapshot` 资源所需时间出乎意料地长——通常需要几分钟——并且偶尔在快照变为 `READYTOUSE=true` 之前超时。在该集群的健康状态下，相同的工作流程在几秒钟内完成（针对 `topolvm-snapshot` 的新创建的 `VolumeSnapshot` 在大约四秒内报告 `READYTOUSE=true` 和 `RESTORESIZE=1Gi`），因此多分钟的延迟表明 snapshot-controller 不再通过其监视循环处理新请求，而只是通过其定期的 informer 重新同步进行进展。

## 根本原因

snapshot-controller 是一个单一的上游 `external-snapshotter` 二进制文件（在 ACP 上为 v8.5.0），运行在 `cpaas-system` 命名空间中，容器参数为 `--v=5 --leader-election=true --http-endpoint=:8080`——未设置 `--resync-period` 覆盖，因此适用二进制中的 `SharedInformerFactory` 默认值。当控制器的反射器在 `VolumeSnapshotContent` 上无法保持与 apiserver 监视的连接时——例如，因为请求的 `resourceVersion` 已过期于 apiserver 监视缓存，apiserver 返回 `Expired: too old resource version`——client-go 的反射器停止监视并回退到定期的完整 LIST 重新列出。在监视关闭期间，实时更新不会传递给控制器；新的 `VolumeSnapshot` 对象仅在下一个强制重新同步时被拾取。在该集群上观察到，snapshot-controller 的 `Forcing resync` 事件在 `external-snapshotter` informer factory 上以固定的 900 秒（15 分钟）频率发生，因此新创建的 `VolumeSnapshot` 可能会在下一个重新同步之前保持未处理状态，而不是立即处理。

过多的过时、未绑定或无效的 `VolumeSnapshotContent` 对象加剧了这种模式：工作集越大，监视重放的压力越大，监视缓存的存活性越大，重新列出的路径越可能实际驱动快照创建。通过检查列表可以轻松识别过时的 `VolumeSnapshotContent` 对象——`RESTORESIZE` 为 `0`（结合旧的 `AGE` 和缺失或悬挂的 `VolumeSnapshot` 引用）标记一个不再对应于真实后备快照的条目。

## 解决方案

识别过时的 `VolumeSnapshotContent` 对象，确认它们确实是孤立的，并将其删除。在 ACP 上，`VolumeSnapshotContent` 是一个标准的上游 CRD，通过 `kubectl` 操作；声明的打印列为（按顺序）`ReadyToUse`、`RestoreSize`、`DeletionPolicy`、`Driver`、`VolumeSnapshotClass`、`VolumeSnapshot`、`VolumeSnapshotNamespace`、`Age`，而 `kubectl get` 前缀为 `.metadata.name` 的 `NAME` 并将其余部分大写，因此实时表头为 `NAME READYTOUSE RESTORESIZE DELETIONPOLICY DRIVER VOLUMESNAPSHOTCLASS VOLUMESNAPSHOT VOLUMESNAPSHOTNAMESPACE AGE`。

列出对象并挑选出 `RESTORESIZE=0` 的对象。默认表中的第三个以空格分隔的列为 `RESTORESIZE`，因此对 `$3=="0"` 的 `awk` 过滤器保留标题行和仅候选行：

```bash
kubectl get volumesnapshotcontent | awk 'NR==1 || $3=="0"'
```

在删除之前，确认每个候选对象确实是过时的：检查其年龄、`RESTORESIZE` 以及其 `.spec.volumeSnapshotRef` 是否仍指向一个活动的 `VolumeSnapshot` 对象。`kubectl get` 表已经显示了绑定的 `VolumeSnapshot` 名称和命名空间列；通过检索它引用的 `VolumeSnapshot` 进行交叉检查：

```bash
kubectl get volumesnapshotcontent <name> -o yaml | grep -A4 volumeSnapshotRef
kubectl -n <vs-namespace> get volumesnapshot <vs-name>
```

**破坏性操作——在运行之前请阅读。** `spec.deletionPolicy` 为 `Delete` 的 `VolumeSnapshotContent`（集群默认的 `topolvm-snapshot` 类配置为此）会导致 snapshot-controller 在移除 `VolumeSnapshotContent` 时向存储后端发出 CSI `DeleteSnapshot`。这会删除底层后端快照数据，并且无法从集群侧恢复。在发出删除之前，对每个候选对象：

- 确认对象本身的 `spec.deletionPolicy`（`kubectl get volumesnapshotcontent <name> -o jsonpath='{.spec.deletionPolicy}'`）。如果您的保留合同要求后端快照存活，请先将策略切换为 `Retain`（`kubectl patch volumesnapshotcontent <name> --type=merge -p '{"spec":{"deletionPolicy":"Retain"}}'`），然后再删除对象。
- 确认后备快照身份（`spec.source.snapshotHandle`）未被任何外部备份或保留管道引用（Velero `Backup` `volumeSnapshotLocations`，客户侧计划的快照保留）。
- 在运行命令之前，获得客户明确的确认，表明可以销毁后端快照。

然后删除确认过时的 `VolumeSnapshotContent` 对象。使用集群默认的 `topolvm-snapshot` `VolumeSnapshotClass`（驱动程序 `topolvm.cybozu.com`，删除策略 `Delete`），当其监视正常时，snapshot-controller 会实时响应删除事件——在该集群上经过端到端验证，绑定的 `VolumeSnapshotContent` 在删除其父 `VolumeSnapshot` 后几秒内被移除：

```bash
kubectl delete volumesnapshotcontent <name>
```

一旦清除了过时条目，并且监视能够保持附加到较小、更健康的集合，新创建的 `VolumeSnapshot` 将通过实时监视路径再次处理，而不是等待定期重新同步，创建延迟将恢复到秒级基线。

## 诊断步骤

确认集群中确实安装了 `snapshot` 功能——CSI 快照 CRD 和 `snapshot-controller` 部署仅在 ACP `snapshot` ModulePlugin / `ClusterPluginInstance/snapshot` 活动时存在。CRD 服务于 `snapshot.storage.k8s.io/v1`，控制器部署位于 `cpaas-system`，镜像为 `snapshot-controller:v8.5.0-bea122af`：

```bash
kubectl api-resources --api-group=snapshot.storage.k8s.io
kubectl -n cpaas-system get deploy snapshot-controller
kubectl -n cpaas-system get deploy snapshot-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

检查 `snapshot-controller` 部署的容器参数，以确认哪些标志控制其反射器行为。在 ACP 上，chart 仅提供 `--v=5 --leader-election=true --http-endpoint=:8080`，没有 `--resync-period` 覆盖，因此上游的 `SharedInformerFactory` 默认生效：

```bash
kubectl -n cpaas-system get deploy snapshot-controller \
  -o jsonpath='{.spec.template.spec.containers[0].args}{"\n"}'
```

检查 `snapshot-controller` 日志，以查找控制器通过定期重新同步而非通过实时监视事件进展的证据。来自 `external-snapshotter` informer factory 的重复 `Forcing resync` 日志行以固定频率指示控制器是由反射器重新同步驱动的——而不是由新创建的 `VolumeSnapshot` 资源的单个监视事件驱动：

```bash
kubectl -n cpaas-system logs deploy/snapshot-controller --tail=2000 \
  | grep -E 'Forcing resync|Watch close|too old resource version'
```

列出 `VolumeSnapshotContent` 并通过 `RESTORESIZE`、`AGE` 和 `VOLUMESNAPSHOT` / `VOLUMESNAPSHOTNAMESPACE` 列识别过时的候选对象。`RESTORESIZE` 为 `0`（默认表中的列 `$3`）且年龄较大且没有活动的 `VolumeSnapshot` 伙伴的行是清理目标的工作集：

```bash
kubectl get volumesnapshotcontent
kubectl get volumesnapshotcontent | awk 'NR==1 || $3=="0"'
```
