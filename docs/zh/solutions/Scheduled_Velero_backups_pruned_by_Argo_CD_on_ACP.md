---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500359
sourceSHA: e594d5776220b08ee28021e3c2e3c8d7c6f825ffe0bf4c30f5018b95e2a995c3
---

# 被 Argo CD 修剪的定期 Velero 备份在 ACP 上

## 问题

在安装了 `velero` ModulePlugin v4.1.0 的 Alauda 容器平台中，位于命名空间 `cpaas-system`（镜像 `registry.alauda.cn:60080/3rdparty/velero/velero:v1.15.2-v4.1.0`）以及安装了 `argocd` ModulePlugin（argocd-operator v4.2.0，图表 `chart-argocd-installer`）的命名空间 `argocd` 中，管理员观察到由 Velero `Schedule` 生成的 `Backup` 资源在每次计划触发后不久就从集群中消失，尽管 `Schedule` 本身报告该触发为成功。受影响的种类是 Velero 数据路径动态生成的所有资源——均在该平台的 `velero.io` API 组下。

Velero `Schedule` CR (`velero.io/v1`, 种类 `Schedule`) 带有一个 cron 表达式和一个 `Backup` 模板；每当 cron 表达式触发时，Schedule 控制器会创建一个新的 `Backup` CR。这些动态创建的 `Backup` CR 是集群状态，没有对应的清单在 Argo CD 追踪的 Git 仓库中作为真相来源。

## 根本原因

Argo CD 的 `Application` CR (`argoproj.io/v1alpha1`) 通过 `argocd` ModulePlugin 与 `applicationsets.argoproj.io`、`appprojects.argoproj.io` 和 `argocds.argoproj.io` (`v1beta1`) 一起提供——完整的上游 CRD 集。当一个 `Application` 启用 `syncPolicy.automated.prune`（该字段为布尔值，默认为 `false`）时，Argo CD 将任何在 Application 追踪范围内但在配置的 Git 源中没有对应清单的实时集群资源视为漂移，并在下次协调时将其删除。

Velero `Schedule` 生成的 `Backup` CR 完全符合该模式：它们是 Schedule 控制器在每次 cron 触发时注入的集群状态，并且从未存在于 Git 中。只要 Argo CD 的自动同步下次协调了追踪的 Application，任何在范围内的 `Backup` CR 就会被修剪。

## 解决方案

配置 Argo CD 以排除 `velero.io` 资源的协调，以便修剪不会删除动态生成的 CR。需要排除的 CRD 是 Schedule 控制器和 Velero 数据路径创建的：`Backup`、`Restore`、`Schedule`、`PodVolumeBackup`、`PodVolumeRestore`、`BackupStorageLocation`、`DataUpload` 和 `DataDownload`——这些都在 ACP 的 `velero.io` 组下。

集群范围的排除配置在由 `argocd` ModulePlugin 安装的单例 `ArgoCD` CR (`argoproj.io/v1beta1`) 上。在新的 ACP 安装中，命名空间 `argocd` 中的实时 `ArgoCD/argocd-gitops` CR 具有 `spec.resourceExclusions` 字段，但为空；该字段携带一个 YAML 编码的字符串列出排除条目，将其设置为一个命名 `velero.io` API 组的块将这些种类从 Argo CD 的协调器范围中移除：

```bash
kubectl patch argocd -n argocd argocd-gitops --type merge -p '{
  "spec": {
    "resourceExclusions": "- apiGroups:\n  - velero.io\n  kinds:\n  - Backup\n  - Restore\n  - Schedule\n  - PodVolumeBackup\n  - PodVolumeRestore\n  - BackupStorageLocation\n  - DataUpload\n  - DataDownload\n  clusters:\n  - \"*\"\n"
  }
}'
```

在 `ArgoCD` CR 上的等效声明形式——请注意 `resourceExclusions` 是一个 YAML 编码的字符串字段，而不是一个类型列表——是：

```yaml
apiVersion: argoproj.io/v1beta1
kind: ArgoCD
metadata:
  name: argocd-gitops
  namespace: argocd
spec:
  resourceExclusions: |
    - apiGroups:
      - velero.io
      kinds:
      - Backup
      - Restore
      - Schedule
      - PodVolumeBackup
      - PodVolumeRestore
      - BackupStorageLocation
      - DataUpload
      - DataDownload
      clusters:
      - "*"
```

对于当集群范围的排除过于宽泛时的更窄范围，可以在追踪的 `Application` 本身上配置覆盖——通过 `spec.ignoreDifferences[]` 或通过缩小 `Application` 的追踪资源集，使得 `velero.io` 种类超出范围。

## 诊断步骤

在更改任何配置之前确认修剪模式。Velero `Schedule` CRD 在 `Schedule.status.lastBackup` 中记录最近的触发时间（一个字符串字段；`phase` 枚举为 `{New, Enabled, FailedValidation}`），因此一个 `phase` 为 `Enabled` 且 `lastBackup` 不断推进而没有对应的 `Backup` CR 通过 `kubectl get backup` 可见的 `Schedule` 是外部行为者在创建后删除 `Backup` CR 的诊断特征：

```bash
kubectl get schedule -n cpaas-system <schedule-name> \
  -o jsonpath='{.status.phase}{"  "}{.status.lastBackup}{"\n"}'
kubectl get backup -n cpaas-system
```

通过计划触发观察命名空间，并观察 `Backup` CR 短暂出现然后在几分钟内消失——这种短暂的生命周期是外部删除者在 `Backup` CR 的触发和下一个协调周期之间对其进行操作的实时特征：

```bash
kubectl get backup -n cpaas-system -w
```

在对 `ArgoCD` CR 应用 `resourceExclusions` 更改后，重复通过后续计划触发的相同观察：`Backup` CR 现在应该在下一个 Argo CD 协调周期后持续存在。
