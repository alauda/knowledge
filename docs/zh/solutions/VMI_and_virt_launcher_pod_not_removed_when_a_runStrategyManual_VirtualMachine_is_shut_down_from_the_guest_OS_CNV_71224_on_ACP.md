---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500780
sourceSHA: 5f9ce52fb879e623a8c551389311d0ff20bde1a47040a7b9a02ad2b63d1e87cf
---

# 当从客户操作系统关闭 runStrategy:Manual 的虚拟机时，VMI 和 virt-launcher pod 未被移除 (CNV-71224) 在 ACP 上

## 问题

在通过 HCO 操作员安装 KubeVirt 的 Alauda 容器平台上（`kubevirt-hyperconverged-operator.v4.3.6` CSV，`kubevirts.kubevirt.io/kubevirt-kubevirt-hyperconverged` 报告 `observedKubeVirtVersion=v1.7.0-alauda.2`，virt-controller 镜像 `build-harbor.alauda.cn/3rdparty/kubevirt/virt-controller:v1.7.0-alauda.2`），配置为 `.spec.runStrategy: Manual` 的 `VirtualMachine` 是通过 `subresources.kubevirt.io/v1` 上的 `virtualmachines/start` 和 `virtualmachines/stop` 子资源启动和停止，而不是通过自动重启策略 — virt-controller 将显式操作记录为 `Starting VM due to start request and runStrategy: Manual`，并仅在调用 `/start` 子资源时创建 `VirtualMachineInstance`。

症状：当此类 `runStrategy: Manual` 虚拟机的客户操作系统从内部关闭时（例如通过在客户会话中运行 `poweroff`），`VirtualMachine` 对象正确报告 `STATUS=Stopped` / `READY=False`，但关联的 `VirtualMachineInstance` 未被删除，仍然保持 `PHASE=Succeeded`，而匹配的 `virt-launcher-<vmi>-<hash>` pod 也未被删除，仍然保持 `STATUS=Completed`。虚拟机报告的状态与其实际运行对象在同一时间点上不一致，正如上游错误 CNV-71224 所描述的那样：

```
NAME                AGE     STATUS    READY
vm-manual-demo   5m15s   Stopped   False

NAME                                    READY   STATUS      RESTARTS   AGE
virt-launcher-vm-manual-demo-6jxpk   0/3     Completed   0          4m7s

NAME                AGE    PHASE       IP         NODENAME          READY
vm-manual-demo   4m8s   Succeeded   10.0.2.2   192.168.136.179   False
```

## 根本原因

这是一个上游 KubeVirt 缺陷，跟踪为 CNV-71224：在 `.spec.runStrategy: Manual` 下，当客户自身发起关闭时（而不是外部的 `stop` 子资源调用），virt-controller 将 `VirtualMachineInstance` 转换为 `PHASE=Succeeded` 并发出 `Stopped: The VirtualMachineInstance was shut down` 事件，但随后并未删除 VMI。由于 `virt-launcher` pod 的 `metadata.ownerReferences[0]` 指向 VMI（`apiVersion: kubevirt.io/v1, kind: VirtualMachineInstance, controller: true, blockOwnerDeletion: true`），因此在 VMI 存在时，启动器 pod 无法被垃圾回收，因此它保持为 `Completed`。虚拟机级别的 `printableStatus` 是从缺少运行中的 VMI 中协调而来的，并正确报告 `Stopped`，这导致可见的状态不一致。

ACP 以未更改的代码路径发布此功能 — 集群上的 virt-controller 镜像是上游 KubeVirt 1.7.0 的 v1.7.0-alauda.2 重建，因此相同的协调路径适用，并且该行为在运行 `/sbin/poweroff` 的 CentOS 7.9 containerDisk 虚拟机中重现。在客户操作系统关闭后的 90 秒观察窗口内，VMI 保持在 `PHASE=Succeeded`，而 virt-launcher pod 保持在 `STATUS=Completed`；virt-controller 日志在 `Stopped` 事件和窗口结束之间没有该 VMI 的删除/垃圾回收/重启条目。手动运行策略在这里工作正常 — virt-controller 在其 VMI 成功后对手动虚拟机不采取任何操作，这是预期的“手动”语义；缺陷是缺少运行时对象的清理，而不是不必要的自动重启。

## 解决方案

