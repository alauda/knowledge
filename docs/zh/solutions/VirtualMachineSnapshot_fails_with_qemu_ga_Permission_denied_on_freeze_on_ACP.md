---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500665
sourceSHA: d9ea2e9d3e6dffe8c27348a0f1434680041b9adc02a9d510529927bf3f70b86e
---

# 在 ACP 上，VirtualMachineSnapshot 在冻结时因 qemu-ga 权限被拒绝而失败

## 问题

在安装了虚拟化（KubeVirt）功能的 Alauda 容器平台上，对正在运行的 VirtualMachineInstance 进行 `VirtualMachineSnapshot` 时，会请求内部的 QEMU 客户端代理通过 `guest-fsfreeze-freeze` 来冻结客户机文件系统，然后再捕获底层磁盘快照。当快照在一致模式下成功时，生成的 `VirtualMachineSnapshot` 会在 `status.sourceIndications` 中记录这一事实，指示为 `GuestAgent`，并附带消息 "Guest agent was active and attempted to quiesce the filesystem for application consistency"，同时还有一个明确指出一致性依赖于客户机代理冻结的 `Online` 指示。

冻结步骤可能因特定原因而失败：虚拟机内部的客户机代理进程无法打开它被要求冻结的某个挂载点。当发生这种情况时，`virt-handler`（每个节点的 KubeVirt 代理，向托管 VMI 的节点上的 libvirt/QEMU 发出冻结调用）会在其生命周期路径上记录失败，消息文本为 `Failed to freeze VMI`，并且 `reason` 字段携带 libvirt 错误字符串，包括子字符串 `command Freeze failed` 和后缀 `guest-fsfreeze-freeze ... Permission denied` 来自 QEMU 代理。`virt-controller`，KubeVirt 控制平面组件，负责协调冻结，会在任何冻结调用周围发出一对匹配的日志行——当调用开始时为 `Freeze VMI <name>`，返回时为 `Freezing vmi <name> took <duration>`，并将失败显示为标准的 "unexpected return code 400 (400 Bad Request)" 包裹在 libvirt 错误周围。

相同的失败文本也会出现在 `VirtualMachineSnapshot` CR 本身上：该集群上的 `snapshot.kubevirt.io/v1beta1` `VirtualMachineSnapshot` API 带有一个 `status.error` 对象，包含 `message` 和 `time` 字段，描述为 "在快照/恢复过程中遇到的最后一个错误"，其中 `command Freeze failed ... Permission denied` 文本被传播给最终用户，通过 `kubectl get vmsnapshot <name> -o yaml` 读取。

## 根本原因

冻结调用失败是因为运行在虚拟机内部的 QEMU 客户机代理 `/usr/bin/qemu-ga` 无法打开它被要求冻结的目录。在使用 SELinux 限制 `qemu-ga` 的客户操作系统上，代理在 `virt_qemu_ga_t` 域中运行，只允许访问其允许列表上的文件。刚在新挂载的文件系统上创建的目录通常没有 SELinux 标签，并在 `ls -lZd` 下显示为 `system_u:object_r:unlabeled_t:s0`；该类型不在 `virt_qemu_ga_t` 的允许列表中，因此内核拒绝打开，代理向 libvirt 返回 `Permission denied`，然后 `virt-handler` 将其显示为平台侧的 `Failed to freeze VMI` 日志行。

拒绝是纯粹的客户机内部 SELinux 策略决策——它不依赖于运行 KubeVirt 的平台。任何其他 KubeVirt 发行版上遇到此失败的相同虚拟机镜像在 ACP 上也会以相同方式遇到此问题，修复也完全在客户操作系统中：重新标记路径或授予 `virt_qemu_ga_t` 所需的访问权限。所有的补救措施都不涉及更改集群控制平面或 `kubevirt` 命名空间中的任何内容。

## 解决方案

