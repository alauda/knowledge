---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500163
sourceSHA: de7e67ba72b65d6e355cb30a9fcff2dfba6a2cf8a38231b0c7de26dadf3887c5
---

# 在 ACP 上移动 PV 和 PVC 之间的 StorageClass

## 问题

在 Alauda Container Platform（kube-apiserver v1.34.5；集群默认 StorageClass `topolvm-hdd`，供应者 `topolvm.cybozu.com`）上，现有的 PersistentVolumeClaim 或 PersistentVolume 不能通过编辑实时对象重新指向不同的 StorageClass。StorageClass 派生的配置在创建时就被固定在声明和绑定的卷中，并在对象的生命周期内保持不变。

## 根本原因

kube-apiserver 在声明绑定后强制执行 `PersistentVolumeClaim.spec` 的不可变性。尝试更改绑定 PVC 的 `spec.storageClassName` — 例如，使用 `kubectl patch` 将 `topolvm-hdd` 替换为其他类 — 会被拒绝，并返回字面验证错误 `spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims`。验证器允许在绑定声明上仍可编辑的字段仅包含 `resources.requests` 和 `volumeAttributesClassName`；`storageClassName` 不在该列表中。

在 PersistentVolume 方面，API 服务器并不阻止对 `PV.spec.storageClassName` 的写入 — 服务器端的干运行补丁返回对象为 `patched`，没有 Forbidden 响应。这种明显的可变性是误导性的：真实的 PV 不会通过更改标签来重新定位其数据。PV 的 `spec.csi` 块（驱动程序名称、`volumeHandle`、供应参数）和节点上的底层 LVM 卷仍然归 `topolvm.cybozu.com` 所有，该供应者最初创建了 PV。重新标记 PV 上的 StorageClass 并不会重新参数化或迁移卷；它仅仅是重写了标签。

## 解决方案

将“在 StorageClasses 之间移动”视为 *复制* 工作流，而不是就地编辑。针对目标 StorageClass 配置一个新的 PVC，将旧 PVC 和新 PVC 都挂载到一个辅助 Pod 中，并使用该 Pod 内的通用文件复制机制（例如 `rsync` 或 `tar`）将数据迁移到新的声明中；然后将应用工作负载指向新的 PVC，并退役旧的 PVC。原始 PVC 及其绑定的 PV 不会被就地重新指向，应该在复制验证后删除。

从静止的源进行复制。`rsync` / `tar` 在文件系统处于活动状态时进行遍历，因此如果拥有的工作负载在复制期间持续写入，目标可能会捕获到一个撕裂或不一致的状态 — 半写的文件，或相互不一致的文件（例如，一个数据库及其写前日志）。在开始复制之前，将消费工作负载缩放至零（或以其他方式停止写入/进入维护窗口），以确保源 PVC 处于静止状态；对于支持的有状态系统，拍摄应用一致的快照或使用应用程序自己的备份工具，而不是原始文件复制。在删除原始 PVC 之前验证复制的数据。

存在一些边缘情况，API 层不会拒绝更改 — 例如，直接编辑 `PV.spec.storageClassName` — 但这些编辑并不会迁移底层的供应卷，并且超出了在类之间移动存储的支持操作集。

在唯一的 StorageClass 为 `topolvm-hdd`（供应者 `topolvm.cybozu.com`，回收策略 `Delete`，卷绑定模式 `WaitForFirstConsumer`）的集群上，任何此类工作流的先决步骤是安装第二个 StorageClass 以进行迁移。在此 ACP 上调查的所有平台 PVC 都绑定到 `topolvm-hdd`；在管理员添加一个之前，“移动到不同 SC”的工作流没有目标类。

## 诊断步骤

在假设补丁是正确工具之前，确认绑定 PVC 的拒绝路径：

```bash
kubectl patch pvc <name> -n <ns> \
  --type merge \
  -p '{"spec":{"storageClassName":"<other-sc>"}}'
```

apiserver 回复 `The PersistentVolumeClaim "<name>" is invalid: spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims`。同样的入场规则适用于任何针对绑定 PVC 的 `.spec.storageClassName` 的更新动词；这里演示的形式是 `kubectl patch --type=merge`。

验证即使 API 接受的 `PV.spec.storageClassName` 编辑也不会作为真实移动持久化。服务器端的干运行是安全的探测：

```bash
kubectl patch pv <pv-name> \
  --type merge \
  -p '{"spec":{"storageClassName":"<other-sc>"}}' \
  --dry-run=server
```

干运行返回对象为 `patched`，没有 Forbidden 错误，但后续读取确认实时的 `spec.storageClassName` 仍然是原始值，绑定的 CSI 驱动程序和 `volumeHandle` 未更改：

```bash
kubectl get pv <pv-name> \
  -o jsonpath='{.spec.storageClassName}{"\n"}{.spec.csi.driver}{"\n"}{.spec.csi.volumeHandle}{"\n"}'
```

列举集群中可用的 StorageClasses 和已经绑定的 PVC，以规划复制工作流：

```bash
kubectl get storageclass
kubectl get pvc --all-namespaces \
  -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,SC:.spec.storageClassName,STATUS:.status.phase
```

当列表显示 `topolvm-hdd` 为唯一类时，首先安装目标 StorageClass；上述迁移工作流在第二个类存在之前没有目标类来配置新的 PVC。
