---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500016
sourceSHA: 8fb62852c433700b4b156f026d53891752b8fb40e94212e74b31e24d33a48577
---

# 在 ACP 上搭建命名空间、RBAC 范围的定期备份工作负载

## 问题

在 Alauda 容器平台 (Kubernetes `v1.34.5`) 上，定期备份工作负载需要一个自包含的家：一个专用命名空间来容纳其 Pods，一个根据所选备份工具要求的 RBAC 身份，以及一个定期触发器。创建一个专用命名空间来容纳备份 Pods，以便将工作负载与其他租户隔离，并可以作为一个单元管理其生命周期 \[ev:c1]。支持的身份以标准 Kubernetes RBAC 表达，在 ACP 上表现相同 \[ev:c2]。

## 解决方案

首先创建专用命名空间；它是一个普通的 Kubernetes `Namespace` 对象 \[ev:c1]：

```bash
kubectl create namespace acp-etcd-backup
```

将工作负载身份配置为 `ServiceAccount`、`ClusterRole` 和 `ClusterRoleBinding`。这些使用标准的 `rbac.authorization.k8s.io/v1` API 和标准的 RBAC 类型（`ClusterRole`、`ClusterRoleBinding`、`Role`、`RoleBinding`），在 ACP 上保持不变，因此不需要对 RBAC 对象进行平台特定的调整 \[ev:c2]。下面的规则集是示例性框架——它授予对节点的读取访问权限以及对 Pods 和 `pods/log` 的管理权限；将实际的 `resources` 和 `verbs` 限制到所选备份工具所需的确切内容 \[ev:c2]：

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

将工作负载作为 `CronJob` 在 `batch/v1` API 中调度，运行在专用命名空间中的 `backup-sa` ServiceAccount 下 \[ev:c6]。下面的清单提供了通用框架——调度、身份和 Pod shell；用适合目标的备份工具填充容器的 `image` 和 `command` \[ev:c6]：

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

上述框架在专用命名空间的默认 Pod 安全配置文件下运行备份容器；`image` 和 `command` 占位符填充为在这些默认设置下运行的备份工具 \[ev:c6]。本文并未主张备份工作负载具有任何提升的 Pod 级权限——如果特定备份工具文档中说明了主机级或特权要求，请确认目标集群的 Pod 安全策略是否允许该级别的权限，因为集群 Pod 安全强制执行可能会拒绝它。

## 诊断步骤

通过手动触发 CronJob 并确认生成的 Pod 和 Job 成功完成来验证设置 \[ev:c6]。`batch/v1` API 支持使用 `--from=cronjob/<name>` 标志从现有 CronJob 创建临时 Job，因此不必等待调度 \[ev:c6]：

```bash
kubectl create job test-backup \
  --from=cronjob/backup-cronjob -n acp-etcd-backup
```

通过检查命名空间中的 Pods、Jobs 和 CronJobs 确认手动触发的运行已完成 \[ev:c6]：

```bash
kubectl get cronjobs,jobs,pods -n acp-etcd-backup
```

一个已完成的 Job 和一个状态为 `Completed` 的 Pod 表明命名空间、RBAC 和 CronJob 框架已正确连接 \[ev:c6]。
