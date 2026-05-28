---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500389
sourceSHA: bc497fe4971346a4a63fa50a439f4813ac3ca6cb26a63bf5193af0cb8fef2853
---

# Velero restic 备份在 S3 存储桶被清空后失败 — 删除过时的 BackupRepository

## 问题

在 Alauda 容器平台上，Velero 通过 velero ModulePlugin（chart `ait/chart-velero` v4.1.0）提供，并在 `cpaas-system` 命名空间中运行，使用镜像 `velero:v1.15.2-v4.1.0`，服务器标志 `--uploader-type=restic`，以及使用镜像 `velero-node-agent:v1.15.2-v4.1.0` 的节点智能体 DaemonSet（每个节点一个 `node-agent-<hash>` pod）。restic 上传器将其磁盘上的存储库存储为对象树（`config`、`keys/`、`data/`、`index/`、`snapshots/`），存放在由 `BackupStorageLocation` 绑定的 S3 兼容存储桶中。在特定命名空间的备份至少运行一次后，会在 `cpaas-system` 中存在一个每命名空间的 `BackupRepository`（velero.io/v1）自定义资源，记录存储桶前缀和 Velero 必须为该命名空间重用的 restic 兼容存储库标识符。

当该命名空间的 restic 前缀下的 S3 存储桶内容被非正常删除时，例如通过对象存储控制台，而 `BackupRepository` CR 保留在原地时，就会出现故障模式。由于 CR 仍然存在，Velero 将磁盘上的 restic 存储库视为已初始化，并在下次备份运行时跳过 `restic init` 步骤。随后的 PodVolumeBackup 尝试在存储桶前缀下没有 `config` 对象可供打开，因此立即中止。

## 根本原因

Velero 在 `BackupRepository` CR 中记录每个命名空间的存储库状态，而不是在存储桶中。一旦 CR 处于 `Ready` 状态，初始化新的 restic 存储库的控制器路径就会被短路，之后该命名空间的每个备份都假设存储桶侧的布局是完整的。非正常清空存储桶打破了这一假设：CR 仍然显示已初始化的存储库，而存储桶不再包含 restic 在下次写入时需要打开存储库的 `config` 对象。CR 和存储桶之间的磁盘差异导致了故障的发生。

在 ACP 的 Velero v1.15.2-v4.1.0 构建中，`backuprepositories.velero.io` CRD（在 `apiVersion: velero.io/v1`）暴露了驱动此行为的字段。`spec.volumeNamespace` 是每个命名空间的句柄，`spec.repositoryType` 是枚举 `{kopia, restic, ""}`（ACP Velero 运行 `restic` 分支），`spec.resticIdentifier` 携带完整的 restic 兼容存储库标识符（restic 在每次备份时重用的 `s3:…` 句柄），而 `spec.backupStorageLocation` 将存储库绑定到其 `BackupStorageLocation`。状态表面为 `status.phase ∈ {New, Ready, NotReady}` 和一个自由格式的 `status.message`；`Ready` 阶段是信号，表明 `restic-init` 步骤已经发生，并将在后续运行中被跳过，而 `NotReady` 阶段则携带控制器的诊断消息。

## 解决方案

删除受影响命名空间的过时 `BackupRepository` CR。在该命名空间的下一个备份尝试中，Velero 会重新创建 CR，重新对现在空的存储桶前缀运行 restic 初始化，PodVolumeBackup 将恢复成功。

列出 `cpaas-system` 中每个命名空间的存储库 CR，以识别过时条目：

```bash
kubectl get backuprepository -n cpaas-system
```

每个条目的名称编码了其目标命名空间和 `BackupStorageLocation`；交叉引用 `spec.volumeNamespace`、`spec.backupStorageLocation` 和 `status.phase` 以确认有问题的行：

```bash
kubectl get backuprepository -n cpaas-system <name> -o yaml
```

删除过时的 CR；Velero 的控制器将在该命名空间的下一个备份运行中生成一个新的 CR，restic 将重新初始化磁盘上的存储库：

```bash
kubectl delete backuprepository -n cpaas-system <name>
```

重新运行（或等待计划重新触发）受影响命名空间的备份，并确认新的 `BackupRepository` 达到 `status.phase: Ready`。

## 诊断步骤

PodVolumeBackup 失败在 `cpaas-system` 的节点智能体（restic DaemonSet）pod 日志中显现。相关的 pod 是 `node-agent-<hash>` 副本之一 — 每个节点有一个这样的 pod，均运行 `velero-node-agent:v1.15.2-v4.1.0` 镜像 — 失败的行是 `data path backup failed` 错误，其嵌入的 stderr 包含形式为 `unable to open config file: Stat: The specified key does not exist. Is there a repository at the following location?` 的 restic 致命错误（这是标准的上游 restic 消息，当磁盘上缺少 `config` 对象时，由 ACP 提供的相同 restic 二进制文件显现）。

在 `cpaas-system` 中尾随节点智能体日志以定位故障：

```bash
kubectl logs -n cpaas-system -l name=node-agent --tail=200
```

一旦确定了失败的命名空间，列出存储库 CR，并通过 `spec.volumeNamespace` 选择过时条目：

```bash
kubectl get backuprepository -n cpaas-system -o wide
```

ACP 中缺少预 v1.10 CRD 形式 — `kubectl get crd resticrepositories.velero.io` 返回 `NotFound`，因为 CRD 在上游被重命名为 `backuprepositories.velero.io`；请仅使用 `backuprepository` 形式。
