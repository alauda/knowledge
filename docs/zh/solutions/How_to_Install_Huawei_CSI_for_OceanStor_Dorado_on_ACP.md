---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB260600012
sourceSHA: 51033b0dfc73b3247dd954881c04401b0cd9d049098dfd2dec79f3db2cb441bb
---

# 如何在 ACP 上安装和配置 OceanStor CSI 驱动程序以支持 Dorado

## 概述

本指南将引导您安装 OceanStor CSI 驱动程序以支持 Dorado 作为 ACP 集群插件，并将其与 OceanStor Dorado 存储阵列集成。内容包括准备节点、部署 CSI 组件、配置存储后端、创建 StorageClass 以及通过测试 PVC 验证集成。将验证 iSCSI 和 NFS 协议。

## 环境

| 组件                           | 版本                       |
| ------------------------------ | -------------------------- |
| 容器平台                       | ACP 4.x（在 4.2 上验证）   |
| 节点操作系统                   | Micro OS 5.5               |
| 存储设备                       | OceanStor Dorado 6.1.6     |
| OceanStor CSI 驱动程序支持 Dorado | v4.11.0                    |
| 安装方法                       | 集群插件                   |
| 验证的协议                     | iSCSI, NFS                 |

> **注意**：该操作步骤适用于所有 ACP 4.x 版本。然而，OceanStor CSI 驱动程序支持 Dorado 和 OceanStor Dorado 版本是耦合的——在继续之前，请确认您安装的 CSI 版本在您的 Dorado 固件版本的兼容性列表中。上表中的版本是本指南验证过的版本。

## 先决条件

- 一个 ACP 4.x 集群，并且可以访问 `kubectl`。
- 一个可访问的 OceanStor Dorado 阵列，以及存储管理员提供的管理地址、存储池名称和数据平面门户地址。
- 每个集群节点（主节点和工作节点）与存储管理平面和数据平面之间的三层连接。在环境规划时确认这一点。
- 从 Alauda Cloud Marketplace 下载的 OceanStor CSI 驱动程序插件包。
- 与 CSI 版本匹配的 eSDK 包中的 `oceanctl` 工具。
- 安装了 `violet` CLI，并且有一个可以将插件包上传到目标业务集群的平台账户。

本指南中使用了以下占位符。请将其替换为您环境中的值：

| 占位符                     | 描述                           |
| -------------------------- | ------------------------------ |
| `<dorado-management-ip>`   | Dorado 管理平面地址            |
| `<iscsi-portal-ip>`        | iSCSI 数据平面门户地址         |
| `<nfs-portal-ip>`          | NFS 数据平面门户地址           |
| `<pool-name>`              | OceanStor 存储池名称           |

## 解决方案

### 1. 准备集群节点

#### 1.1 验证网络连接

所有集群节点（主节点和工作节点）必须能够访问存储管理平面和数据平面：

| 目的                     | 地址                          | 描述                                      |
| ------------------------ | ----------------------------- | ----------------------------------------- |
| Dorado 管理平面         | `<dorado-management-ip>:8088` | CSI 通过此地址管理存储                     |
| iSCSI 数据平面          | `<iscsi-portal-ip>`           | iSCSI 门户，业务 IO 路径                   |
| NFS 数据平面            | `<nfs-portal-ip>`             | NFS 门户，业务 IO 路径                     |

在每个节点上验证连接性：

```shell
ping <dorado-management-ip>
# ping 仅检查 ICMP 可达性；还需验证管理 API 端口（8088）是否开放
curl -k https://<dorado-management-ip>:8088
ping <iscsi-portal-ip>
ping <nfs-portal-ip>
```

#### 1.2 配置防火墙

Micro OS 保持 firewalld 和 SELinux 启用。必须打开 `huawei-csi-controller` 的 webhook 服务端口（4433/tcp）：

```shell
# 显示当前打开的端口
firewall-cmd --list-ports

# 打开 4433/tcp（CSI webhook 端口）
firewall-cmd --zone=public --add-port=4433/tcp --permanent && firewall-cmd --reload

# 验证
firewall-cmd --list-ports
```

#### 1.3 确认主机软件依赖项

