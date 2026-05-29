---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500542
sourceSHA: 0d2979cf81572657d8f2b8079f511429168dd9d75b00698e414d587b412c4de1
---

# 在 ACP 上，集群管理员的第三方服务帐户删除 VirtualMachineInstance CRD 后，所有 KubeVirt 虚拟机同时关闭电源

## 问题

在 Alauda 容器平台上，KubeVirt 通过 `kubevirt-operator` OperatorBundle 安装。控制平面在 `kubevirt` 命名空间中运行，由 `virt-operator` (2/2)、`virt-api` (1/1)、`virt-controller` (1/1) 和每个节点的 `virt-handler` DaemonSet（每个 Linux 节点一个 Pod）组成，所有组件都由 OLM CSV `kubevirt-hyperconverged-operator.v4.3.5` 打包，并报告 `observedKubeVirtVersion=v1.7.0-alauda.2`。`virtualmachineinstances.kubevirt.io` CRD 在 `apiextensions.k8s.io/v1` 下以集群范围注册，`group=kubevirt.io`，`plural=virtualmachineinstances`，`shortNames=[vmi,vmis]`，`scope=Namespaced`，并带有标签 `app.kubernetes.io/managed-by=virt-operator` 以及注释 `kubevirt.io/install-strategy-version=v1.7.0-alauda.2` — `virt-operator` 拥有并协调此 CRD。

报告的症状是：集群中每个运行的 KubeVirt 管理的虚拟机同时关闭电源。在每个受影响的节点上，`virt-handler`（镜像 `build-harbor.alauda.cn/3rdparty/kubevirt/virt-handler:v1.7.0-alauda.2`）驱动其管理的虚拟机的底层 QEMU 进程的优雅关闭，并等待最多 `--graceful-shutdown-seconds=315`，同时 QEMU 发送 ACPI 电源按钮事件，SIGTERM 传播到客户机进程。在拆卸窗口期间，`virt-handler` 发出结构化 JSON 日志行，遵循上游信封 `{component, level, msg, pos, timestamp}`（例如，一个以每个虚拟机拆卸路径为键的 `"Signaled graceful shutdown"` 形状消息）。

## 根本原因

KubeVirt 控制平面根据集群范围的 `virtualmachineinstances.kubevirt.io` CRD 协调虚拟机；当该 CRD 对象从 `apiextensions.k8s.io/v1` 中删除时，集群不再接受 VMI 实例，并且每个虚拟机的拆卸路径在每个节点上运行 — 产生同时关闭电源的模式。

VMI CRD 的删除可以被绑定到上游 `cluster-admin` ClusterRole 的任何主体访问，其规则是 RBAC 通配符 `{apiGroups:[*], resources:[*], verbs:[*]}`，因此授予对每个集群范围资源（包括 CRD）的删除权限。在观察到的场景中，一个第三方自动化/备份服务帐户已绑定到 `cluster-admin`，并利用该授权在其工作流程中删除 VMI CRD。拥有此 CRD 的合法主体是 `virt-operator` 服务帐户（`system:serviceaccount:kubevirt:kubevirt-operator`），绑定的 ClusterRole 授予在 `apiextensions.k8s.io/customresourcedefinitions` 上的 `[get,list,watch,create,delete,patch]` 权限；因此，任何其他作为 CRD 重新创建的 `create` 主体的服务帐户都是超出范围的。

## 解决方案

恢复 `virtualmachineinstances.kubevirt.io` CRD，以便在删除之前运行的虚拟机可以再次协调。`virt-operator`（镜像 `build-harbor.alauda.cn/3rdparty/kubevirt/virt-operator:v1.7.0-alauda.2`）拥有该 CRD，并在缺失时将其重新协调；推荐的路径是让 `virt-operator` 重新创建它，而不是超出范围地重新应用 CRD 对象，这样可以避免在审计记录中留下重新创建时的 `creationTimestamp` 和非操作主体。

通过使用 `kubectl` 列出确认 CRD 已恢复：

```bash
kubectl get crd | grep virtualmachineinstance
kubectl get crd virtualmachineinstances.kubevirt.io -o yaml
```

恢复的 CRD 应携带 `group=kubevirt.io`，`plural=virtualmachineinstances`，`shortNames=[vmi,vmis]`，`scope=Namespaced`，标签 `app.kubernetes.io/managed-by=virt-operator`，以及注释 `kubevirt.io/install-strategy-version=v1.7.0-alauda.2`。一旦存在，删除之前运行的虚拟机将自动重启，服务将恢复。

撤销第三方自动化/备份服务帐户与 `cluster-admin` 的绑定，并将其重新绑定到不授予 `delete` 权限的最低权限角色，以避免在下一个工作流程运行中再次发生相同的故障。

## 诊断步骤

检查恢复的 CRD 对象的 `generation` 和 `creationTimestamp` 以确认是否发生了删除/重新创建事件。其特征是 `generation: 1`，`creationTimestamp` 与重新创建时刻匹配，而不是原始集群安装时间（该集群的实时安装时间戳为 `2026-05-13T05:21:49Z`）：

```bash
kubectl get crd virtualmachineinstances.kubevirt.io \
  -o jsonpath='{.metadata.generation}{"\t"}{.metadata.creationTimestamp}{"\n"}'
```

在故障窗口期间从 `kubevirt` 命名空间中提取 `virt-handler` 日志。`virt-handler` 发出结构化 JSON 的上游信封 `{component, level, msg, pos, timestamp}`；每个正在拆卸的 VMI 的优雅关闭信号出现在此流中：

```bash
kubectl -n kubevirt logs ds/virt-handler --since=1h
```

确认第三方自动化/备份服务帐户是否绑定到 `cluster-admin`，因此具有删除 VMI CRD 所需的权限。使用上游的 `kubectl auth can-i` 探测器，带上 `--as` 模拟评估绑定，而不触及实时 CRD：

```bash
kubectl auth can-i delete crd \
  --as=system:serviceaccount:<ns>:<sa>
kubectl get clusterrolebinding -o json \
  | jq '.items[] | select(.roleRef.name=="cluster-admin") | {name:.metadata.name, subjects:.subjects}'
```

通过读取 kube-apiserver 审计日志来归因于重新创建的主体。在 ACP 上，审计日志文件位于每个控制平面主机的 `/etc/kubernetes/audit/audit.log`；通过在控制平面主机上打开一个 shell（或附加到一个挂载主机文件系统的调试 Pod）并直接读取文件，然后过滤 CRD 路径：

```bash
ssh <user>@<control-plane-host>
sudo grep '"resource":"customresourcedefinitions"' /etc/kubernetes/audit/audit.log \
  | grep 'virtualmachineinstances.kubevirt.io'
```

每个匹配记录都是一个 `audit.k8s.io/v1` 事件，包含 `user.username`、`verb`、`objectRef.resource`、`requestURI` 和 `responseStatus.code` 字段。任何 `user.username` 不是 `system:serviceaccount:kubevirt:kubevirt-operator` 的 `create` 事件表明 CRD 是由非 `virt-operator` 的主体重新创建的 — 通常是最初删除它的同一超出范围的参与者。
