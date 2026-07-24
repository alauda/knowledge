---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB260700085
sourceSHA: 9b0a04bb20e660fa6551e58432addbc9e73a987492aa27984bbe26ca1a3daf3d
---

# 如何与集群外的主机共享 OceanStor Dorado NFS 卷

## 概述

由 OceanStor CSI 驱动程序为 Dorado 提供的 NFS PersistentVolume 存储为文件系统和存储阵列上的 NFS 共享。如果主机可以访问 NFS 入口并且被访问客户端规则允许，则可以直接挂载该共享。

本指南描述了两种支持的方法：

- 在阵列上创建文件系统和 NFS 共享，然后将现有卷连接到 Kubernetes 作为静态卷。此方法提供固定的导出路径。
- 使用动态提供的卷，并从 PersistentVolume 中获取其生成的导出路径。

当外部系统需要稳定的挂载路径时，请使用静态卷。当 Kubernetes 管理卷生命周期并且仅在提供后需要外部访问时，请使用动态提供的卷。

## 环境

| 组件                           | 版本                          |
| ------------------------------ | ----------------------------- |
| 容器平台                       | ACP 4.x（在 4.3.1 上验证）   |
| 节点操作系统                   | Micro OS 5.5                  |
| 存储设备                       | OceanStor Dorado 6.1.9        |
| OceanStor CSI 驱动程序为 Dorado | v4.12.0                       |
| 外部主机                       | CentOS 7，带有 `nfs-utils`    |
| 验证的协议                     | NFS (v4.1 / v4.2)             |

> **注意**：本指南中的程序已在上述版本上验证。在将其应用于其他版本组合之前，请确认 CSI 驱动程序和存储固件的兼容性。

## 先决条件

- 安装了 OceanStor CSI 驱动程序为 Dorado 的 ACP 4.x 集群，并配置了 NFS 后端。请参见 *如何在 ACP 上安装和配置 OceanStor CSI 驱动程序为 Dorado*。
- 一个具有 `volumeType: fs` 和允许外部主机的 `authClient` 值的 StorageClass。
- 外部主机与 NFS 数据平面入口之间的三层连接。NFSv4.1/4.2 挂载仅需要 TCP 端口 2049。本指南中的 `showmount` 检查还需要 rpcbind（端口 111）和 mountd 端口；如果这些端口未开放，卷仍然可以挂载，但 `showmount` 会失败。
- 在外部主机上安装 `nfs-utils` 或等效的 NFS 客户端软件包。
- 对于静态卷，需具有对存储 REST API 或 DeviceManager UI 的管理访问权限，以及存储管理员提供的存储池信息。

本指南中使用了以下占位符。请用您环境中的值替换它们：

| 占位符                     | 描述                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| `<nfs-portal-ip>`          | NFS 数据平面入口地址                                                      |
| `<dorado-management-ip>`   | 存储管理平面地址                                                          |
| `<external-host>`          | 挂载卷的集群外主机                                                        |
| `<backend-name>`           | CSI 存储后端名称，例如 `backend-nfs`                                      |
| `<storage-class>`          | NFS StorageClass 名称                                                      |
| `<storage-pool-id>`        | 数字存储池 ID，而不是池名称                                               |
| `<volume-name>`            | 您为静态卷选择的文件系统名称，例如 `acp_static_nfs`                     |
| `<device-id>`              | 创建 REST 会话时返回的存储设备 ID                                         |
| `<fs-id>`                  | 创建文件系统时返回的文件系统 ID                                           |
| `<share-id>`               | 创建共享时返回的 NFS 共享 ID                                             |
| `<client-cidr>`            | 被允许挂载共享的 CIDR 范围                                               |
| `<namespace>`              | PVC 的命名空间                                                             |

## 解决方案

### 1. 选择卷提供方法

每个 NFS 卷都有一个文件系统、一个 NFS 共享和一个或多个访问客户端规则。StorageClass 的 `authClient` 参数用于访问客户端规则。例如，`authClient: "*"` 允许每个可以访问 NFS 入口的客户端挂载共享。

外部挂载不需要额外的 CSI 配置。提供方法决定了导出路径和生命周期：

| 项目                         | 静态卷                                                | 动态提供的卷                                               |
| ---------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| 导出路径                     | 使用创建卷时选择的文件系统名称                       | 使用存储在 PV 中的生成名称                               |
| 外部主机配置                 | 可以在创建 Kubernetes 对象之前准备                   | 必须在提供后使用生成的路径进行更新                       |
| 生命周期                     | 与动态提供分开创建和控制                             | 通常由 PVC 和 StorageClass 回收策略控制                  |

### 2. 在阵列上创建静态卷

