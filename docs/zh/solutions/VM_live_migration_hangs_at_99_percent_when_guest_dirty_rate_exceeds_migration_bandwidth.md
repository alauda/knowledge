---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500795
sourceSHA: 54ce54644c7fa89c9027f8efe79119eb37f75c823a40edca4ceba8fd212ef64f
---

# 虚拟机实时迁移在客机脏页率超过迁移带宽时卡在99%

## 问题

在运行 KubeVirt v1.7.0-alauda.2（HCO 操作员 1.17.0，CSV `kubevirt-hyperconverged-operator.v4.3.6`，命名空间 `kubevirt`）的 Alauda 容器平台上，基于 Kubernetes v1.34.5，`VirtualMachineInstanceMigration`（`kubevirt.io/v1`）报告进度但未能完成。迁移的时间已过去，`DataRemaining` 和 `MemoryRemaining` 在迭代中上下波动，而不是单调下降，源 `virt-launcher` pod 最终记录迁移因卡住而被中止。

每次迭代的进度 JSON 是由源 `virt-launcher` 从 `live-migration-source.go:736` 发出的（此构建的上游 KubeVirt v1.7.0 源行已从早期的 `:780` 移动）；字段包括 `TimeElapsed`、`DataProcessed`、`DataRemaining`、`DataTotal`、`MemoryProcessed`、`MemoryRemaining`、`MemoryTotal`、`MemoryBandwidth`、`DirtyRate`、`Iteration`、`PostcopyRequests`、`ConstantPages`、`NormalPages`、`NormalData`、`ExpectedDowntime`、`DiskMbps`。在这个构建上进行的直接集群重现，在繁忙的客机迁移测试中发出了以下行：

```text
迁移信息 <uuid>: TimeElapsed:8061ms DataProcessed:908MiB
  DataRemaining:0MiB DataTotal:2352MiB MemoryProcessed:619MiB MemoryRemaining:0MiB
  MemoryTotal:2064MiB MemoryBandwidth:320Mbps DirtyRate:9385Mbps Iteration:12
  PostcopyRequests:0 ...
```

`DirtyRate=9385Mbps` 对应 `MemoryBandwidth=320Mbps` 是本文所描述的收敛特征：客机写入速度超过每次迭代的复制预算。在快速链接上，小型客机仍然可以在几次迭代中收敛（上述示例在 8 秒内完成），但大型或写入繁忙的客机则持续波动，最终达到 KubeVirt 的进度超时。

## 根本原因

KubeVirt 的默认迁移方法是预复制：内存页面在虚拟机继续在源上运行的同时流向目标，每次迭代重新发送脏页面，直到剩余增量足够小，可以在配置的停机预算内切换。HCO 单例 `kubevirt-hyperconverged`（在命名空间 `kubevirt` 中）携带 `.spec.liveMigrationConfig`，默认值为 `allowPostCopy=false`、`completionTimeoutPerGiB=150`、`progressTimeout=150`，因此集群将仅尝试预复制，并且一旦每 GiB 的完成或进度预算耗尽就会放弃。

当 `DirtyRate` 在整个预复制窗口内保持高于 `MemoryBandwidth` 时，没有任何迭代能将 `MemoryRemaining` 降低到切换阈值以下；迭代次数增加，相同的脏页面被重新复制，预算在未收敛的情况下到期。

`HyperConverged` openAPIV3Schema 文档记录了这个确切的控制项及其语义：`completionTimeoutPerGiB` 是“基于 completionTimeoutPerGiB 乘以客机的大小计算的……使用较低的 completionTimeoutPerGiB 以诱导更快的失败，以便尝试另一个目标或后复制。使用较高的 completionTimeoutPerGiB 让内存脏页率波动的工作负载收敛”；`allowPostCopy` 是“启用时，KubeVirt 尝试在尝试预复制实时迁移时达到完成超时时使用后复制实时迁移。后复制迁移允许即使是最繁忙的虚拟机也能成功实时迁移”。

## 解决方案

