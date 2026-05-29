---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500742
sourceSHA: 0e4966dcb8e42cd99ded125dbfdee82b4d17e3499ba3190c67a132821bbaf10c
---

# 实时虚拟机存储迁移因 HyperConverged workloadUpdateMethods 为空而卡住待处理

## 问题

在安装了虚拟化操作员的 Alauda 容器平台 (Kubernetes 服务器 `v1.34.5-1`) 上 (KubeVirt 操作员 `v1.7.0-alauda.1-dirty`, HCO 操作员 `1.17.0`)，正在运行的虚拟机的实时存储迁移从未开始。`VirtualMachine` 和 `VirtualMachineInstance` 规格已被重写以引用新的 `PersistentVolumeClaim`，但正在运行的 VMI 继续使用旧的 PVC，并且没有为目标 VMI 出现 `VirtualMachineInstanceMigration` (VMIM)。

在该平台上，操作员将 `HyperConverged` CR `kubevirt-hyperconverged` 安装到命名空间 `kubevirt` 中，实时迁移原语为 `virtualmachineinstancemigrations.kubevirt.io/v1` (`spec.vmiName` 目标是要迁移的 VMI，VMIM 必须在 VMI 的命名空间中创建)。

## 根本原因

正在运行的 VM 的实时存储迁移依赖于 KubeVirt 的实时迁移机制，将正在运行的 VMI 从旧 PVC 过渡到新 PVC；没有 `VirtualMachineInstanceMigration` 对象，VMI 无法迁移，依赖于它的调度无法进行。

`HyperConverged` CR 暴露了 `spec.workloadUpdateStrategy.workloadUpdateMethods` — 一个 `[]string`，其文档成员为 `LiveMigrate` 和 `Evict`。CRD 描述逐字说明：*"空列表默认为不进行自动工作负载更新"*。HCO 操作员将 `spec.workloadUpdateStrategy` 从 `HyperConverged` CR 传播到底层的 `KubeVirt` CR，`virt-controller` 工作负载更新器监视 `KubeVirt.spec.workloadUpdateStrategy.workloadUpdateMethods` 以决定是否有权在工作负载形状变化时调度自动迁移（PVC 引用变化就是一个触发器）。

当 `HyperConverged` CR 上的 `workloadUpdateMethods` 设置为 `[]` 时，传播的 `KubeVirt` CR `spec.workloadUpdateStrategy` 最终没有 `workloadUpdateMethods` 键 — 空列表在传递过程中被丢弃。由于没有调度方法，工作负载更新器将 `status.outdatedVirtualMachineInstanceWorkloads` 保持在 `0`，并且从未为受影响的 VMI 创建 `VirtualMachineInstanceMigration`。由更高级别的迁移控制器所做的规格更改被记录，但没有触发实时迁移，迁移保持待处理状态。

## 诊断步骤

确认 `kubevirt` 命名空间中的 `HyperConverged` CR 可达：

```bash
kubectl get hyperconverged -A
```

检查 `HyperConverged` CR 的 `workloadUpdateStrategy`。空的 `workloadUpdateMethods` 列表是此问题的故障条件：

```bash
kubectl get hyperconverged kubevirt-hyperconverged -n kubevirt \
  -o jsonpath='{.spec.workloadUpdateStrategy}'
```

预期的故障输出（注意空列表）：

```text
{"batchEvictionInterval":"1m0s","batchEvictionSize":10,"workloadUpdateMethods":[]}
```

确认在 `KubeVirt` CR 上传播的值 — 这是 `virt-controller` 工作负载更新器实际读取的字段。当 `HyperConverged` 值为 `[]` 时，这里缺少 `workloadUpdateMethods` 键：

```bash
kubectl get kubevirt -n kubevirt \
  -o jsonpath='{.items[0].spec.workloadUpdateStrategy}'
```

确认在其命名空间中没有为受影响的 VMI 创建 `VirtualMachineInstanceMigration`：

```bash
kubectl get vmim -n <vmi-namespace>
```

第二个确认信号是，即使 VMI 引用的 PVC 被重写，工作负载更新器队列仍然为空 — `KubeVirt` CR 上的 `status.outdatedVirtualMachineInstanceWorkloads` 保持在 `0`：

```bash
kubectl get kubevirt -n kubevirt \
  -o jsonpath='{.items[0].status.outdatedVirtualMachineInstanceWorkloads}'
```

## 解决方案

修补 `HyperConverged` CR，将 `spec.workloadUpdateStrategy.workloadUpdateMethods` 设置为 `["LiveMigrate"]`。只要存在至少一种方法，传播的 `KubeVirt` CR 就会重新获得该字段，工作负载更新器将被授权调度自动迁移，并创建受阻迁移所需的 `VirtualMachineInstanceMigration` 对象：

```bash
kubectl patch hyperconverged kubevirt-hyperconverged -n kubevirt \
  --type merge \
  -p '{"spec":{"workloadUpdateStrategy":{"workloadUpdateMethods":["LiveMigrate"]}}}'
```

验证传播是否到达 `KubeVirt` CR — 该字段必须在这里重新出现，以便工作负载更新器采取行动：

```bash
kubectl get hyperconverged kubevirt-hyperconverged -n kubevirt \
  -o jsonpath='{.spec.workloadUpdateStrategy}'
kubectl get kubevirt -n kubevirt \
  -o jsonpath='{.items[0].spec.workloadUpdateStrategy}'
```

观察受阻 VMI 所在的命名空间 — `VirtualMachineInstanceMigration` 应该自动出现并进展为 `Pending` → `Scheduling` → `Running` → `Succeeded`。如果工作负载确实可以实时迁移（其 `VirtualMachineInstance` 报告 `status.conditions[type=LiveMigratable].status=True`），迁移将完成；如果它不可实时迁移，工作负载更新器将在 `LiveMigrate` 方法下跳过它：

```bash
kubectl get vmim -n <vmi-namespace> -w
```