根据您计划使用的协议，确认以下服务在 **所有节点** 上运行：

**iSCSI 协议（使用 iSCSI 时必需）：**

```shell
systemctl status iscsi iscsid
# 如果未启动：
systemctl enable iscsi iscsid --now
```

**NFS 协议（使用 NFS 时必需）：**

```shell
systemctl status rpcbind
# 如果未启动：
systemctl enable rpcbind --now
```

**DM-Multipath（使用 iSCSI/FC 时必需）：**

```shell
systemctl status multipathd.socket multipathd
# 如果未启动：
systemctl enable multipathd --now
```

#### 1.4 配置多路径

确认 `/etc/multipath.conf` 包含以下配置。如果文件不存在，请使用以下内容创建它：

```text
defaults {
        user_friendly_names yes
        find_multipaths no
}
```

### 2. 准备安装包

#### 2.1 从 Alauda Cloud 下载插件包

使用租户账户登录 Alauda Cloud，在 Marketplace 中搜索 **OceanStor CSI 驱动程序支持 Dorado**，并下载插件包。

#### 2.2 上传插件包

使用 `violet push` 将插件包上传到目标集群：

```shell
violet push \
  --platform-address <platform-address> \
  --clusters <business-cluster-name> \
  --platform-username <platform-admin-username> \
  --platform-password <platform-admin-password> \
  <dorado-csi-plugin-package>.tgz
```

### 3. 部署 CSI 组件

#### 3.1 安装集群插件

从平台将 **OceanStor CSI 驱动程序支持 Dorado** 集群插件安装到目标集群。

#### 3.2 验证部署状态

```shell
kubectl get pod -n huawei-csi
```

当所有 Pod 都处于 `Running` 状态时，部署成功。

### 4. 配置存储后端

使用 eSDK 包中的 `oceanctl` 工具创建后端。

#### 4.1 后端认证

您无需手动创建凭据 Secret。当您运行 `oceanctl create backend`（步骤 4.2 和 4.3）时，它会交互式提示输入存储账户用户名和密码，并自动将其存储在 `huawei-csi` 命名空间中的 Kubernetes Secret 中：

```text
请输入此后端用户名：
请输入此后端密码：
```

使用具有管理目标存储池权限的 Dorado 账户。

#### 4.2 创建 iSCSI 后端

创建 `backend-blk.yaml`：

```yaml
storage: "oceanstor-san"
name: "backend-blk"
namespace: "huawei-csi"
urls:
  - "https://<dorado-management-ip>:8088"
pools:
  - "<pool-name>"
parameters:
  protocol: "iscsi"
  portals:
    - "<iscsi-portal-ip>"
maxClientThreads: "30"
```

创建后端：

```shell
oceanctl create backend -f backend-blk.yaml -i yaml --log-dir /tmp/
```

#### 4.3 创建 NFS 后端

创建 `backend-nfs.yaml`：

```yaml
storage: "oceanstor-nas"
name: "backend-nfs"
namespace: "huawei-csi"
urls:
  - "https://<dorado-management-ip>:8088"
pools:
  - "<pool-name>"
parameters:
  protocol: "nfs"
  portals:
    - "<nfs-portal-ip>"
maxClientThreads: "30"
```

创建后端：

```shell
oceanctl create backend -f backend-nfs.yaml -i yaml --log-dir /tmp/
```

#### 4.4 验证后端状态

```shell
oceanctl get backend -n huawei-csi
```

### 5. 配置 StorageClass

#### 5.1 iSCSI StorageClass

```yaml
kind: StorageClass
apiVersion: storage.k8s.io/v1
metadata:
  name: huawei-sc-iscsi
provisioner: csi.huawei.com
parameters:
  backend: backend-blk
  volumeType: lun
  allocType: thin
  fsType: ext4
reclaimPolicy: Delete
allowVolumeExpansion: true
```

```shell
kubectl apply -f sc-iscsi.yaml
```

#### 5.2 NFS StorageClass

```yaml
kind: StorageClass
apiVersion: storage.k8s.io/v1
metadata:
  name: huawei-sc-nfs
provisioner: csi.huawei.com
parameters:
  backend: backend-nfs
  volumeType: fs
  allocType: thin
  authClient: "*"
mountOptions:
  - nfsvers=4.1
reclaimPolicy: Delete
allowVolumeExpansion: true
```

