---
products:
   - Alauda Container Platform
kind:
   - Solution
ProductsVersion:
   - 4.x
---

# 如何让集群外主机共享 OceanStor Dorado 的 NFS 卷

## 概述

OceanStor CSI driver For Dorado 通过 NFS 制备的 PersistentVolume，在存储阵列上对应一个文件系统和一个 NFS 共享。集群外主机只要能够访问 NFS 门户，并且符合访问客户端规则，就可以直接挂载该共享。

本文介绍以下两种接入方式：

- 先在阵列上创建文件系统和 NFS 共享，再将已有卷作为静态卷接入 Kubernetes。这种方式可以使用固定的导出路径。
- 使用动态制备的卷，从 PersistentVolume 中获取系统生成的导出路径。

如果外部系统需要固定的挂载路径，请使用静态卷。如果卷的生命周期由 Kubernetes 管理，并且只需在制备后提供外部访问，可以使用动态制备的卷。

## 环境

| 组件 | 版本 |
|------|------|
| 容器平台 | ACP 4.x（在 4.3.1 上验证） |
| 节点操作系统 | Micro OS 5.5 |
| 存储设备 | OceanStor Dorado 6.1.9 |
| OceanStor CSI driver For Dorado | v4.12.0 |
| 集群外主机 | CentOS 7，已安装 `nfs-utils` |
| 验证的协议 | NFS（v4.1 / v4.2） |

> **注意**：本文操作已使用上表中的版本完成验证。用于其他版本组合前，请确认 CSI 驱动与存储固件兼容。

## 先决条件

- 一个 ACP 4.x 集群，已安装 OceanStor CSI driver For Dorado 并配置 NFS 后端。参见《如何在 ACP 上安装和配置 OceanStor CSI driver For Dorado》。
- 一个配置了 `volumeType: fs` 的 StorageClass，并且 `authClient` 允许集群外主机访问。
- 集群外主机与 NFS 数据平面门户之间具有三层网络连接。NFSv4.1/4.2 挂载只需 TCP 2049 端口。本文中的 `showmount` 检查还需要 rpcbind（111 端口）和 mountd 端口；若这些端口未放通，卷仍可挂载，但 `showmount` 会失败。
- 集群外主机已安装 `nfs-utils` 或等效的 NFS 客户端软件包。
- 使用静态卷时，具备存储 REST API 或 DeviceManager 界面的管理权限，并已从存储管理员处获取存储池信息。

本文使用以下占位符。请替换为实际环境中的值：

| 占位符 | 说明 |
|--------|------|
| `<nfs-portal-ip>` | NFS 数据平面门户地址 |
| `<dorado-management-ip>` | 存储管理平面地址 |
| `<external-host>` | 挂载卷的集群外主机 |
| `<backend-name>` | CSI 存储后端名称，例如 `backend-nfs` |
| `<storage-class>` | NFS StorageClass 名称 |
| `<storage-pool-id>` | 存储池数字 ID，不是存储池名称 |
| `<volume-name>` | 为静态卷选择的文件系统名称，例如 `acp_static_nfs` |
| `<device-id>` | 创建 REST 会话时返回的存储设备 ID |
| `<fs-id>` | 创建文件系统时返回的文件系统 ID |
| `<share-id>` | 创建 NFS 共享时返回的共享 ID |
| `<client-cidr>` | 允许挂载共享的网段 |
| `<namespace>` | PVC 所在命名空间 |

## 解决方案

### 1. 选择卷制备方式

每个 NFS 卷在阵列上都包含一个文件系统、一个 NFS 共享以及一条或多条访问客户端规则。StorageClass 的 `authClient` 参数用于设置访问客户端规则。例如，`authClient: "*"` 允许所有能够访问 NFS 门户的客户端挂载该共享。

集群外主机挂载卷不需要额外的 CSI 配置。两种制备方式的导出路径和生命周期不同：

| 项目 | 静态卷 | 动态制备卷 |
|------|--------|------------|
| 导出路径 | 使用创建卷时指定的文件系统名称 | 使用 PV 中记录的系统生成名称 |
| 集群外主机配置 | 可以在创建 Kubernetes 对象前完成 | 制备后必须使用生成的路径更新配置 |
| 生命周期 | 在动态制备流程之外单独创建和管理 | 通常由 PVC 和 StorageClass 的回收策略管理 |

### 2. 在阵列上创建静态卷

按顺序创建文件系统、NFS 共享和访问客户端规则。下面展示的是存储 REST API 的请求体结构，不是可直接执行的脚本。每个请求都发往 `https://<dorado-management-ip>/deviceManager/rest/<device-id>/...`，且需要已认证的会话：先创建会话（`POST /deviceManager/rest/xxxxx/sessions`）以获得 `<device-id>` 和 `iBaseToken`，再在后续每个请求的 `iBaseToken` 请求头中带上该令牌。也可以在 DeviceManager 界面中创建相同的对象。

