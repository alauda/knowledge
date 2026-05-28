---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500376
sourceSHA: 571a16e6b626deb1ca33d341dc9fee887c47189f83e7d8592cb74b574bb7aacc
---

# 在 ACP 上更改 StorageClass 的 fsType — 删除并重新创建操作步骤

## 问题

在 Alauda Container Platform (Kubernetes v1.34.5) 中，默认集群 StorageClass 是 `topolvm-hdd`（provisioner `topolvm.cybozu.com`，`parameters."csi.storage.k8s.io/fstype": xfs`）。管理员有时需要在新创建的 PersistentVolumes 上使用不同的文件系统——例如，将 `csi.storage.k8s.io/fstype` 的值从 `xfs` 切换到 CSI 驱动程序支持的其他值。直接在现有 StorageClass 上进行就地编辑是无效的：`storage.k8s.io/v1` 的准入控制拒绝对现有 StorageClass 对象的 `parameters`、`provisioner`、`reclaimPolicy` 和 `volumeBindingMode` 的更新，apiserver 在尝试补丁时返回 `parameters: Forbidden: updates to parameters are forbidden`。

## 根本原因

`storage.k8s.io/v1` StorageClass 策略在创建后将 provisioner 相关字段视为不可变。对 `topolvm-hdd.parameters` 进行的服务器端干运行补丁在策略级别的准入控制中失败，返回 `parameters: Forbidden: updates to parameters are forbidden`；同样的准入规则适用于 `provisioner` 和 `reclaimPolicy`（均被拒绝为 `Forbidden`）以及 `volumeBindingMode`（被拒绝为 `field is immutable`）。由于对 `parameters` 的更新是被禁止的，因此获取新的 `fsType` 值的唯一途径是删除现有的 StorageClass 对象并使用所需的参数重新创建它。

## 解决方案

通过备份其 YAML，编辑备份中的参数，删除现有对象，并从编辑后的清单重新创建 StorageClass 来替换它。该操作步骤适用于用户创建的 StorageClasses；在 ACP 中，默认的 `topolvm-hdd` SC 没有 `ownerReferences`，并标注为 `cpaas.io/creator=kubernetes-admin`，表明它是普通的管理员创建的，而不是由 operator 进行协调。

已经从旧 StorageClass 绑定的现有 PersistentVolumes 不会受到此操作的影响。PV 在创建时携带其 CSI 参数——对于 `topolvm-hdd`，PV 体现为 `spec.csi.fsType: xfs` 和 `spec.persistentVolumeReclaimPolicy: Delete`，这些参数在 PVC 绑定时从 StorageClass 参数中复制。PV 上的 `spec.storageClassName` 仅是名称引用，而不是实时链接，因此在 StorageClass 被删除和重新创建后，PV 继续以其原始文件系统功能运行。

在 StorageClass 重新创建后绑定的 PVC 将根据新的 `parameters` 值重新解析。新绑定的 PV 将根据重新创建的 StorageClass 在该时刻声明的内容设置 `spec.csi.fsType`，因此在重新创建的清单中更改 `csi.storage.k8s.io/fstype` 将在随后创建的卷上产生新的文件系统。

更改用户创建的 StorageClass 上 `fsType` 参数的操作步骤：

```bash
# 1. 备份 StorageClass YAML，去除易变的元数据。
kubectl get storageclass topolvm-hdd -o yaml \
 | grep -v -E '^\s*(creationTimestamp|resourceVersion|uid|generation|managedFields):' \
 > topolvm-hdd.yaml
```

```bash
# 2. 编辑备份。更新相关参数，例如：
#    parameters:
#      csi.storage.k8s.io/fstype: <new-fstype>
${EDITOR:-vi} topolvm-hdd.yaml
```

```bash
# 3. 删除现有的 StorageClass 对象。
kubectl delete storageclass topolvm-hdd
```

```bash
# 4. 从编辑后的清单重新创建它。
kubectl apply -f topolvm-hdd.yaml
```

ACP 上的 StorageClass API 是上游的 `storage.k8s.io/v1` 资源，没有 ACP 特定的包装 CRD，因此对 `storageclass` 的标准 `kubectl get`、`delete` 和 `create`/`apply` 可以直接使用。

将此操作步骤限制在手动创建的 StorageClasses 上。如果 StorageClass 是由 CSI 驱动程序 operator 进行协调的——例如，平台目录中由 `acp-storage-operator` 或 `local-storage-operator` 协调的 SC——手动更改 `parameters` 可能会在 operator 的下一个协调循环中被还原。在更改参数之前检查 `metadata.ownerReferences` 和创建者注释；缺少 `ownerReferences`（如默认的 `topolvm-hdd`）是删除并重新创建安全的标志。

## 诊断步骤

在尝试操作步骤之前确认 StorageClass 的不可变性，使用服务器端干运行补丁：

```bash
kubectl patch storageclass topolvm-hdd \
 --type merge \
 --dry-run=server \
 -p '{"parameters":{"csi.storage.k8s.io/fstype":"<new-fstype>"}}'
```

失败信息 `parameters: Forbidden: updates to parameters are forbidden` 确认该字段在 API 策略级别是不可变的，并且删除并重新创建是所需的路径。

在删除目标 StorageClass 之前检查它是否不是由 operator 协调：

```bash
kubectl get storageclass topolvm-hdd \
 -o jsonpath='{.metadata.ownerReferences}{"\n"}{.metadata.annotations}{"\n"}'
```

空的 `ownerReferences` 和类似 `cpaas.io/creator=kubernetes-admin` 的创建者注释表明该 StorageClass 是管理员创建的，而不是由 operator 协调，这是删除并重新创建的安全条件。

验证现有 PV 在操作后是否存活并继续携带其原始参数：

```bash
kubectl get pv -o custom-columns=\
NAME:.metadata.name,SC:.spec.storageClassName,FSTYPE:.spec.csi.fsType,RECLAIM:.spec.persistentVolumeReclaimPolicy
```

在使用新参数重新创建 StorageClass 后，创建一个新的 PVC 并检查生成的 PV；其 `spec.csi.fsType` 应反映新的参数值，而在更改之前创建的 PV 保留其原始的 `spec.csi.fsType`。
