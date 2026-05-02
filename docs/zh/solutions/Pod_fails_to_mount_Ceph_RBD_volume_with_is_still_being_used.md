---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500009
sourceSHA: 7ccc603ceb2106cb239ce676aeab96a395d6589dd7ea61006528af0630ad5a04
---

# Pod 无法挂载 Ceph RBD 卷，提示 "is still being used"

## 问题

一个由 ReadWriteOnce Ceph RBD PVC 支持的 pod 启动失败。kubelet 报告：

```text
MountVolume.MountDevice failed for volume "pvc-xxxxxxxx":
rpc error: code = Internal desc = rbd image
<pool>/csi-vol-<uuid> is still being used
```

受影响的 RBD 镜像在当前节点的 `lsblk` 中不可见——它没有被本地挂载。在同一工作节点的 Ceph RBD CSI 节点插件中：

```text
GRPC error: rpc error: code = Internal desc =
rbd image <pool>/csi-vol-<uuid> is still being used
```

通常，这种情况发生在中断之后——网络分区、节点硬重启或非控制的分离——原始消费者没有干净地释放镜像。附加侧的一个伴随症状是：

```text
Warning  FailedAttachVolume  attachdetach-controller
Multi-Attach error for volume "pvc-..." — Volume is already
exclusively attached to one node and can't be attached to another
```

## 根本原因

对于 ReadWriteOnce RBD PVC，有两个协作机制保证单写语义：

1. **Ceph RBD `exclusive-lock` 镜像特性。** RBD 镜像是使用 `exclusive-lock` 创建的（以及依赖于它的 `object-map` / `fast-diff`）。锁由映射镜像的内核或用户空间客户端持有。在锁被持有期间，其他客户端无法以写入方式打开该镜像。
2. **Kubernetes `VolumeAttachment`。** 附加-分离控制器通过 `VolumeAttachment` 对象记录哪个节点“拥有” PV。在该对象被删除之前，调度器/CSI 拒绝在其他地方附加 PV。

在中断之后，这两个机制中的一个或两个可能会留下过时的记录：

- 旧节点在其 CSI 节点插件能够释放锁之前就消失了，因此 RBD 镜像仍然有一个指向死节点 IP 的观察者 / 独占锁条目。
- `VolumeAttachment` 仍然引用死节点，因为没有 kubelet 在那里活着以完成分离流程。

任何过时的记录都会产生 "still being used" 错误——RBD 镜像通过一个活跃的观察者报告 `is still being used`，而 Kubernetes 层拒绝多重附加。

## 解决方案

ACP 通过 Rook 在 `rook-ceph` 命名空间中运行 Ceph。工具箱 pod (`deploy/rook-ceph-tools`) 是调用 `rbd` 命令的标准位置；RBD CSI 组件与其并存（`rook-ceph.rbd.csi.ceph.com-ctrlplugin` 部署加上 `rook-ceph.rbd.csi.ceph.com-nodeplugin` DaemonSet，容器名称在两者中均为 `csi-rbdplugin`）。

在接触 Ceph 之前，排除合法情况：镜像确实仍然在某处附加。如果旧消费者仍在运行并写入，强行移除锁将导致数据损坏或文件系统不一致。仅在确认以下情况后再继续：

- 没有 pod 使用该 PVC 被调度到任何地方（控制器缩放到 0，或所有副本可验证地终止），
- 在任何节点上不存在 RBD 镜像的挂载（每个候选节点的 `lsblk` 显示该镜像没有 `/dev/rbd*`），
- 之前拥有 `VolumeAttachment` 的节点已消失或重启，无法与你竞争。

对于更安全的 Kubernetes 优先方法，优先选择兄弟工作流——"RWO RBD PVC 无法挂载，出现 Multi-Attach 错误"——通过仅删除过时的 `VolumeAttachment` 解决大多数情况：

```bash
kubectl get volumeattachment | grep <pv-name>
kubectl delete volumeattachment <va-name>
```

在许多恢复场景中，删除过时的 `VolumeAttachment` 就足够了：附加-分离控制器随后在正确的节点上发出新的附加请求，CSI 插件会协调锁。

如果在 `VolumeAttachment` 消失后，RBD 镜像上的锁仍然存在（该镜像未在任何地方映射且没有 pod 正在运行），则直接清除锁。在 Ceph 工具箱中打开一个 shell：

```bash
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash
```

在工具箱内，检查并移除过时的锁：

```bash
# 显示当前的观察者 / 锁定者：
rbd status   <pool>/csi-vol-<uuid>

# 确认它未在任何运行的客户端上映射：
rbd showmapped

# 列出锁：
rbd lock ls   <pool>/csi-vol-<uuid>
# 示例输出：
# There is 1 exclusive lock on this image.
# Locker        ID                     Address
# client.33448456  auto 18446462598732840967  10.130.4.1:0/481160532

# 移除它。用反斜杠转义锁 ID 中的空格。
rbd lock rm <pool>/csi-vol-<uuid> 'auto 18446462598732840967' client.33448456
```

注意：每个锁都是一个观察者，但并非每个观察者都是一个锁。移除锁会释放 RBD 镜像，以便合法的拥有者可以再次映射它。不要在客户端正在写入时移除锁。

在锁被清除后，重启 pod。CSI 节点插件将在当前节点上重新映射该镜像并挂载文件系统。

## 诊断步骤

识别 PV 和底层 RBD 镜像：

```bash
kubectl get pvc -n <ns> <pvc-name> -o jsonpath='{.spec.volumeName}{"\n"}'
kubectl get pv <pv-name> -o yaml | grep -E "clusterID|pool|imageName|imageFeatures"
```

检查当前 `VolumeAttachment` 状态：

```bash
kubectl get volumeattachment | grep <pv-name>
```

检查调度 pod 的节点上的 CSI 节点插件日志。插件 DaemonSet 在每个节点上使用一个 pod；选择在目标节点上运行的那个：

```bash
NODE=<node-name>
kubectl -n rook-ceph get pod \
  -l app=rook-ceph.rbd.csi.ceph.com-nodeplugin -o wide | grep "$NODE"
kubectl -n rook-ceph logs <csi-rbdplugin-pod-on-node> -c csi-rbdplugin | tail -200
```

从 Ceph 工具箱中，在干预之前验证该镜像实际上未在任何地方映射：

```bash
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash -c '
  rbd status <pool>/csi-vol-<uuid>
  rbd showmapped
  rbd lock ls <pool>/csi-vol-<uuid>
'
```

如果 `rbd status` 列出一个观察者，其地址与仍然存活的节点匹配，请停止并在 Kubernetes 层进行协调，而不是强行移除锁。