```text
# 1. 文件系统。CAPACITY 的单位是 512 字节扇区，所以 4194304 = 2 GiB。
#    PARENTID 是存储池的数字 ID，不是存储池名称。
# POST /deviceManager/rest/<device-id>/filesystem
{
  "NAME": "<volume-name>",
  "PARENTID": "<storage-pool-id>",
  "CAPACITY": 4194304,
  "ALLOCTYPE": 1,
  "SECTORSIZE": 16384
}

# 2. NFS 共享。<fs-id> 取自请求 1 的响应。
# POST /deviceManager/rest/<device-id>/NFSHARE
{ "SHAREPATH": "/<volume-name>/", "FSID": "<fs-id>", "vstoreId": "0" }

# 3. 访问客户端。<share-id> 取自请求 2 的响应。
#    这些取值与 CSI 驱动程序在动态制备卷上设置的一致，
#    以保证行为不产生差异。
# POST /deviceManager/rest/<device-id>/NFS_SHARE_AUTH_CLIENT
{
  "NAME": "*", "PARENTID": "<share-id>",
  "ACCESSVAL": 1, "SYNC": 0, "ALLSQUASH": 1,
  "ROOTSQUASH": 1, "SECURE": 1, "vstoreId": "0"
}
```

`CAPACITY` 的单位是 512 字节扇区。`PARENTID` 必须填写存储池的数字 ID，不能填写存储池名称。`<fs-id>` 取自文件系统创建响应，`<share-id>` 取自 NFS 共享创建响应。创建完成后，导出路径为 `<nfs-portal-ip>:/<volume-name>`。

静态卷可以通过自行创建 PV，或使用 CSI 卷纳管功能接入 Kubernetes。请选择以下一种方式。

### 3. 通过创建 PV 和 PVC 接入静态卷

创建 PV，并将 PVC 预绑定到该 PV：

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-static-nfs
spec:
  # 空字符串：该 PV 不参与任何动态制备
  storageClassName: ""
  volumeMode: Filesystem
  accessModes: ["ReadWriteMany"]
  capacity:
    storage: 2Gi
  # 管理员预建的卷绝不能被 Kubernetes 删除
  persistentVolumeReclaimPolicy: Retain
  # 不会从 StorageClass 继承，因此需在此指定，否则 NFS 版本由协商决定
  mountOptions:
    - nfsvers=4.1
  csi:
    driver: csi.huawei.com
    volumeHandle: <backend-name>.<volume-name>   # 格式：<backend-name>.<filesystem-name>
    volumeAttributes:
      backend: <backend-name>
      name: <volume-name>
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: static-a
  namespace: <namespace>
spec:
  # 同样必须是空字符串，否则会被替换成默认 StorageClass，导致绑定失败
  storageClassName: ""
  accessModes: ["ReadWriteMany"]
  resources:
    requests:
      storage: 2Gi
  volumeName: pv-static-nfs
```

PV 和 PVC 都必须设置 `storageClassName: ""`。如果 PVC 省略该字段，Kubernetes 可能会填入默认 StorageClass，导致 PVC 无法与此 PV 绑定。

静态 PV 不会从 StorageClass 继承 `mountOptions`。在本文验证环境中，不设置 `mountOptions` 时，NFS 协商结果为 4.2；设置 `nfsvers=4.1` 后，挂载使用 NFS 4.1。

### 4. 通过 CSI 卷纳管功能接入静态卷

如果不自行创建 PV，可以在 PVC 上添加卷纳管注解和必需的标签。CSI 驱动会导入已有卷并生成 PV：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: static-b
  namespace: <namespace>
  annotations:
    csi.huawei.com/manageVolumeName: <volume-name>   # 阵列上的卷名
    csi.huawei.com/manageBackendName: <backend-name>
  labels:
    provisioner: csi.huawei.com                        # 必需
spec:
  accessModes: ["ReadWriteMany"]
  storageClassName: <storage-class>                    # 使用真实 StorageClass，不是 ""
  resources:
    requests:
      storage: 2Gi                                     # 必须与阵列上卷的实际大小一致
```

PVC 必须同时包含 `csi.huawei.com/manageVolumeName`、`csi.huawei.com/manageBackendName` 和 `provisioner: csi.huawei.com` 标签。此方式的 `storageClassName` 应填写已有 StorageClass，不能使用空字符串。

系统生成的 PV 名称为 `pvc-<uid>`，其 `volumeHandle` 指向 `<backend-name>.<volume-name>`，导出路径仍使用阵列上指定的文件系统名称。

> **重要**：系统生成的 PV 会继承 StorageClass 的 `reclaimPolicy`。如果 StorageClass 使用 `Delete`，删除 PVC 时也会删除手工创建的文件系统。PVC 变为 `Bound` 后，请立即将生成的 PV 改为 `Retain`：
>
> ```bash
> kubectl patch pv <generated-pv-name> \
>   -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
> ```

### 5. 挂载并验证静态卷

集群外主机可以直接挂载创建文件系统时指定的路径：

```bash
mkdir -p /mnt/appdata
mount -t nfs -o vers=4.1 <nfs-portal-ip>:/<volume-name> /mnt/appdata
```

两种静态卷接入方式的行为如下：