```shell
kubectl apply -f sc-nfs.yaml
```

> **注意**：`authClient: "*"` 允许任何 NFS 客户端挂载卷，这在验证时很方便。对于生产环境，请限制为特定客户端 IP 或 CIDR 范围（例如，`192.0.2.0/24`）。

### 6. 验证

创建一个测试 PVC 以验证存储集成是否正常工作：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-pvc
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: huawei-sc-iscsi   # 或 huawei-sc-nfs
  resources:
    requests:
      storage: 10Gi
```

```shell
kubectl apply -f test-pvc.yaml
kubectl get pvc test-pvc
```

当 PVC 状态变为 `Bound` 时，验证成功。

## 常见问题解答

### 创建后端时失败，出现 `context deadline exceeded`

**错误信息：**

```text
failed to configure the backend account. Error from server (InternalError): error when creating "STDIN": Internal error occurred: failed calling webhook "storage-backend-controller.xuanwu.huawei.io": failed to call webhook: Post "https://huawei-csi-controller.huawei-csi.svc:4433/storagebackendclaim?timeout=10s": context deadline exceeded
```

**原因分析：**

- 存储网络不可达：CSI 控制器无法连接到 Dorado 管理地址或门户。
- kube-apiserver 与 CSI webhook 之间的通信异常（例如，被 HTTPS 代理拦截）。

**故障排除步骤：**

1. 检查控制器日志：

   ```shell
   # 获取控制器 pod 名称
   kubectl get pod -n huawei-csi

   # 查看日志文件（在控制器运行的节点上）
   tail -f /var/log/huawei/storage-backend-controller/*.log
   ```

2. 确认节点可以访问 Dorado 管理地址：

   ```shell
   ping <dorado-management-ip>
   curl -k https://<dorado-management-ip>:8088
   ```

3. 确认防火墙已打开端口 4433（见步骤 1.2）。

**临时解决方法：**

如果故障排除未能解决问题，请尝试重启 CSI 控制器 pod：

```shell
kubectl delete pod -n huawei-csi -l app=huawei-csi-controller
```

或者，作为最后手段，暂时删除 webhook（删除后，后端创建将不再被验证）。控制器重启后，webhook 会自动恢复：

> **警告**：删除 webhook 会禁用后端配置验证。仅在非生产环境中进行故障排除时使用，并在之后立即恢复。

```shell
kubectl delete validatingwebhookconfiguration storage-backend-controller.xuanwu.huawei.io
# 重启控制器以恢复 webhook
kubectl delete pod -n huawei-csi -l app=huawei-csi-controller
```

### Pod 作为非根用户无法访问挂载卷（fsPermission / fsGroup 问题）

当 Pod 使用 `securityContext` 指定非根用户（例如，`runAsUser: 1000`）时，可能会遇到卷目录权限不足的问题。有三种解决方案：

**解决方案 1：在 StorageClass 中设置 fsPermission**

适合在开发或测试环境中快速打开权限：

```yaml
parameters:
  fsPermission: "777"
```

> **警告**：`fsPermission: "777"` 赋予节点上的每个用户完全的读/写/执行权限。在生产环境中避免使用；更倾向于使用解决方案 2 或 3 中基于 `fsGroup` 的方法。

**解决方案 2：在 StorageClass 中显式指定 fsType + 对 PVC 使用 ReadWriteOnce**

在 StorageClass 中显式指定 `fsType`，并将 PVC 的 `accessMode` 设置为 `ReadWriteOnce`。只有这样，Pod 的 `securityContext` 中的 `fsGroup` 才会生效：

```yaml
# StorageClass
parameters:
  fsType: ext4

# Pod securityContext
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
```

**解决方案 3：在部署前修改 CSIDriver fsGroupPolicy**

在安装 CSI 之前，修改 `csidriver.yaml` 中的 CSIDriverObject 配置：

```yaml
# 在 deploy/csidriver.yaml 中设置
spec:
  fsGroupPolicy: File
```

部署后，Pod 的 `securityContext.fsGroup` 生效：

```yaml
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
```