补救措施在虚拟机的客户操作系统内部运行，而不是在 ACP 控制平面上——失败通过 `VirtualMachineSnapshot` CR 上的相同 `status.error.message` 在平台上显现，传播任何冻结失败。有两条路径可供选择；选项 A 是覆盖大多数情况的广泛修复，选项 B 是针对特定路径的手术修复。

**选项 A — 广泛修复（推荐）：** 允许受限的 `qemu-ga` 读取 SELinux `non_security_file_type` 属性上类型的文件（包括由新 `mkfs` 创建的 `unlabeled_t` 目录），通过在客户机内部启用相应的 SELinux 布尔值。这需要在重启后保持持久：

```bash
# 在虚拟机内部，以 root 身份
setsebool -P virt_qemu_ga_read_nonsecurity_files 1
```

启用布尔值后，重新触发快照。对同一 VMI 进行的 `VirtualMachineSnapshot` 预计将以 `status.phase: Succeeded` 完成，并且 `status.sourceIndications` 记录 `GuestAgent` 冻结指示和 `Online` 指示，集群以相同方式显示健康的客户机冻结快照。

**选项 B — 手术修复：** 保持 SELinux 限制严格，并明确允许 `virt_qemu_ga_t` 仅访问一个特定目标类型。根据审计拒绝生成自定义策略模块，构建并在客户机内部加载：

```bash
# 在虚拟机内部，以 root 身份
grep AVC /var/log/audit/audit.log | grep <target-path> \
  | audit2allow -M qemu-ga-<target-name>
semodule -i qemu-ga-<target-name>.pp
```

如果根本问题是特定路径上缺失或错误的标签，而不是缺失的允许规则，首先将路径重新标记为其默认 SELinux 上下文；`restorecon` 可以就地完成此操作：

```bash
# 在虚拟机内部，以 root 身份
restorecon -Rv /<affected-path>
```

在任一修复后，从 ACP 侧重新运行快照，并验证快照达到 `status.phase: Succeeded`，而不是携带包含 `command Freeze failed ... Permission denied` 的 `status.error.message`。

## 诊断步骤

在应用任何客户机内部修复之前，确认失败路径的端到端；快照 CR 是规范的入口点，因为冻结错误会落在其 `status.error` 对象上。

首先检查失败的 `VirtualMachineSnapshot` 对象；冻结错误作为结构化的 `status.error{message,time}` 对象传播到其上，并且 `status.sourceIndications` 不会显示健康快照所显示的 `GuestAgent` 冻结指示：

```bash
kubectl get vmsnapshot -n <namespace> <snapshot-name> -o yaml
```

通过在 `kubevirt` 命名空间中 grep `virt-handler` DaemonSet 日志中的 `Failed to freeze VMI` 行进行交叉检查——`virt-handler` 每个节点运行一个 pod，因此针对当前托管受影响 VMI 的节点的 pod。该日志行上的 `reason` 字段携带逐字的 libvirt 错误，包括指向客户机内部拒绝的 `guest-fsfreeze-freeze ... Permission denied` 子字符串：

```bash
kubectl logs -n kubevirt -l kubevirt.io=virt-handler \
  --all-containers --tail=2000 \
  | grep -E 'Failed to freeze VMI|guest-fsfreeze-freeze|Permission denied'
```

还要确认同一命名空间中 `virt-controller` 的匹配控制平面视图；对于对给定 VMI 的任何冻结尝试，它会发出 `Freeze VMI <name>` 日志行，返回时发出 `Freezing vmi <name> took <duration>` 行，并将底层失败显示为 "unexpected return code 400 (400 Bad Request)"：

```bash
kubectl logs -n kubevirt -l kubevirt.io=virt-controller \
  --tail=2000 \
  | grep -E 'Freeze VMI|Freezing vmi|return code 400'
```

在客户机内部应用修复后，重新创建快照并确认 `status.phase: Succeeded`，同时 `GuestAgent` 指示出现在 `status.sourceIndications` 下——这一对确认客户机代理可达，并且文件系统已为应用一致性冻结，而不是在未冻结的情况下进行快照。
