---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB260400002
sourceSHA: a519086d18a6d6794e430a1cd51583fe8a3f476939dda7cac8a84242eb327695
---

# 集群镜像注册表清理：管理员手册（手动和定期任务）

## 介绍

本文档描述了从目标 ACP 集群的 **内部注册表** 中修剪镜像的管理程序。它涵盖了立即手动执行和通过 Kubernetes `CronJob` 进行的定期自动执行。

此解决方案的目标是：

- 安全地删除集群中不再使用的镜像。
- 通过保留时间、修订计数和白名单规则控制清理行为。
- 先进行干运行，然后在验证后仅执行确认的清理。
- 在需要时触发注册表垃圾回收（GC）。
- 配置定期任务以进行自动清理。

## 术语

本文档一致使用以下术语：

- **内部注册表**：作为目标 ACP 集群一部分部署和管理的镜像注册表。
- **注册表端点**：`ac adm prune images` 用于与注册表通信的 HTTP(S) 端点。
- **外部注册表端点**：在默认的集群内注册表端点不可达或不适用时，通过 `--registry-url` 手动指定的注册表端点。

除非另有说明，本文档中的镜像修剪目标是当前集群的 **内部注册表**。

## 先决条件

- 已安装 ACP CLI (`ac`)。
- 您在目标 ACP 集群上具有管理员权限。
- 您可以访问目标集群。
- 您可以访问目标集群的内部注册表。
- 如果在 Pod 或 CronJob 内运行：
  - 必须配置 `serviceAccountName`。
  - ServiceAccount 必须具有检查工作负载、访问注册表 API 的权限，并且如果启用了 GC，则必须能够访问 `image-registry` Pod exec 端点。

## 架构概述

```text
┌────────────────────┐
│ CronJob / Job / Pod│
│ ac adm prune images│
└─────────┬──────────┘
          │
          │ 扫描正在使用的镜像
          ▼
┌────────────────────┐
│ Kubernetes API     │
│ Pods/Deployments...│
└─────────┬──────────┘
          │
          │ 获取注册表元数据
          ▼
┌────────────────────┐
│ 镜像注册表 API    │
│ repos/tags/digests │
└─────────┬──────────┘
          │
          │ 过滤和删除清单
          ▼
┌────────────────────┐
│ 修剪结果          │
│ （可选 GC）      │
└────────────────────┘
```

## 默认行为

所有参数都是可选的。默认情况下，`ac adm prune images` 以 **干运行模式** 运行。在此模式下，该命令评估集群镜像使用情况，查询注册表元数据并打印修剪候选项，但不会 **删除** 任何镜像清单。

实际删除仅在明确指定 `--confirm` 时执行。

## 参数参考

| 参数                              | 目的                                                                                                                                       | 典型示例                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `--keep-younger-than=<duration>`  | 保留最近创建的镜像                                                                                                                      | `168h`                            |
| `--keep-tag-revisions=<N>`        | 每个存储库保留最新的 N 个修订                                                                                                            | `5`                               |
| `--all`                           | 忽略基于保留的过滤器，修剪所有未使用的镜像。白名单规则仍然适用。                                                                          | `--all`                           |
| `--whitelist=<regex>`             | 排除与正则表达式匹配的存储库。可重复；任何匹配都会保护该存储库。                                                                          | `^cpaas-system/.*`               |
| `--dry-run`                       | 以检查模式运行并打印修剪候选项，而不删除任何内容。这是默认行为。                                                                          | `--dry-run`                       |
| `--confirm`                       | 执行实际删除符合条件的镜像清单。没有此标志，不会执行删除。                                                                                | `--confirm`                       |
| `--prune-registry`                | 在非干运行模式下修剪后触发注册表垃圾回收。此标志在干运行模式下无效。                                                                    | `--prune-registry`               |
| `--registry-url=<url>`            | 用手动指定的端点覆盖默认注册表端点。                                                                                                      | `http://image-registry.cpaas-system` |
| `--catalog-page-size=<N>`         | 每个注册表目录页面请求的存储库数量。默认值为 `1000`；有效值为 `1` 到 `10000`，`0` 使用默认值。                                         | `1000`                            |

## 参数规则和约束

组合修剪参数时适用以下规则：

