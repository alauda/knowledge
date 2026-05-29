---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500659
sourceSHA: e4eeafcb96a0db7ab22423f61ca75269722a804fccd98e38837b64c5c28116d1
---

# 实时迁移的 virt-launcher Pods 保持在 Completed 状态并阻止 RWO PVC 删除

## 问题

在 Alauda 容器平台 (Kubernetes `v1.34.5-1`, KubeVirt ModulePlugin `v1.7.0-alauda.2`, HCO operator `1.17.0`, virt-launcher 镜像 `registry.alauda.cn:60080/3rdparty/kubevirt/virt-launcher:v1.7.0-alauda.2`) 上，每次成功的虚拟机实例实时迁移后，源节点的 `virt-launcher-<vmi>-<suffix>` Pod 会保持在 `STATUS=Completed`（Pod 阶段为 `Succeeded`）而不是被删除；在迁移目标节点上会启动一个新的 Pod 来运行 VMI。因此，相同 VMI 的重复迁移会在虚拟机的命名空间中累积 N 个 Completed Pods，以及恰好一个 Running Pod，所有 Pods 共享相同的 `virt-launcher-<vmi>-` 前缀。诊断模式与 `kubectl get pods` 匹配，显示许多行 `STATUS=Completed` 和 `READY=0/3`，加上一行 `STATUS=Running` 和 `READY=3/3`（`0/3` 和 `3/3` 反映了 virt-launcher `v1.7.0-alauda.2` 每个 Pod 运行三个容器 — `compute`、`volumecontainerdisk` 和一个 sidecar；相关信号是“许多 Succeeded，一个 Running”）。

对于任何挂载 `ReadWriteOnce` 持久卷声明的虚拟机，还会出现一个次要症状 — 最常见的是自动配置的 vTPM 支持的 PVC，但该行为是通用的：由这些剩余的 Completed Pods 引用的 PVC 在 `kubectl delete pvc` 后保持 `STATUS=Terminating`，因为标准的 `kubernetes.io/pvc-protection` finalizer 保留在 `metadata.finalizers` 中，直到挂载 PVC 的每个 Pod 都被删除。

## 根本原因

VirtualMachineInstanceMigration (`virtualmachineinstancemigrations.kubevirt.io/v1`，在 UI 中缩写为 VMIM；上游种类名称为 `VirtualMachineInstanceMigration`，而不是 `VirtualMachineMigrationInstance`) 是一个每次迁移的对象，用于跟踪一个 VMI 从源主机到目标主机的移动。迁移的进度在 `virtualmachineinstance.status.migrationState` 中反映，该字段包含 `sourceNode`、`sourcePod`、`targetNode`、`targetPod`、`migrationUid` 和 `completed` 字段 — 因此控制器在整个迁移过程中区分源侧 Pod 和目标侧 Pod。当迁移成功完成时，libvirt 在源 virt-launcher Pod 上被拆除，其 `compute` / `volumecontainerdisk` 容器以 `exitCode=0` 和 `reason=Completed` 干净退出；KubeVirt 不会删除 Pod 对象。

VMIM 对象本身是垃圾回收的：virt-controller 仅保留每个 VMI 最近的五个 Succeeded/Failed VMIM。在一次验证运行中，对同一 VMI 执行了九个连续的 `VirtualMachineInstanceMigration` 资源，正好有五个 VMIM 对象存活（按 `creationTimestamp` 排序的五个最新对象）；前四个被自动删除。这个保留阈值在上游 virt-controller 中是硬编码的 — 集群的 `kubevirt` 资源上的 `spec.configuration.migrations` 暴露了 `allowAutoConverge`、`allowPostCopy`、`completionTimeoutPerGiB`、`parallelMigrationsPerCluster`、`progressTimeout` 和 `parallelOutboundMigrationsPerNode`，但没有保留或完成 Pod GC 字段，因此该阈值无法从 HyperConverged CR 调整。启动 Pod 清理本身也是如此：`virt-controller` 的容器参数暴露了 `--launcher-image`、`--exporter-image`、`--port` 和 `-v`，没有 `--completed-pod-gc` 或等效标志。

Completed Pods 与 VMI 的生命周期相关，而不是 VMIM 的。停止虚拟机（通过 `virtctl stop` 或通过 `kubectl patch vm <name> --type=merge -p '{"spec":{"runStrategy":"Halted"}}'` 触发 VMI 删除）会级联删除每个 `virt-launcher-<vmi>-<suffix>` Pod：在同一次验证运行中，命名空间从十个 Pods（九个 Completed + 一个 Running）立即变为零，VMI 被移除后，五个存活的 VMIM 也通过拥有者引用级联被清理。

Terminating-PVC 症状是核心 Kubernetes 行为，而不是 KubeVirt 特有的。`pvc.metadata.finalizers` 被声明为“在对象从注册表中删除之前必须为空” — `kubectl explain pvc.metadata.finalizers` 确认了这一形状 — `kubernetes.io/pvc-protection` finalizer 是由 `kube-controller-manager` 自动添加到任何被 Pod 引用的 PVC。用一个普通的 `topolvm-hdd` RWO PVC 挂载的长时间运行的 Pod 重现该机制，导致 `STATUS=Terminating` 在 `kubectl delete pvc --wait=false` 后立即出现，`metadata.deletionTimestamp` 被设置，`metadata.finalizers=["kubernetes.io/pvc-protection"]` 仍然存在，直到持有 Pod 被移除。原报告中的 vTPM 案例只是这一规则最明显的实例：一个启用 vTPM 的虚拟机自动配置一个 RWO PVC，而剩余的 Completed 启动 Pods 仍然引用它，因此 PVC 等待 `pvc-protection`，就像任何其他具有活动引用者的 RWO PVC 一样。

