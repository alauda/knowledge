---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500016
sourceSHA: 2ba53aed483668d8fd7c0f20511815c25f998c4a5d60db811c4ed5d12e57579f
---

# 在控制平面上自动化 etcd 快照备份

## 概述

etcd 是每个 Kubernetes 对象的真实来源。失去它——通过磁盘损坏、同时节点故障或意外删除——而没有最近的备份，将导致整个集群的重建。自动化定期的主机快照是平台可以维护的最便宜和最有效的灾难恢复原语。

在 ACP 上，首选机制是平台在 `configure/backup` 下的备份接口，它协调快照、应用保留策略并将其存储在集群外。当平台管理的备份不可用时（早期启动、隔离实验室或当操作员希望有额外的本地副本时），在每个控制平面节点上调用 `etcdctl snapshot` 的最小权限 CronJob 是一个合理的后备方案。

## 解决方案

### 首选：平台管理的备份

使用 ACP 的 configure/backup 页面为集群启用控制平面备份。选择一个计划、保留窗口和目标存储位置（兼容 S3 的对象存储是常见选择）。平台处理：

- 在 **每个** 控制平面节点上的一致调用，而不仅仅是脚本恰好选择的第一个节点，
- 目标存储的凭证管理，
- 保留 / 垃圾回收，
- 与恢复工具的集成（这是人们常常忘记验证的灾难恢复的一半）。

平台管理的备份消除了在用户命名空间中需要特权 Pod 的需求；每当可用时，优先选择它。

### 后备：定时快照作业

如果平台接口尚未启用，请运行一个 CronJob，在每个控制平面节点上调用 `etcdctl snapshot save`。保持权限严格：该作业需要读取 etcd TLS 材料并写入每个控制平面节点上的一个已知目录，而不需要其他权限。

1. **创建一个专用命名空间和 ServiceAccount。**

   ```bash
   kubectl create namespace etcd-backup
   kubectl -n etcd-backup create serviceaccount etcd-backup
   ```

2. **仅授予作业所需的集群范围读取权限。** 需要节点访问权限以枚举控制平面节点；在 `kube-system` 上需要 `pods/exec` 权限以发出 `etcdctl snapshot`。避免任何未列出的特权。

   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRole
   metadata:
     name: etcd-backup
   rules:
     - apiGroups: [""]
       resources: ["nodes"]
       verbs: ["get", "list"]
     - apiGroups: [""]
       resources: ["pods"]
       verbs: ["get", "list"]
     - apiGroups: [""]
       resources: ["pods/exec"]
       verbs: ["create"]
   ---
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRoleBinding
   metadata:
     name: etcd-backup
   subjects:
     - kind: ServiceAccount
       name: etcd-backup
       namespace: etcd-backup
   roleRef:
     apiGroup: rbac.authorization.k8s.io
     kind: ClusterRole
     name: etcd-backup
   ```

3. **安排快照。** 以下作业每天运行一次，遍历每个控制平面 Pod，在 etcd 容器内进行快照，并删除超过 7 天的快照。根据您的 RPO 目标调整计划和保留策略。

   ```yaml
   apiVersion: batch/v1
   kind: CronJob
   metadata:
     name: etcd-snapshot
     namespace: etcd-backup
   spec:
     schedule: "7 3 * * *"                 # 每天 03:07 UTC
     concurrencyPolicy: Forbid
     successfulJobsHistoryLimit: 3
     failedJobsHistoryLimit: 5
     jobTemplate:
       spec:
         backoffLimit: 0
         ttlSecondsAfterFinished: 3600
         template:
           spec:
             serviceAccountName: etcd-backup
             restartPolicy: Never
             containers:
               - name: snapshot
                 image: bitnami/kubectl:1.33
                 command:
                   - /bin/bash
                   - -ec
                   - |
                     set -o pipefail
                     for pod in $(kubectl -n kube-system get pod \
                         -l component=etcd \
                         -o jsonpath='{.items[*].metadata.name}'); do
                       dest="/var/lib/etcd/backup/snapshot-$(date -u +%Y%m%dT%H%M%SZ).db"
                       echo "===== $pod -> $dest"
                       kubectl -n kube-system exec "$pod" -c etcd -- sh -c "
                         mkdir -p \$(dirname $dest) &&
                         ETCDCTL_API=3 etcdctl \
                           --endpoints=https://127.0.0.1:2379 \
                           --cacert=/etc/kubernetes/pki/etcd/ca.crt \
                           --cert=/etc/kubernetes/pki/etcd/server.crt \
                           --key=/etc/kubernetes/pki/etcd/server.key \
                           snapshot save $dest &&
                         find \$(dirname $dest) -name 'snapshot-*.db' -mtime +7 -delete
                       "
                     done
   ```

4. **将快照传输到集群外。** 仅在控制平面节点上存在的快照无法承受其旨在覆盖的故障模式。将 CronJob 与一个 sidecar 或单独的作业配对，上传新的 `snapshot-*.db` 文件到恢复工具可以访问的对象存储——`rclone`、`aws s3 cp`，或一个挂载节点本地路径并流式传输到存储桶的 init-container。

5. **恢复演练。** 从未执行过恢复的备份是猜测。每季度在一个一次性测试集群中进行恢复并记录运行手册。确切的恢复操作步骤是平台特定的（它从快照重建 etcd 静态 Pod）；在压力下不要即兴发挥，而是查阅平台的灾难恢复文档。

## 诊断步骤

确认 CronJob 已运行并在预期节点上留下了工件：

```bash
kubectl -n etcd-backup get jobs --sort-by=.status.startTime | tail -n 10
kubectl -n etcd-backup logs job/$(kubectl -n etcd-backup get job -o jsonpath='{.items[-1].metadata.name}')
```

检查控制平面节点的快照文件：

```bash
NODE=<control-plane-1>
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host ls -lh /var/lib/etcd/backup/ 2>/dev/null
```

在依赖快照之前检查其完整性：

```bash
kubectl -n kube-system exec etcd-<host> -c etcd -- \
  sh -c 'ETCDCTL_API=3 etcdctl snapshot status \
           /var/lib/etcd/backup/<file.db> -w table'
```

预期输出列出快照哈希、总键数和总大小——空或截断的快照通常会直接导致状态命令失败。如果 `snapshot save` 返回 `context deadline exceeded`，请通过 `--dial-timeout` 和 `--command-timeout` 提高命令超时；健康的 etcd 应在一分钟内完成快照，即使在具有几个 GB 数据的集群上。