- 实际删除需要 `--confirm`。没有 `--confirm`，命令仅报告修剪候选项。
- `--dry-run` 和 `--confirm` 代表互斥的执行意图。在实践中，使用干运行进行检查，使用 `--confirm` 进行删除。
- `--all` 指示命令忽略基于保留的过滤器，例如 `--keep-younger-than` 和 `--keep-tag-revisions`，并修剪所有当前未使用的镜像，受白名单规则的约束。
- `--whitelist=<regex>` 保护与之匹配的存储库不被修剪。可以多次指定。如果存储库匹配任何白名单规则，则将其排除在删除之外。
- `--prune-registry` 仅在非干运行执行中有意义。它在修剪工作流后触发注册表垃圾回收，即使在该运行期间没有删除任何清单。
- `--registry-url=<url>` 覆盖默认的集群内注册表端点 `http://image-registry.cpaas-system`。当作业或操作员工作站必须通过不同的端点访问注册表时使用。
- `--catalog-page-size=<N>` 控制注册表 `_catalog` 分页。较大的值可以减少在大型注册表中的分页往返，但每个注册表请求可能会花费更长时间并使用更多内存。

## 推荐使用顺序

对于生产环境，使用以下发布顺序：

1. 运行干运行，使用预期的保留和白名单规则。
2. 审查报告的修剪候选项。
3. 仅在候选集经过验证后，使用 `--confirm` 重新运行相同的命令。
4. 仅在计划的维护窗口或非高峰期启用 `--prune-registry`，如果需要注册表垃圾回收。

## 实施步骤

### 步骤 1：登录并选择目标集群

```bash
ac login <acp-url>
ac config get-clusters
ac config use-cluster <cluster-name>
```

### 步骤 2：运行干运行以审查修剪候选项

在执行任何删除之前，以默认的干运行模式运行命令以审查修剪候选项并验证保留规则。

```bash
ac adm prune images
```

如果从 `ac` 运行的地方无法访问默认的集群内注册表端点，请使用 `--registry-url` 指定一个可访问的注册表端点。

```bash
ac adm prune images --registry-url=<external-registry-url>
```

对于大型注册表，您可以请求更大的目录页面以减少 `_catalog` 分页往返。

```bash
ac adm prune images --catalog-page-size=1000
```

### 步骤 3：使用保留策略运行确认的清理

以下示例保留小于 7 天的镜像，保留每个存储库的最新 5 个修订，排除 `cpaas-system` 命名空间中的存储库，并执行确认的清理。

```bash
ac adm prune images \
  --keep-younger-than=168h \
  --keep-tag-revisions=5 \
  --whitelist='^cpaas-system/.*' \
  --confirm
```

### 步骤 4：在需要时触发 GC

以下示例保留小于 3 天的镜像，保留每个存储库的最新 3 个修订，并在确认的清理运行期间触发注册表 GC。

```bash
ac adm prune images \
  --keep-younger-than=72h \
  --keep-tag-revisions=3 \
  --prune-registry \
  --confirm
```

## 使用 CronJob 配置定期清理

### 基础 CronJob 模板

以下 CronJob 每天凌晨 2:00 针对内部注册表运行镜像修剪检查。由于未指定 `--confirm`，因此默认以干运行模式运行。

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ac-prune-images-cronjob
  namespace: cpaas-system
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: ac-images-pruner-sa
          restartPolicy: Never
          containers:
            - name: ac
              image: <platform-registry-url>/alauda/ac:<tag>
              args:
                - adm
                - prune
                - images