有三种收敛策略可用；在此 ACP 构建中，今天只有前两种是功能性的。迁移策略覆盖路径在结构上存在并由迁移控制器应用，但后复制本身在此构建的 QEMU 层当前失败（请参见下面的后复制说明）。

### 1. 在迁移中暂停虚拟机以强制切换

对于已经在迁移中且接近收敛的迁移（小 `MemoryRemaining`，仅稍微波动），暂停客机可以阻止新的页面被标记为脏。下一个预复制轮次因此完成，KubeVirt 切换到目标，此时客机在目标上自动恢复——无需手动解除暂停。该子资源通过 kubevirt 聚合 API 公开为 `virtualmachineinstances/pause`（动词 PUT），并可以通过 kubevirt CLI 插件访问：

```bash
virtctl pause vm <vmi-name> -n <namespace>
```

这会导致最终内存传输的短暂停机窗口，但不需要任何集群级别的配置更改。

### 2. 降低 HyperConverged 单例上的 `completionTimeoutPerGiB`

缩短每 GiB 的完成窗口本身并不会启用后复制，但它使迁移控制器更快地声明收敛失败，因此操作员（或排水控制器）更早知道该虚拟机需要不同的策略。此构建上的 CRD 文档正好指出了这一用途（“诱导更快的失败，以便尝试另一个目标或后复制”）：

```bash
kubectl patch hyperconverged -n kubevirt kubevirt-hyperconverged \
  --type merge \
  -p '{"spec":{"liveMigrationConfig":{"completionTimeoutPerGiB":30}}}'
```

HCO 单例在此构建中是 `kubevirt-hyperconverged`，位于命名空间 `kubevirt`（HCO 将更改协调到 KubeVirt CR 中）。该更改适用于集群范围内的所有后续迁移；正在进行的迁移不会被回溯。

### 3. 通过 `MigrationPolicy` 将迁移覆盖范围限制到一个命名空间或虚拟机

`MigrationPolicy`（`migrations.kubevirt.io/v1alpha1`，集群范围）通过标签选择一部分虚拟机并应用定制的实时迁移配置。协调器将所选策略印章到 `vmim.status.migrationState.migrationPolicyName`，并将策略字段的 `migrationState.migrationConfiguration` 合并到 HCO 默认值之上：

```yaml
apiVersion: migrations.kubevirt.io/v1alpha1
kind: MigrationPolicy
metadata:
  name: busy-vm-policy
spec:
  completionTimeoutPerGiB: 30
  allowPostCopy: true
  selectors:
    namespaceSelector:
      kubernetes.io/metadata.name: my-vm-namespace
    virtualMachineInstanceSelector:
      workload-class: write-heavy
```

```bash
kubectl apply -f migrationpolicy.yaml
```

`MigrationPolicy.spec` 上支持的可调参数包括 `allowAutoConverge`、`allowPostCopy`、`allowWorkloadDisruption`、`bandwidthPerMigration` 和 `completionTimeoutPerGiB`；支持的选择器包括 `namespaceSelector` 和 `virtualMachineInstanceSelector`（标签映射）——在此构建上直接验证了 CRD 形状。一旦策略生效，迁移的 `status.migrationState.migrationConfiguration` 反映合并的策略值，这是确认覆盖生效的审计轨迹。

### 关于此构建上后复制的说明

尽管 `allowPostCopy=true` 被 `HyperConverged.spec.liveMigrationConfig` 和 `MigrationPolicy.spec` 接受，但实际的后复制切换在此 ACP 构建的 QEMU 层当前 **失败**。在集群上进行的重现应用了 `allowPostCopy: true` 通过 MigrationPolicy 并触发了繁忙客机的迁移，产生了：

```text
内部错误：无法执行 QEMU 命令 'migrate-set-capabilities':
后复制不受支持：Userfaultfd 不可用：操作不允许
```

`vmim.status.migrationState.failureReason` 包含此确切错误，迁移的 `mode` 保持为 `PreCopy`，VMI 从未移动到目标，`phase` 转换为 `Failed`。