集群内没有配置可以禁用客户关闭时的孤儿行为 — 修复必须在 KubeVirt virt-controller 代码中进行（CNV-71224）。在该修复包含在部署的 KubeVirt 构建之前，在客户发起的关闭后清理剩余的 `VirtualMachineInstance`，以便 `virt-launcher` pod 可以被垃圾回收，从而可以再次启动虚拟机。由于启动器 pod 具有 VMI 作为其控制器 `ownerReference`，因此删除 VMI 就足够了 — Kubernetes 垃圾回收将自动删除 pod：

```bash
kubectl -n <vm-namespace> delete vmi <vm-name>
```

在清理后要再次启动相同的 `runStrategy: Manual` 虚拟机，请发出启动子资源（虚拟机的正常手动生命周期入口点；在此构建中，启动端点接受对 `subresources.kubevirt.io/v1` 聚合 API 的 PUT 请求）：

```bash
# 通过 virtctl，当可用时：
virtctl start <vm-name> -n <vm-namespace>

# 或直接针对聚合 API：
curl -sk -X PUT -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}' \
  "https://<apiserver>/apis/subresources.kubevirt.io/v1/namespaces/<vm-namespace>/virtualmachines/<vm-name>/start"
```

当 CNV-71224 在未来的 KubeVirt 构建中解决时（在上游 KubeVirt 或在随更新的 ACP 虚拟化 CSV 发布的后续 `v1.7.0-alauda.*` 重建中），VMI 和 virt-launcher pod 将在客户发起的关闭时自动移除，手动 `delete vmi` 步骤将不再需要。

## 诊断步骤

确认 KubeVirt 构建和实际拥有此生命周期的 virt-controller 镜像。在 ACP 中，KubeVirt 位于 `kubevirt` 命名空间，CSV 名称为 `kubevirt-hyperconverged-operator.v4.3.*`：

```bash
kubectl get kubevirt -n kubevirt \
  -o jsonpath='{range .items[*]}{.metadata.name}{"  operatorVersion="}{.status.operatorVersion}{"  observed="}{.status.observedKubeVirtVersion}{"\n"}{end}'
kubectl get csv -n kubevirt | grep hyperconverged
kubectl get deployment -n kubevirt virt-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

确认虚拟机的有效运行策略。在 `.spec.runStrategy: Manual` 下，虚拟机应仅在响应显式的 `start` 子资源调用时启动，而不是自行启动；这就是导致关闭后孤儿存在而不是被自动重启回收的原因：

```bash
kubectl -n <vm-namespace> get vm <vm-name> \
  -o jsonpath='{"runStrategy="}{.spec.runStrategy}{"  status="}{.status.printableStatus}{"  ready="}{.status.ready}{"\n"}'
```

在客户从内部关闭后（例如通过在客户操作系统中运行 `poweroff` 或通过 qemu-guest-agent）检查症状三元组。虚拟机状态、VMI 阶段和 virt-launcher pod 状态是本文提到的三个诊断表面：

```bash
kubectl -n <vm-namespace> get vm <vm-name>
kubectl -n <vm-namespace> get vmi <vm-name>
kubectl -n <vm-namespace> get pod -l kubevirt.io=virt-launcher
```

重现显示虚拟机处于 `STATUS=Stopped READY=False`，VMI 仍然存在于 `PHASE=Succeeded`，并且 `.status.conditions` 中的 `Ready=False(reason=PodTerminating)`，启动器 pod 仍然存在于 `STATUS=Completed`。命名空间的 `kubectl get events` 流包含匹配的 `Normal Stopped The VirtualMachineInstance was shut down` 和 `Normal Deleted Signaled Deletion` 条目来自 VMI 控制器，尽管 VMI 对象仍然存在。

通过检查其 `ownerReferences` 确认启动器 pod 的持久性是 VMI 孤儿的结果（而不是独立的 pod-GC 问题） — pod 由 VMI 拥有，且 `controller: true`，因此在 VMI 存在时无法被垃圾回收：

```bash
kubectl -n <vm-namespace> get pod -l kubevirt.io=virt-launcher \
  -o jsonpath='{.items[0].metadata.ownerReferences}{"\n"}'
```

确认 virt-controller 没有尝试（并失败）某些清理，这将指向不同的问题。对于 CNV-71224，控制器的日志包含 VMI 的 `Stopped` / `Signaled Deletion` 条目，但没有后续的 `delete` / `garbage` / `restart` 操作 — 这些行的缺失是此构建的可观察特征：

```bash
kubectl logs -n kubevirt deployment/virt-controller --tail=500 \
  | grep <vm-name>
```

## 参考

- 上游缺陷跟踪器：CNV-71224 — 客户发起的关闭未在运行策略设置为手动时移除 VMI 和 virt-launcher pod。