```

注意：

- `<platform-registry-url>`：目标 ACP 平台的注册表端点。
- `<tag>`：目标 ACP 平台提供的 AC 镜像标签。
- `serviceAccountName: ac-images-pruner-sa`：ServiceAccount 必须能够检查工作负载资源以识别正在使用的镜像，并在启用注册表垃圾回收时执行到注册表 Pod。注册表标签、清单和删除操作通过使用解析的 `ac` 身份验证令牌通过注册表 API 执行。

## 为什么需要这些权限

修剪工作流需要检查集群工作负载和注册表侧镜像元数据，以安全地确定哪些镜像未使用。

示例 RBAC 授予以下目的的权限：

- **工作负载发现**：\
  需要对 Pods、Deployments、StatefulSets、DaemonSets、ReplicaSets、Jobs、CronJobs 和 ReplicationControllers 等资源的 `get`、`list` 和 `watch` 权限，以便命令可以发现当前集群中使用的镜像引用。

- **注册表镜像检查**：\
  该命令直接查询注册表 API 以列出存储库、标签和任何所需的清单元数据。Kubernetes 注册表镜像自定义资源权限不需要此 API 路径。

- **镜像删除**：\
  确认的修剪通过注册表 API 删除符合条件的清单。解析的 `ac` 令牌或集群内 ServiceAccount 令牌必须获得目标存储库的注册表代理授权。

- **注册表垃圾回收支持**：\
  仅在启用注册表垃圾回收时需要对 `pods/exec` 的 `create` 访问权限，因为工作流可能需要通过注册表 Pod 执行与 GC 相关的操作。

## RBAC 范围推荐

仅授予所选执行模式所需的权限：

- 对于 **仅干运行**，需要工作负载发现权限和注册表 API 读取授权。
- 对于 **确认修剪**，还需要注册表 API 删除授权。
- 对于 **注册表 GC**，还需要 `pods/exec` 权限。

## 完全可运行示例（推荐起始点）

如果您想要一个完整的、端到端的干运行设置，可以立即应用和验证，请从以下示例开始。它旨在成为您在调整生产的计划或修剪策略之前的主要参考配置。

首先，创建 CronJob 所需的 ServiceAccount 和 ClusterRole。

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ac-images-pruner-sa
  namespace: cpaas-system
  labels:
    cpaas.io/cleanup: ac-images-pruner
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ac-images-pruner-role
  labels:
    cpaas.io/cleanup: ac-images-pruner
rules:
  - apiGroups: [""]
    resources: ["pods", "replicationcontrollers"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets", "replicasets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ac-images-pruner-rolebinding
  labels:
    cpaas.io/cleanup: ac-images-pruner
subjects:
  - kind: ServiceAccount
    name: ac-images-pruner-sa
    namespace: cpaas-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ac-images-pruner-role
```

然后创建 `CronJob`。

此示例每 6 小时运行一次镜像修剪，保留在过去 7 天内创建的镜像，保留每个存储库的最新 5 个修订，并排除 `cpaas-system` 命名空间下的存储库。由于未包含 `--confirm`，因此这是一个干运行配置。

```yaml
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ac-prune-images-cronjob
  namespace: cpaas-system
  labels:
    cpaas.io/cleanup: ac-images-pruner
spec:
  schedule: "0 */6 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    metadata:
      labels:
        cpaas.io/cleanup: ac-images-pruner
    spec:
      template:
        metadata:
          labels:
            cpaas.io/cleanup: ac-images-pruner
        spec:
          serviceAccountName: ac-images-pruner-sa
          restartPolicy: Never
          containers:
            - name: ac
              image: <platform-registry-url>/alauda/ac:<tag>
              args:
                - adm
                - prune
                - images
                - --keep-younger-than=168h
                - --keep-tag-revisions=5
                - --catalog-page-size=1000
                - --whitelist=^cpaas-system/.*
              securityContext:
                allowPrivilegeEscalation: false
                runAsNonRoot: true
                runAsUser: 65532
```

应用资源：

```bash
ac apply -f ac-prune-images-cronjob.yaml
```

触发一个手动作业以进行即时验证：

```bash
ac create job --from=cronjob/ac-prune-images-cronjob \
  ac-prune-images-cronjob-manual -n cpaas-system
```

检查执行结果：

```bash
ac get job -n cpaas-system ac-prune-images-cronjob-manual
```

## 重要考虑事项和最佳实践

在将可运行示例调整为生产环境时，请遵循以下指导：

- 在启用 `--confirm` 之前始终从干运行模式开始。
- 在使用 `--all` 或激进的保留设置之前仔细验证白名单规则。
- 使用仅具有所选执行模式所需权限的专用 ServiceAccount。
- 在非高峰期安排确认的清理和注册表 GC。
- 在生产环境中，除非需要经过完全验证的激进策略，否则至少保留一个小的保留窗口和修订计数。
- 在依赖基于 CronJob 的定期清理之前，手动触发并验证一个作业。
- 定期检查日志，以确认修剪候选项符合预期，并且没有受保护的存储库受到影响。
- 在文档和日常操作中优先使用单一的操作 CLI。如果 ACP 环境标准化为 `ac`，请在部署、验证和清理任务中一致使用 `ac`。
- 在故障排除期间使用 `-v=4` 打印命令使用的注册表端点、身份验证模式和目录页面大小。

## 推荐的策略模式

以下策略模式可作为调整调度和修剪行为以实现不同操作目标的参考。

