---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500016
sourceSHA: 04b5ae4285d12ba210c6c4102510a01f4ba23fc966556f5e9cebd9d581abff9f
---

# 在 ACP 上搭建命名空间、RBAC 范围的定时备份工作负载

## 问题

在 Alauda 容器平台 (Kubernetes `v1.34.5`) 上，定时备份工作负载需要一个自包含的家：一个专用的命名空间来容纳其 pods，一个根据所选备份工具要求的 RBAC 身份，以及一个定期触发器。创建一个专用命名空间来容纳备份 pods，以便将工作负载与其他租户隔离，并可以作为一个单元管理其生命周期。支持的身份以标准 Kubernetes RBAC 表达，其行为在 ACP 上是相同的。

## 解决方案

首先创建专用命名空间；它是一个普通的 Kubernetes `Namespace` 对象：

```bash
kubectl create namespace acp-etcd-backup
```

将工作负载身份配置为 `ServiceAccount`、`ClusterRole` 和 `ClusterRoleBinding`。这些使用标准的 `rbac.authorization.k8s.io/v1` API 和标准的 RBAC 类型（`ClusterRole`、`ClusterRoleBinding`、`Role`、`RoleBinding`），在 ACP 上保持不变，因此不需要对 RBAC 对象进行平台特定的调整。下面的规则集是示例性搭建——它授予对节点的读取访问权限以及对 pods 和 `pods/log` 的管理权限；将实际的 `resources` 和 `verbs` 限制到所选备份工具所需的确切内容：

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backup-sa
  namespace: acp-etcd-backup
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: backup-runner
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "create", "delete", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: backup-runner
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: backup-runner
subjects:
  - kind: ServiceAccount
    name: backup-sa
    namespace: acp-etcd-backup
```

将工作负载作为 `CronJob` 在 `batch/v1` API 中调度，运行在专用命名空间中的 `backup-sa` ServiceAccount 下。下面的清单提供了通用的搭建——调度、身份和 pod shell；将容器的 `image` 和 `command` 填充为适合目标的备份工具：

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-cronjob
  namespace: acp-etcd-backup
spec:
  schedule: "0 */6 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: backup-sa
          restartPolicy: Never
          containers:
            - name: backup
              image: <backup-image>
              command: ["/bin/sh", "-c", "<backup-command>"]
```

上述搭建在专用命名空间的默认 pod 安全配置文件下运行备份容器；`image` 和 `command` 占位符填充为在这些默认设置下运行的备份工具。本文并未主张备份工作负载具有任何提升的 pod 级权限——如果特定备份工具记录了主机级或特权要求，请在依赖之前确认目标集群的 pod 安全策略是否允许该级别，因为集群的 pod 安全执行可能会拒绝它。

## 诊断步骤

通过手动触发 CronJob 并确认生成的 pod 和作业成功完成来验证设置。`batch/v1` API 支持使用 `--from=cronjob/<name>` 标志从现有 CronJob 创建临时 Job，因此不必等待调度：

```bash
kubectl create job test-backup \
  --from=cronjob/backup-cronjob -n acp-etcd-backup
```

通过检查命名空间中的 pods、jobs 和 cronjobs 来确认手动触发的运行已完成：

```bash
kubectl get cronjobs,jobs,pods -n acp-etcd-backup
```

一个已完成的 Job 和一个状态为 `Completed` 的 pod 表示命名空间、RBAC 和 CronJob 的搭建正确连接在一起。