此失败的根本原因是上游 Linux + 容器运行时的交互：后复制迁移依赖于内核的 `userfaultfd(2)` 机制从源请求页面客机内存，根据上游 Linux 政策，创建 userfaultfd 需要在节点 sysctl `vm.unprivileged_userfaultfd` 设置为 `0` 时具有 `CAP_SYS_PTRACE` 权限。KubeVirt 在 `/var/lib/kubelet/seccomp/kubevirt/kubevirt.json` 中提供的 seccomp 配置文件确实允许 `userfaultfd` 系统调用（`SCMP_ACT_ALLOW`），但此构建中 `virt-launcher` 计算容器的权限集不包括 `CAP_SYS_PTRACE`，因此权限检查在咨询 seccomp 过滤器之前拒绝了调用。直到（a）节点 sysctl 设置为 `vm.unprivileged_userfaultfd=1`，或（b）`virt-launcher` 计算容器被授予 `CAP_SYS_PTRACE`，`allowPostCopy=true` 在 KubeVirt 的 API 表面上结构上被接受，但 CRD 文档中的后复制切换在此构建上不生效。

实际上，这意味着选项 1（在迁移中暂停）和选项 2（缩短完成超时以快速失败并重试）是今天可行的杠杆；选项 3 的 MigrationPolicy 选择机制仍然适用于非后复制的可调参数（`allowAutoConverge`、`bandwidthPerMigration`、`completionTimeoutPerGiB`）。

## 诊断步骤

检查 HCO 单例上当前的集群范围实时迁移策略——这里的值默认适用于集群上的每次迁移：

```bash
kubectl get hyperconverged -n kubevirt kubevirt-hyperconverged \
  -o jsonpath='{.spec.liveMigrationConfig}{"\n"}'
```

列出集群中每次迁移的跟踪对象。`VirtualMachineInstanceMigration` 生活在与其目标 VMI 相同的命名空间中；`.status.phase` 显示迁移生命周期，`.status.migrationState.sourcePod` 命名源 virt-launcher pod，记录迁移日志行：

```bash
kubectl get vmim -A
```

对于卡住的迁移，从源 virt-launcher 中提取每次迭代的进度 JSON，以查看工作负载是否受收敛限制。未收敛的迁移显示 `DirtyRate` 高于 `MemoryBandwidth`，且 `MemoryRemaining` 在迭代中保持平坦或波动：

```bash
kubectl logs -n <vmi-ns> <virt-launcher-source-pod> -c compute \
  | grep -E 'Migration info|Live migration stuck|Live migration abort'
```

读取控制器实际应用于正在进行的迁移的合并迁移配置。如果匹配了 `MigrationPolicy`，则在此处显示其覆盖；如果没有，则为 HCO 默认值：

```bash
kubectl get vmim -n <vmi-ns> <vmim-name> \
  -o jsonpath='{.status.migrationState.migrationConfiguration}{"\n"}'
kubectl get vmim -n <vmi-ns> <vmim-name> \
  -o jsonpath='migrationPolicy={.status.migrationState.migrationPolicyName}{"\n"}'
```

在启用 `allowPostCopy`（集群范围或通过 MigrationPolicy）后，检查下一次迁移的 `vmim.status.migrationState`，以查看 `mode: PostCopy`（成功）或上述 `failureReason`（此构建上的 userfaultfd 权限门）。当 `migrationPolicyName` 和 `migrationConfiguration.allowPostCopy: true` 同时出现在合并状态中时，表示 MigrationPolicy 正确应用，即使 QEMU 层随后拒绝了能力协商。

在重新发出新设置之前，取消任何正在进行的迁移——正在运行的迁移不会回溯到新的 `liveMigrationConfig` 值；在更改后创建的下一个 `VirtualMachineInstanceMigration` 是拾取这些值的迁移：

```bash
kubectl delete vmim -n <vmi-ns> <stuck-vmim-name>
```