| 场景                       | 推荐调度         | 建议标志                                                                                                           | 备注                                                               |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 每日检查                   | `0 2 * * *`      | `--keep-younger-than=168h --keep-tag-revisions=5 --catalog-page-size=1000 --whitelist=^cpaas-system/.*`            | 仅干运行；适合每日查看修剪候选项                                   |
| 每周生产清理               | `30 3 * * 0`     | `--keep-younger-than=336h --keep-tag-revisions=10 --catalog-page-size=1000 --whitelist=^cpaas-system/.* --confirm` | 推荐的生产基线策略                                               |
| 每月激进清理               | `0 4 1 * *`      | `--all --whitelist=^cpaas-system/.* --whitelist=^pro-ns1/base/.* --confirm`                                       | 仅在彻底验证白名单后使用                                         |
| 每周清理与 GC              | `0 1 * * 6`      | `--keep-younger-than=720h --keep-tag-revisions=5 --prune-registry --confirm`                                       | 在非高峰窗口安排                                                 |

## 验证

在部署 CronJob 后，按以下顺序验证配置、一次性执行结果和修剪行为。

### 1. 验证资源创建

确认计划任务及其相关资源已成功创建。

```bash
ac get cronjob -n cpaas-system -l cpaas.io/cleanup=ac-images-pruner
ac get job -n cpaas-system -l cpaas.io/cleanup=ac-images-pruner
ac get pod -n cpaas-system -l cpaas.io/cleanup=ac-images-pruner
```

检查：

- 预期的 CronJob 名称和调度
- 由 CronJob 或手动触发创建的作业
- 执行后处于 `Completed` 状态的 Pod

### 2. 验证作业完成状态

详细检查作业和 Pod 状态。

```bash
ac describe job -n cpaas-system <job-name>
ac describe pod -n cpaas-system <pod-name>
```

预期结果：

- 作业达到 `Complete`
- Pod 阶段为 `Succeeded`
- 容器 `exitCode` 为 `0`
- `restartCount` 保持为 `0`

### 3. 验证日志中的命令输出

查看作业日志以确认修剪命令实际执行了什么。

```bash
ac logs job/<job-name> -n cpaas-system
```

对于干运行，确认日志显示：

- 集群镜像扫描成功完成
- 注册表元数据成功获取
- 列出了候选镜像
- 未执行任何实际删除

对于确认运行，另外确认日志显示：

- 删除了符合条件的清单
- 遵循了白名单规则
- 仅在指定 `--prune-registry` 时触发了注册表 GC

### 4. 在启用确认清理之前验证策略行为

在生产中启用 `--confirm` 之前，手动验证报告的候选项是否符合预期策略。

具体验证：

- 最近创建的镜像根据 `--keep-younger-than` 保留
- 最近的修订根据 `--keep-tag-revisions` 保留
- 与任何 `--whitelist` 规则匹配的存储库被排除
- 活动工作负载未引用任何报告为修剪候选的镜像

### 5. 验证注册表端点选择

如果使用了 `--registry-url`，确认该端点可以从作业 Pod 访问，并且与预期的注册表匹配。

建议检查：

```bash
ac describe pod -n cpaas-system <pod-name>
ac logs job/<job-name> -n cpaas-system
```

确认：

- 作业使用了预期的端点
- 没有身份验证或连接错误
- 该端点对应于目标集群注册表

### 6. 单独验证启用时的注册表 GC

如果启用了 `--prune-registry`，请仔细查看日志以确认垃圾回收成功启动。

推荐检查：

- GC 仅在维护或非高峰窗口执行
- `pods/exec` 没有权限错误
- 在 GC 期间或之后没有观察到注册表可用性问题

典型成功的 Pod 日志（示例）：

```text
[1/5] 正在扫描集群以查找使用的镜像...
      找到 75 个唯一的镜像引用。
[2/5] 正在从注册表获取元数据...
      扫描了 9 个存储库，找到 1 个镜像实例。
[3/5] 正在修剪 1 个镜像清单...
      干运行：将删除 pro-ns1/demo/bash:5
[4/5] 摘要
      修剪候选：1
[5/5] 跳过注册表垃圾回收，因为未设置 --prune-registry。
```

## 故障排除

使用以下表格识别常见问题和最快的检查方法。

