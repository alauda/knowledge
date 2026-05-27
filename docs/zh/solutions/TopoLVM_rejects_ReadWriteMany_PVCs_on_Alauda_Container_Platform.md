---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500179
sourceSHA: 7737b74e7a37011f4f895c15d1c4ef10f0896253f0fb74169f2419f79f45f12f
---

# TopoLVM 拒绝 Alauda 容器平台上的 ReadWriteMany PVC

## 问题

在 Alauda 容器平台 (Kubernetes v1.34.5) 上，一个 `PersistentVolumeClaim` 的 `spec.accessModes` 包含 `ReadWriteMany`，但针对 TopoLVM 支持的 `StorageClass` 从未绑定：外部供应者 sidecar 在 PVC 上显示 `ProvisioningFailed` 事件，而底层 CSI `CreateVolume` RPC 返回 `rpc error: code = InvalidArgument desc = unsupported access mode: MULTI_NODE_MULTI_WRITER`。该 PVC 永远处于 `Pending` 状态，任何引用它的工作负载无法调度，因为从未生成满足该声明的 `PersistentVolume`。

`PersistentVolumeClaim` 上的 `spec.accessModes` 是标准的 `core/v1` `[]string` 字段，CSI 供应者看到的线协议枚举由上游 CSI 规范固定：`ReadWriteMany` 在到达驱动程序之前被外部供应者转换为 `MULTI_NODE_MULTI_WRITER`，而不管驱动程序是否实现该模式。未实现该模式的驱动程序在 gRPC 边界拒绝请求，返回 `InvalidArgument`，这正是供应者未宣传 RWX 支持的信号。

## 根本原因

TopoLVM 是一个节点本地的 CSI 驱动程序：它所提供的每个 `PersistentVolume` 都是从一个特定工作节点上的 LVM 卷组中切割出来的，且每个卷的状态由绑定到该节点的 `LogicalVolume` 自定义资源 (`logicalvolumes.topolvm.cybozu.com`) 跟踪。CSIDriver 宣传拓扑键 `topology.topolvm.cybozu.com/node`，集群中的每个 `CSINode` 条目注册了一个与其自身节点身份相等的 TopoLVM 节点 ID——没有跨节点的卷组，没有共享的后端存储，也没有路径可以让单个 LV 从多个节点同时以读写方式挂载。这种拓扑使得该驱动程序在结构上无法实现多节点访问模式 `ReadWriteMany` 和 `ReadOnlyMany`。

## 解决方案

仅在针对 TopoLVM `StorageClass` 的 PVC 上使用单节点访问模式：`ReadWriteOnce` 或 `ReadWriteOncePod`。这些是驱动程序在供应时接受的唯一值；任何列出 `ReadWriteMany`（或 `ReadOnlyMany`）的 PVC 清单必须在声明绑定之前重写为单节点模式之一。

在 Alauda 容器平台上，默认的 TopoLVM `StorageClass` 以 `topolvm-hdd` 形式提供，供应者为 `topolvm.cybozu.com`，参数为 `csi.storage.k8s.io/fstype=xfs,topolvm.cybozu.com/device-class=hdd`——这是 PVC 清单中要针对的 SC 名称和供应者字符串。驱动程序将接受的最小 PVC 如下所示：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
  namespace: my-app
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: topolvm-hdd
  resources:
    requests:
      storage: 10Gi
```

如果工作负载确实需要来自不同节点的多个 pod 的共享读写访问，TopoLVM 不是合适的后端——该需求必须由网络共享文件系统供应者满足，而不是通过切换节点本地驱动程序的访问模式来实现。

在 Alauda 容器平台上，TopoLVM CSIDriver 对象以上游 cybozu 名称 `topolvm.cybozu.com` 注册（而不是 `topolvm.io`），并携带 `fsGroupPolicy: ReadWriteOnceWithFSType`，`attachRequired: false`（驱动程序在节点本地挂载，没有外部附加器在路径中），以及 `volumeLifecycleModes: [Persistent, Ephemeral]`。`ReadWriteOnceWithFSType` 策略意味着 kubelet 仅在设置了文件系统类型且卷以 `ReadWriteOnce` 挂载时，将 pod 的 `fsGroup` 应用到卷——这与驱动程序支持的单节点、文件系统模式使用模式一致。

## 诊断步骤

在重新调整任何 PVC 之前，确认 TopoLVM 驱动程序及其 `StorageClass` 仅宣传单节点语义。直接检查 CSIDriver 的文件系统组策略和 SC 的参数——`fsGroupPolicy` 行和 `Parameters` 行一起显示该驱动程序是以 cybozu 名称注册的上游 TopoLVM 驱动程序，并且 SC 绑定到节点本地卷组上的一个设备类：

```bash
kubectl describe csidriver topolvm.cybozu.com | grep -i policy
kubectl describe sc topolvm-hdd | grep -e Annotations -e Parameters
```

预期输出格式：

```text
Fs Group Policy:    ReadWriteOnceWithFSType
Parameters:         csi.storage.k8s.io/fstype=xfs,topolvm.cybozu.com/device-class=hdd
```

当 PVC 已经卡在 `Pending` 状态时，`kubectl describe pvc <name>` 会显示 `ProvisioningFailed` 事件，消息中包含 `MULTI_NODE_MULTI_WRITER` 拒绝文本，这是请求的访问模式与驱动程序不兼容的明确信号，PVC 清单——而不是驱动程序或 SC——需要更改。
