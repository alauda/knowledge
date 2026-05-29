---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500769
sourceSHA: 945734beba475470f683e771ee6299656e6763dd3d079f2bc606a961e7c0d166
---

# VolumeSnapshotContent 删除卡住，原因是缺少 CSI 删除密钥注释

## 问题

在安装了快照模块插件的 Alauda Container Platform（Kubernetes 服务器 `v1.34.5-1`）上，由第三方备份工具创建的大量 `VolumeSnapshot` 和 `VolumeSnapshotContent` 对象可能会在删除状态下卡住，当后端 CSI 驱动程序需要一个密钥来对后端存储阵列进行 `DeleteSnapshot` 身份验证时。在集群中，快照模块插件提供了 `snapshot.storage.k8s.io/v1` 下的 `volumesnapshots`、`volumesnapshotcontents` 和 `volumesnapshotclasses` CRD，并在 `cpaas-system` 命名空间中以 `Deployment` 形式运行上游的 `snapshot-controller`（镜像 `snapshot-controller:v8.5.0-bea122af`）。

## 根本原因

`snapshot-controller` 是通过 `csi-snapshotter` 边车驱动对 CSI 驱动程序执行 `DeleteSnapshot` 的组件。要在需要身份验证的后端存储阵列上删除快照，边车必须知道哪个 `Secret` 包含凭据，它通过每个 `VolumeSnapshotContent` 的注释来获取这些信息。当通过控制器创建 `VolumeSnapshot` 时，如果其 `VolumeSnapshotClass` 的 `.parameters` 声明了 `csi.storage.k8s.io/snapshotter-secret-name` 和 `csi.storage.k8s.io/snapshotter-secret-namespace`，这些值会被控制器传播到动态提供的 `VolumeSnapshotContent` 上，作为 `snapshot.storage.kubernetes.io/deletion-secret-name` 和 `snapshot.storage.kubernetes.io/deletion-secret-namespace` 注释。

当第三方应用程序直接针对 API 创建静态 `VolumeSnapshotContent` 对象并绕过控制器的动态提供路径时，删除密钥注释不会自动注入。每个动态提供的 `VolumeSnapshotContent` 都携带 `snapshot.storage.kubernetes.io/volumesnapshotcontent-bound-protection` 终结符，该终结符由 `snapshot-controller` 放置在其上；该终结符在 API 中保持对象，直到 `DeleteSnapshot` 成功。在删除后备的 `VolumeSnapshot` 时，控制器会在 `VolumeSnapshotContent` 上印上注释 `snapshot.storage.kubernetes.io/volumesnapshot-being-deleted: "yes"`，然后尝试 CSI `DeleteSnapshot`。如果缺少删除密钥注释，CSI 驱动程序将没有凭据来对后端阵列进行身份验证，`DeleteSnapshot` 失败，控制器重试——`bound-protection` 终结符保持对象存在，循环重复。

## 诊断步骤

确认集群中存在快照 CRD 和控制器——这些由快照模块插件提供，控制器的 `Deployment` 位于 `cpaas-system`：

```bash
kubectl get crd volumesnapshotcontents.snapshot.storage.k8s.io \
  volumesnapshots.snapshot.storage.k8s.io \
  volumesnapshotclasses.snapshot.storage.k8s.io
kubectl -n cpaas-system get deploy snapshot-controller
```

通过将删除信号与 `metadata.annotations` 下缺少的密钥注释结合来识别卡住的 `VolumeSnapshotContent`。一个卡住的对象携带设置的 `metadata.deletionTimestamp` 和控制器应用的 `snapshot.storage.kubernetes.io/volumesnapshot-being-deleted: "yes"` 注释，但缺少 `snapshot.storage.kubernetes.io/deletion-secret-name` 和 `snapshot.storage.kubernetes.io/deletion-secret-namespace`；`snapshot.storage.kubernetes.io/volumesnapshotcontent-bound-protection` 终结符仍列在 `metadata.finalizers` 下，这就是保持对象在 API 中的原因：

```bash
kubectl get volumesnapshotcontent <name> -o yaml
```

卡住对象的预期元数据形状如下（仅显示承载字段）：

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotContent
metadata:
  name: <name>
  deletionTimestamp: "<timestamp>"
  finalizers:
  - snapshot.storage.kubernetes.io/volumesnapshotcontent-bound-protection
  annotations:
    snapshot.storage.kubernetes.io/volumesnapshot-being-deleted: "yes"
    # deletion-secret-name / deletion-secret-namespace 缺失
```

## 解决方案

持久的修复方法是创建静态 `VolumeSnapshotContent` 对象的第三方调度器在创建时填充每个对象的 `snapshot.storage.kubernetes.io/deletion-secret-name` 和 `snapshot.storage.kubernetes.io/deletion-secret-namespace` 注释，以匹配后备 CSI 驱动程序所期望的密钥。

在此期间，为了解决现有的卡住对象，手动为每个待处理的 `VolumeSnapshotContent` 添加删除密钥坐标注释，以便 CSI 驱动程序可以在下次重试时对后端进行身份验证。首先识别驱动程序所期望的密钥——它在 `VolumeSnapshotClass` 的 `.parameters` 下配置为 `csi.storage.k8s.io/snapshotter-secret-name` 和 `csi.storage.k8s.io/snapshotter-secret-namespace`：

```bash
kubectl get volumesnapshotclass <class-name> -o yaml
```

然后将匹配的删除密钥注释应用于单个卡住的 `VolumeSnapshotContent` 以验证路径，然后再进行扩展：

```bash
kubectl annotate volumesnapshotcontent <name> \
  snapshot.storage.kubernetes.io/deletion-secret-name=<secret-name> \
  snapshot.storage.kubernetes.io/deletion-secret-namespace=<secret-namespace> \
  --overwrite
```

之后观察相同的 `VolumeSnapshotContent`——一旦 `snapshot-controller` 重新驱动 `DeleteSnapshot` 并提供凭据，CSI 删除成功，控制器清除 `bound-protection` 终结符，对象被移除：

```bash
kubectl get volumesnapshotcontent <name>
```