| 症状                                                | 可能原因                                                                                             | 首先检查什么                                                                                                                 | 建议的操作                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `no current context set`                           | 没有可用的集群内回退，且容器中没有有效的 CLI 上下文                                                | 检查 AC 版本以及 Pod 是否预期使用集群内凭据                                                                                 | 升级到兼容的 AC 版本，并验证 ServiceAccount 令牌挂载和集群内身份验证行为                                            |
| `forbidden` / `cannot list ...`                    | 缺少工作负载发现的 RBAC 权限                                                                          | 运行 `ac auth can-i list pods --as system:serviceaccount:cpaas-system:ac-images-pruner-sa` 和类似检查所需资源的权限          | 授予缺少的 `get/list/watch` 权限以访问工作负载资源                                                                  |
| `forbidden` 删除镜像时                           | 注册表代理接受读取请求但拒绝删除请求                                                                  | 检查运行是否使用 `--confirm`，以及解析的令牌是否获得授权以删除目标存储库中的清单                                          | 授予确认清理所需的注册表删除授权                                                                                   |
| `401` / `403` 获取注册表标签或清单时            | 注册表端点可达，但身份验证或授权失败                                                                  | 检查日志以获取正在使用的确切注册表端点，并验证 ServiceAccount 授权路径                                                  | 验证注册表代理身份验证/授权配置、令牌处理，以及 `--registry-url` 是否指向正确的端点                                |
| `failed to list registry pods`                     | 缺少对注册表 Pod 命名空间的访问或缺少权限                                                            | 检查 `cpaas-system` 中是否存在注册表 Pod，以及 ServiceAccount 是否可以访问相关资源                                       | 验证命名空间、资源名称和与 GC 相关的 Pod 访问的 RBAC                                                                  |
| `pods/exec is forbidden`                           | 启用了 GC，但缺少 exec 权限                                                                           | 确认是否启用了 `--prune-registry`，以及 `pods/exec` 是否具有 `create` 权限                                               | 在 `pods/exec` 上添加 `create` 权限                                                                                   |
| 未找到修剪候选                                    | 保留策略过于保守，白名单过于宽泛，或集群正在积极使用大多数镜像                                         | 查看日志并比较报告的候选集与配置的 `--keep-*` 和 `--whitelist` 值                                                          | 从干运行开始，然后逐渐放宽保留或缩小白名单规则                                                                     |
| 意外的镜像出现在候选项中                          | 注册表端点不匹配、策略配置错误，或工作负载扫描未反映实际使用                                          | 验证所选注册表端点、白名单模式和工作负载可见性                                                                          | 在干运行模式下重新运行，并在需要时使用显式的 `--registry-url`，并查看 RBAC 覆盖情况                                   |
| CronJob 不创建作业                                | 调度无效、CronJob 被挂起或控制器问题                                                                   | 运行 `ac describe cronjob -n cpaas-system <cronjob-name>`                                                                    | 验证调度表达式，确保 CronJob 未被挂起，并检查集群控制器健康状况                                                    |
| 作业存在但 Pod 不启动                             | 镜像拉取失败、入场拒绝或安全策略不匹配                                                                  | 运行 `ac describe job` 和 `ac describe pod`                                                                                 | 验证 AC 镜像可用性、镜像拉取访问权限和 Pod 安全设置                                                                  |
| Pod 重启或重复失败                                 | 容器运行时错误或命令失败                                                                               | 检查 `restartCount`、Pod 事件和日志                                                                                       | 在重试之前修复命令参数、镜像版本或集群策略问题                                                                       |

## 快速诊断工作流程

当计划的修剪任务失败时，请使用以下顺序：

1. 确认 CronJob 存在且调度有效。
2. 确认作业成功创建。
3. 确认 Pod 被创建并检查 Pod 事件。
4. 查看容器日志以获取修剪工作流阶段和确切错误文本。
5. 验证 ServiceAccount RBAC，使用 `ac auth can-i`。
6. 如果设置了 `--registry-url`，请验证端点可达性和授权。
7. 当您需要确认命令使用的注册表端点、身份验证模式和目录页面大小时，请使用 `-v=4` 重新运行。
8. 如果启用了 `--prune-registry`，请验证 `pods/exec` 权限和注册表 Pod 可用性。

## 清理演示资源

```bash
# 删除命名空间范围的资源（如 CronJob、Job、Pod 和 ServiceAccount）
ac delete cronjob,job,pod,serviceaccount \
  -n cpaas-system \
  -l cpaas.io/cleanup=ac-images-pruner \
  --ignore-not-found

# 删除集群范围的资源（如 ClusterRole 和 ClusterRoleBinding）
ac delete clusterrole,clusterrolebinding \
  -l cpaas.io/cleanup=ac-images-pruner \
  --ignore-not-found
```