按顺序创建文件系统、NFS 共享和访问客户端规则。以下块显示了存储 REST API 的请求主体；这不是可运行的脚本。每个请求都发送到 `https://<dorado-management-ip>/deviceManager/rest/<device-id>/...` 并需要经过身份验证的会话：首先创建会话（`POST /deviceManager/rest/xxxxx/sessions`）以获取 `<device-id>` 和 `iBaseToken`，然后在每个后续请求的 `iBaseToken` 头中发送该令牌。也可以在 DeviceManager UI 中创建相同的对象。

```text
# 1. 文件系统。容量以 512 字节扇区为单位，因此 4194304 = 2 GiB。
#    PARENTID 是数字存储池 ID，而不是池名称。
# POST /deviceManager/rest/<device-id>/filesystem
{
  "NAME": "<volume-name>",
  "PARENTID": "<storage-pool-id>",
  "CAPACITY": 4194304,
  "ALLOCTYPE": 1,
  "SECTORSIZE": 16384
}

# 2. NFS 共享。使用请求 1 的响应中的 FS ID 作为 <fs-id>。
# POST /deviceManager/rest/<device-id>/NFSHARE
{ "SHAREPATH": "/<volume-name>/", "FSID": "<fs-id>", "vstoreId": "0" }

# 3. 访问客户端。使用请求 2 的响应中的共享 ID 作为 <share-id>。
#    这些值与 CSI 驱动程序在动态提供的卷上设置的值匹配，因此行为保持一致。
# POST /deviceManager/rest/<device-id>/NFS_SHARE_AUTH_CLIENT
{
  "NAME": "*", "PARENTID": "<share-id>",
  "ACCESSVAL": 1, "SYNC": 0, "ALLSQUASH": 1,
  "ROOTSQUASH": 1, "SECURE": 1, "vstoreId": "0"
}
```

`CAPACITY` 值以 512 字节扇区为单位。`PARENTID` 必须是存储池的数字 ID，而不是其名称。`<fs-id>` 来自文件系统创建响应，`<share-id>` 来自 NFS 共享响应。创建后，导出可在 `<nfs-portal-ip>:/<volume-name>` 处使用。

可以通过自己创建 PV 或请求 CSI 驱动程序管理现有卷将静态卷连接到 Kubernetes。选择以下方法之一。

### 3. 通过创建 PV 和 PVC 连接静态卷

创建 PV 并预绑定一个 PVC：

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-static-nfs
spec:
  # 空字符串：此 PV 不参与动态提供
  storageClassName: ""
  volumeMode: Filesystem
  accessModes: ["ReadWriteMany"]
  capacity:
    storage: 2Gi
  # 管理员提供的卷不得被 Kubernetes 删除
  persistentVolumeReclaimPolicy: Retain
  # 不从 StorageClass 继承，因此在此处设置，否则 NFS 版本将被协商
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
  # 也必须是空字符串，否则默认 StorageClass 将被替换，声明将无法绑定
  storageClassName: ""
  accessModes: ["ReadWriteMany"]
  resources:
    requests:
      storage: 2Gi
  volumeName: pv-static-nfs
```

在 PV 和 PVC 上都设置 `storageClassName: ""`。如果在 PVC 中省略该字段，Kubernetes 可以替换默认 StorageClass，PVC 将无法绑定到此 PV。

静态 PV 不从 StorageClass 继承 `mountOptions`。当在此环境中省略 `mountOptions` 时，NFS 协商选择版本 4.2。设置 `nfsvers=4.1` 使挂载使用版本 4.1。

### 4. 通过使用 CSI 卷管理连接静态卷

不创建 PV，而是向 PVC 添加卷管理注释和所需标签。CSI 驱动程序导入现有卷并生成 PV：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: static-b
  namespace: <namespace>
  annotations:
    csi.huawei.com/manageVolumeName: <volume-name>   # 阵列上的卷名称
    csi.huawei.com/manageBackendName: <backend-name>
  labels:
    provisioner: csi.huawei.com                        # 必需
spec:
  accessModes: ["ReadWriteMany"]
  storageClassName: <storage-class>                    # 真实的 StorageClass，而不是 ""
  resources:
    requests:
      storage: 2Gi                                     # 必须与阵列侧大小匹配
```

PVC 必须包含 `csi.huawei.com/manageVolumeName` 和 `csi.huawei.com/manageBackendName`，以及 `provisioner: csi.huawei.com` 标签。在此方法中，`storageClassName` 指的是现有的 StorageClass，而不是空字符串。

生成的 PV 名称为 `pvc-<uid>`。其 `volumeHandle` 指向 `<backend-name>.<volume-name>`，导出路径继续使用在阵列上选择的文件系统名称。

> **重要**：生成的 PV 从 StorageClass 继承 `reclaimPolicy`。如果 StorageClass 使用 `Delete`，删除 PVC 也会删除手动创建的文件系统。在 PVC 变为 `Bound` 后立即将生成的 PV 更改为 `Retain`：
>
> ```bash
> kubectl patch pv <generated-pv-name> \
>   -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
> ```

### 5. 挂载并验证静态卷

外部主机可以挂载创建文件系统时选择的路径：