| 项目 | 创建 PV 和 PVC | 使用 CSI 卷纳管功能 |
|------|----------------|----------------------|
| 需要创建的 Kubernetes 对象 | PV 和 PVC | 仅 PVC |
| `storageClassName` | 两个对象都必须为 `""` | 已有 StorageClass |
| PV 名称 | 由管理员指定 | 生成为 `pvc-<uid>` |
| 回收策略 | 直接在 PV 上设置，应使用 `Retain` | 继承 StorageClass，若为 `Delete` 必须立即改为 `Retain` |
| `mountOptions` | 直接在 PV 上设置 | 继承 StorageClass |
| 验证的 PVC 状态 | `Bound` | `Bound` |
| 验证的 NFS 版本 | 未设置 `mountOptions` 时为 4.2；设置后为 4.1 | 从 StorageClass 继承 4.1 |
| 集群外访问 | 使用固定导出路径，可双向读写 | 使用固定导出路径，可双向读写 |

自行创建 PV 和 PVC 可以明确指定回收策略和挂载参数。使用 CSI 卷纳管功能需要创建的 Kubernetes 对象更少，但必须立即检查回收策略。

### 6. 挂载动态制备的卷

通过普通 PVC 动态制备的卷也可以在集群外主机上挂载。导出路径由系统生成，必须从 `.spec.csi.volumeAttributes.name` 读取。导出路径不是 PV 名称，CSI 驱动会将生成值中的连字符替换为下划线。

1. 从 PV 读取导出路径：

   ```bash
   kubectl get pv <pv-name> -o jsonpath='{.spec.csi.volumeAttributes.name}'
   ```

   ```text
   pvc_0464141b_4e64_47b1_bc9b_a9f41c686bf6
   ```

2. 可选：在集群外主机上确认可以看到该导出。此检查依赖 rpcbind 和 mountd；若只放通了 NFSv4 的 2049 端口，可跳过此步直接挂载。

   ```bash
   showmount -e <nfs-portal-ip>
   ```

   ```text
   /pvc_0464141b_4e64_47b1_bc9b_a9f41c686bf6 *
   ```

3. 挂载导出：

   ```bash
   mkdir -p /mnt/appdata
   mount -t nfs -o vers=4.1 \
     <nfs-portal-ip>:/pvc_0464141b_4e64_47b1_bc9b_a9f41c686bf6 /mnt/appdata
   ```

Pod 写入的文件会立即显示在集群外主机上，集群外主机写入的文件也会显示在 Pod 中。

重新制备卷后，系统生成的路径会发生变化，此时需要更新集群外主机配置。该卷仍受 StorageClass 回收策略控制。如果集群外主机依赖此卷，请在 PVC 可能被删除前将 PV 设置为 `Retain`：

```bash
kubectl patch pv <pv-name> \
  -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

### 7. 配置目录权限并排除快照目录

新卷的根目录属主和属组为 `root:root`，权限为 `755`。这些 NFS 导出不会 squash root。因此，允许访问的集群外主机上的 root 用户可以写入，但非 root 用户在 UID 和 GID 没有相应权限时会收到 `Permission denied`。

如需允许非 root 用户访问，可以统一 Pod 与集群外主机使用的 UID/GID，或在 StorageClass 中设置 `fsPermission`。以下配置向所有用户授予读、写和执行权限，只能用于允许此访问范围的环境：

```yaml
parameters:
  fsPermission: "777"
```

阵列还会在卷根目录创建只读的 `.snapshot` 目录，该目录无法删除。备份或同步程序遍历卷根目录时必须排除它。使用 `rsync --delete` 时，应指定 `--exclude='/.snapshot'`。前导斜杠表示只排除卷根目录下的 `.snapshot`，不会排除数据目录中其他同名目录。

### 8. 限制 NFS 客户端访问范围

`authClient: "*"` 允许所有能够访问 NFS 门户的主机挂载共享。请将其限制为实际需要访问的网段：

```yaml
parameters:
  authClient: "<client-cidr>"
```

对于静态卷，请在 `NFS_SHARE_AUTH_CLIENT` 规则的 `NAME` 字段中设置相同的限制，不要使用 `*`。

由于 root 不会被 squash，应将 NFS 门户的网络访问权限视为数据访问权限。在多团队共用的阵列上，请与存储管理员确认正确的存储池和逻辑端口。所有存在集群外使用者的卷都应使用 `reclaimPolicy: Retain`。

## 常见问题

### 为什么不能使用 PV 名称作为 NFS 导出路径？

对于动态制备的卷，导出路径保存在 `.spec.csi.volumeAttributes.name` 中。该值不是 PV 名称，并且系统生成路径使用下划线替代对应标识符中的连字符。配置集群外主机前，请从 PV 中读取此值。

### 为什么集群外的非 root 用户会收到 `Permission denied`？

卷根目录创建为 `root:root`，权限为 `755`。root 不会被 squash，但其他用户默认没有写权限。请统一 UID/GID，或设置合适的 `fsPermission`。

### 为什么 `rsync --delete` 会在 `.snapshot` 目录上失败？

`.snapshot` 是阵列在卷根目录中维护的只读目录，无法删除。请使用 `--exclude='/.snapshot'`，避免 `rsync --delete` 尝试删除该目录。