## 解决方案

累积的 Completed `virt-launcher-<vmi>-<suffix>` Pods 是无效的 — 它们的容器已经以 `exitCode=0` 退出，并且除了 Pod 对象的 apiserver/etcd 占用外，不消耗 CPU 或内存 — 因此在虚拟机下次停止之前将它们保留在原地是一个有效的操作姿态；最干净的删除路径是让 VMI 拆解一次性处理它们。

当需要更快的回收时（最常见的是解除阻止由某个 Completed 启动 Pod 引用的 Terminating RWO PVC），直接删除 Completed Pods。剩余的 Running virt-launcher Pod 不受影响，虚拟机继续运行；一次验证删除一个 Completed 启动 Pod 使 VMI 当前运行的启动 Pod 始终保持 `Running 3/3`。将删除范围限制在不运行 VMI 的 Pods 上，通过选择 `status.phase=Succeeded`，以便 Running 启动 Pod 永远不会被匹配：

```bash
# 列出一个虚拟机的 Completed virt-launcher Pods
kubectl get pods -n <vm-namespace> \
  --field-selector=status.phase=Succeeded \
  -l kubevirt.io/vm=<vm-name>

# 删除它们
kubectl delete pods -n <vm-namespace> \
  --field-selector=status.phase=Succeeded \
  -l kubevirt.io/vm=<vm-name>
```

为了进行持续的日常维护，将相同的删除安排为 Kubernetes 的 `CronJob`（`batch/v1`，在该平台上注册）在虚拟机的命名空间中运行。Pod 字段选择器 `status.phase=Succeeded` 是 Kubernetes 用于任何“完成的 Pod”清理的相同原语，并且在这里得到了 apiserver 的尊重（此类 CronJob 的服务器端干运行被接受，字段选择器返回预期的 Succeeded Pods 列表，覆盖整个集群）。该作业的 ServiceAccount 需要在其命名空间中对 `pods` 进行 `get` / `list` / `delete` 权限：

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cleanup-completed-virt-launcher
  namespace: <vm-namespace>
spec:
  schedule: "*/30 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: launcher-cleanup
          restartPolicy: OnFailure
          containers:
            - name: kubectl
              image: <registry>/kubectl:<tag>
              command:
                - /bin/sh
                - -c
                - >
                  kubectl get pods -n <vm-namespace>
                  --field-selector=status.phase=Succeeded
                  -l kubevirt.io/vm
                  -o name | xargs -r kubectl delete -n <vm-namespace>
```

使用 `-l kubevirt.io/vm` 标签选择器（每个 virt-launcher Pod 都携带它，由 virt-controller 加盖）来限制删除仅限于 KubeVirt 拥有的 Pods，避免清除无关的 Succeeded Pods，例如一次性 Jobs。

对于仅由一个 Completed virt-launcher Pod 持有的 Terminating RWO PVC，删除该启动 Pod 会移除最后的引用者，`kube-controller-manager` 会剥离 `kubernetes.io/pvc-protection` finalizer，PVC 的删除将完成而无需进一步干预。

## 诊断步骤

确认一个虚拟机的症状。预期的形状是许多 Completed Pods (`READY=0/3`) 加上恰好一个 Running Pod (`READY=3/3`)，所有 Pods 前缀为 `virt-launcher-<vmi>-`：

```bash
kubectl get pods -n <vm-namespace> -l kubevirt.io/vm=<vm-name> -o wide
```

将 Completed Pods 与迁移历史进行交叉引用。在此构建中，`virtualmachineinstancemigrations.kubevirt.io` 仅保留每个 VMI 的最后五个 VMIM，因此在第六次迁移之后，Completed virt-launcher Pods 的数量通常会超过存活 VMIM 的数量；这是预期的，而不是泄漏：

```bash
kubectl get virtualmachineinstancemigration -n <vm-namespace> \
  --sort-by=.metadata.creationTimestamp
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath="{.status.migrationState}{'\n'}"
```

`migrationState` 字段是源/目标分割的结构标记 — 其 `sourcePod` 和 `targetPod` 名称直接映射到上面列出的 Completed 和 Running Pods。

对于 Terminating-PVC 案例，列出当前挂载 PVC 的 Pods；任何仍然引用它的 Pod（无论是 Running 还是 Completed）都会保持 `kubernetes.io/pvc-protection` finalizer：

```bash
kubectl get pvc <pvc-name> -n <vm-namespace> \
  -o jsonpath="{.metadata.deletionTimestamp} finalizers={.metadata.finalizers}{'\n'}"

kubectl get pods -n <vm-namespace> \
  -o jsonpath='{range .items[?(@.spec.volumes[*].persistentVolumeClaim.claimName=="<pvc-name>")]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}'
```

一旦引用者 Pods 被删除（手动或通过上述 CronJob），PVC 的 `metadata.finalizers` 数组将清空，apiserver 将删除该对象。
