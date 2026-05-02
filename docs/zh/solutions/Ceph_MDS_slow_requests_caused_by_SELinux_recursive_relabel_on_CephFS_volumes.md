---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: 447145d0be434c4aa620e6e85b441ab4efd910cc14b4afeec419d45185584bec
---

## 问题

挂载 CephFS PersistentVolume 的 Pods 变为 Ready 的时间非常长，并且 ACP Ceph 存储堆栈中的 MDS 记录了 `setxattr` 在 `security.selinux` 上的 `slow request` 警告。MDS 的代表性条目如下：

```text
[WRN] slow request 30.308475 seconds old, received at 2022-10-08 11:24:01.491429:
client_request(client.898845:3819 setxattr #0x10001d1111d security.selinux ...
caller_uid=0, caller_gid=0{}) currently submit entry: journal_and_reply
```

与此同时，MON Pods 将此升级为集群健康警告：

```text
log_channel(cluster) log [WRN]: Health check failed:
1 MDSs report slow requests (MDS_SLOW_REQUEST)
```

受影响的 PVC 是一个 CephFS `ReadWriteMany` 卷，包含大量小文件。

## 根本原因

当 kubelet 将卷挂载到 Pod 中时，容器运行时会要求重新标记整个卷树以匹配 Pod 的 SELinux 上下文。对于包含数十万个文件的 CephFS 子卷，这意味着相应数量的 `setxattr(security.selinux, ...)` 系统调用，每个调用都会作为元数据日志操作落在 MDS 上。

由于 MDS 必须在回复之前记录每个 `setxattr`，递归重新标记会饱和 MDS 元数据 IOPS，并使其他客户端无法访问。长时间运行的 `setxattr` 调用会触发 `slow request` 阈值，一旦积累到足够多，MON 会将其提升为 `MDS_SLOW_REQUEST` 集群健康警告。CephFS 越热（文件多，挂载频繁），效果越明显。

## 解决方案

有两个杠杆。优先选择选项 1；选项 2 是当 Pod 拥有者无法承受任何重新标记成本时的缓解措施。

1. **将 Pod 安全上下文与卷匹配，以便 kubelet 跳过递归重新标记。**

   Kubernetes 尊重为广告 `seLinuxMount: true` 的 CSI 卷提供的 `SELinuxMountReadWriteOncePod` / `SELinuxChangePolicy` 机制。当卷已经标记为 Pod 的 `seLinuxOptions` 请求的类型时，kubelet 会使用正确的上下文挂载，而不遍历树。在 Pod 规格中：

   ```yaml
   apiVersion: v1
   kind: Pod
   spec:
     securityContext:
       seLinuxOptions:
         level: "s0:c123,c456"
         type: container_file_t
     containers:
       - name: app
         image: myapp:latest
         volumeMounts:
           - name: data
             mountPath: /data
   ```

   在 Pod（或其控制器模板）上设置稳定、明确的 SELinux 级别/类型，并确保 CephFS 子卷预先标记为相同类型。之后，kubelet 使用 `context=` 挂载卷，避免 `setxattr` 遍历。

2. **通过使用 `SELinuxRelabelPolicy: Recursive` 选择退出模式或在 CSI 级别使用 `context=` 挂载来禁用受影响 Pod 的递归重新标记。**

   对于 CephFS CSI，可以通过在 `CSIDriver` 对象上声明 `seLinuxMount: true` 并在 Pod 上固定一个稳定的标签来避免每个 PV 的重新标记。这是 CSI 驱动程序的集群范围属性；在编辑之前确认：

   ```bash
   kubectl get csidriver cephfs.csi.ceph.com -o yaml
   ```

   如果 CSI 驱动程序已经广告 `seLinuxMount: true` 并且 Pod 设置了 `seLinuxOptions`，则在后续挂载时不会发生重新标记。通过在 Pod 重启期间监视 MDS `setxattr` 计数来验证这一点。

作为最后的手段，对于无法提供明确 SELinux 上下文的遗留工作负载，将工作负载拆分到较小的子卷上，以便一次性重新标记成本受到限制。不要在节点操作系统上禁用 SELinux — 这会危及其他租户的隔离。

## 诊断步骤

确认慢请求是 SELinux `setxattr` 而不是其他 Ceph 元数据问题：

```bash
kubectl logs -n <ceph-namespace> <mds-pod> | grep -E "slow request|setxattr #.*security.selinux"
```

检查 MON 上的集群健康升级：

```bash
kubectl logs -n <ceph-namespace> <mon-pod> | grep MDS_SLOW_REQUEST
```

从已经挂载了问题子卷的 Pod 中计算文件数量（未受影响的读取者也可以）：

```bash
kubectl exec -n <ns> <reader-pod> -- sh -c 'find /data -xdev | wc -l'
```

如果该计数在数十万的高位，递归重新标记很可能是触发因素，以上解决步骤适用。将慢请求的峰值与 kubelet 报告的 Pod 启动时间相关联：

```bash
kubectl get events --sort-by=.lastTimestamp | grep -E "FailedMount|SlowMount|Started"
```

在应用修复后，重启一个消费者 Pod 并观察 MDS 日志 — `setxattr` 风暴不应再次出现。