```bash
mkdir -p /mnt/appdata
mount -t nfs -o vers=4.1 <nfs-portal-ip>:/<volume-name> /mnt/appdata
```

这两种静态卷方法具有以下行为：

| 项目                         | 创建 PV 和 PVC                          | 使用 CSI 卷管理                                                |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| Kubernetes 对象创建         | PV 和 PVC                               | 仅 PVC                                                       |
| `storageClassName`           | 必须为 `""`                             | 现有 StorageClass                                            |
| PV 名称                      | 由管理员选择                           | 生成为 `pvc-<uid>`                                          |
| 回收策略                     | 直接在 PV 上设置；使用 `Retain`        | 从 StorageClass 继承；立即将 `Delete` 更改为 `Retain`      |
| `mountOptions`               | 直接在 PV 上设置                       | 从 StorageClass 继承                                        |
| 验证 PVC 状态                | `Bound`                                 | `Bound`                                                      |
| 验证 NFS 版本                | 未指定 `mountOptions` 时为 4.2；指定时为 4.1 | 从 StorageClass 继承的 4.1                                   |
| 外部访问                     | 固定导出路径和双向读写                 | 固定导出路径和双向读写                                       |

直接创建 PV 和 PVC 使回收策略和挂载选项明确。CSI 卷管理需要更少的 Kubernetes 对象，但需要立即检查回收策略。

### 6. 挂载动态提供的卷

从普通 PVC 创建的卷也可以在集群外挂载。其导出路径是生成的，必须从 `.spec.csi.volumeAttributes.name` 中读取。导出路径不是 PV 名称。CSI 驱动程序将生成值中的连字符更改为下划线。

1. 从 PV 中读取导出路径：

   ```bash
   kubectl get pv <pv-name> -o jsonpath='{.spec.csi.volumeAttributes.name}'
   ```

   ```text
   pvc_0464141b_4e64_47b1_bc9b_a9f41c686bf6
   ```

2. 可选地确认外部主机是否可见该导出。此检查依赖于 rpcbind 和 mountd；如果仅开放 NFSv4 端口 2049，则跳过此步骤并直接挂载。

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

由 Pod 写入的文件在外部主机上立即可见，而在外部主机上写入的文件在 Pod 中也可见。

如果卷被重新提供，生成的路径会发生变化。每当发生这种情况时，请更新外部主机配置。该卷仍然受 StorageClass 回收策略的约束。如果外部主机依赖于它，请在 PVC 被删除之前将 PV 设置为 `Retain`：

```bash
kubectl patch pv <pv-name> \
  -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

### 7. 配置权限并排除快照目录

新卷的根目录为 `root:root`，模式为 `755`。在这些导出中，root 不会被压缩。因此，允许的外部主机上的 root 可以写入该卷，但非 root 用户在其 UID 和 GID 没有适当权限时会收到 `Permission denied`。

要允许非 root 访问，请对齐 Pod 和外部主机使用的 UID/GID，或在 StorageClass 中设置 `fsPermission`。以下值授予所有用户读、写和执行权限，应限制在可以接受该访问的环境中：

```yaml
parameters:
  fsPermission: "777"
```

阵列还会在卷根目录创建一个只读的 `.snapshot` 目录。它无法被删除。任何遍历根目录的备份或同步过程必须排除它。当使用 `rsync --delete` 时，指定 `--exclude='/.snapshot'`。前导斜杠将排除限制在卷根目录，而不会排除数据树中其他同名目录。

### 8. 限制 NFS 客户端访问

`authClient: "*"` 允许每个可以访问 NFS 入口的主机挂载共享。将此值限制为需要访问的网络：

```yaml
parameters:
  authClient: "<client-cidr>"
```

对于静态卷，请在 `NFS_SHARE_AUTH_CLIENT` 规则的 `NAME` 字段中设置相同的限制，而不是使用 `*`。

将对 NFS 入口的访问视为数据访问，因为 root 不会被压缩。在多个团队共享的阵列上，请与存储管理员确认正确的存储池和逻辑端口。对每个有外部消费者的卷使用 `reclaimPolicy: Retain`。

## 常见问题解答

### 为什么 PV 名称无法作为 NFS 导出路径？

对于动态提供的卷，导出路径存储在 `.spec.csi.volumeAttributes.name` 中。它不是 PV 名称，生成的路径在对应的生成标识符使用连字符的地方使用下划线。在配置外部主机之前，请从 PV 中读取该值。

### 为什么外部非 root 用户收到 `Permission denied`？

卷根目录创建为 `root:root`，模式为 `755`。root 不会被压缩，但其他用户默认没有写权限。对齐 UID/GID 值或配置适当的 `fsPermission` 值。

### 为什么 `rsync --delete` 在 `.snapshot` 上失败？

`.snapshot` 是卷根目录下的只读阵列管理目录，无法删除。使用 `--exclude='/.snapshot'` 以便 `rsync --delete` 不会尝试删除它。
