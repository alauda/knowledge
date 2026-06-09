---
products:
   - Alauda Container Platform
kind:
   - Solution
ProductsVersion:
   - 4.x
---

# 如何在 ACP 上安装与配置对接 OceanStor Dorado 的 Huawei CSI

## 概述

本指南介绍如何在 ACP 集群上手动（离线）安装 Huawei CSI 驱动，并对接华为 OceanStor Dorado 存储阵列。内容涵盖节点准备、部署 CSI 组件、配置存储后端、创建 StorageClass，以及通过测试 PVC 验证对接。iSCSI 和 NFS 两种协议均已验证。

## 环境信息

| 组件 | 版本 |
|------|------|
| 容器平台 | ACP 4.x（在 4.2 上验证） |
| 节点操作系统 | Micro OS 5.5 |
| 存储设备 | OceanStor Dorado 6.1.6 |
| Huawei CSI | v4.11.0 |
| 安装方式 | 手动安装 |
| 验证协议 | iSCSI、NFS |

> **说明**：本流程适用于所有 ACP 4.x 版本。但 Huawei CSI 与 OceanStor Dorado 的版本是耦合的——在开始之前，请确认所安装的 CSI 版本在对应 Dorado 固件版本的兼容性列表内。上表中的版本是本指南验证过的版本。

## 前置条件

本指南通篇使用以下占位符，请替换为你环境中的实际值：

| 占位符 | 说明 |
|-------------|-------------|
| `<dorado-management-ip>` | Dorado 管理平面地址 |
| `<iscsi-portal-ip>` | iSCSI 数据平面 portal 地址 |
| `<nfs-portal-ip>` | NFS 数据平面 portal 地址 |
| `<registry>` | 集群镜像仓库地址 |
| `<pool-name>` | OceanStor 存储池名称 |

## 解决方案

### 1. 准备集群节点

#### 1.1 验证网络连通性

所有集群节点（包括 master 和 worker）都必须能访问存储的管理平面和数据平面：

| 用途 | 地址 | 说明 |
|---------|---------|-------------|
| Dorado 管理平面 | `<dorado-management-ip>:8088` | CSI 通过此地址管理存储 |
| iSCSI 数据平面 | `<iscsi-portal-ip>` | iSCSI portal，业务 IO 路径 |
| NFS 数据平面 | `<nfs-portal-ip>` | NFS portal，业务 IO 路径 |

在每个节点上验证连通性：

```shell
ping <dorado-management-ip>
# ping 只能验证 ICMP 可达；还需确认管理 API 端口（8088）已开放
curl -k https://<dorado-management-ip>:8088
ping <iscsi-portal-ip>
ping <nfs-portal-ip>
```

#### 1.2 配置防火墙

Micro OS 默认保持 firewalld 和 SELinux 开启状态。必须放开 `huawei-csi-controller` 的 webhook 服务端口（4433/tcp）：

```shell
# 查看当前已放开的端口
firewall-cmd --list-ports

# 放开 4433/tcp（CSI webhook 端口）
firewall-cmd --zone=public --add-port=4433/tcp --permanent && firewall-cmd --reload

# 验证
firewall-cmd --list-ports
```

#### 1.3 确认主机软件依赖

根据计划使用的协议，在**所有节点**上确认以下服务运行正常：

**iSCSI 协议（使用 iSCSI 时必须）：**

```shell
systemctl status iscsi iscsid
# 如未启动：
systemctl enable iscsi iscsid --now
```

**NFS 协议（使用 NFS 时必须）：**

```shell
systemctl status rpcbind
# 如未启动：
systemctl enable rpcbind --now
```

**DM-Multipath（使用 iSCSI/FC 时必须）：**

```shell
systemctl status multipathd.socket multipathd
# 如未启动：
systemctl enable multipathd --now
```

#### 1.4 配置 multipath

确认 `/etc/multipath.conf` 包含以下配置。若文件不存在，则按此内容创建：

```text
defaults {
        user_friendly_names yes
        find_multipaths no
}
```

### 2. 准备安装包和镜像

#### 2.1 上传镜像到仓库

在有容器运行时的节点上，将以下镜像包依次 load 并推送到集群镜像仓库：

```shell
# 加载镜像（将 <arch> 替换为节点架构，如 amd64 或 arm64）
docker load -i huawei-csi-v4.11.0-<arch>.tar
docker load -i storage-backend-controller-v4.11.0-<arch>.tar
docker load -i storage-backend-sidecar-v4.11.0-<arch>.tar
docker load -i huawei-csi-extender-v4.11.0-<arch>.tar

# 打 tag 并推送（每个镜像重复操作）
docker tag huawei-csi:4.11.0 <registry>/huawei-csi:4.11.0
docker push <registry>/huawei-csi:4.11.0
```

#### 2.2 替换 YAML 中的镜像地址

CSI 软件包中的 YAML 文件默认引用官方镜像地址，需替换为你的集群镜像仓库地址。进入 `manual/esdk/deploy/` 目录执行：

```shell
# 先查看当前镜像引用，确定默认的 registry 前缀
grep 'image:' *.yaml

# 将默认前缀替换为你的集群仓库地址。
# 将 <default-registry-address> 设为上面 grep 出的前缀（即 /huawei-csi 之前的部分）。
# 这里使用 '#' 作为分隔符，因为仓库地址中包含 '/'。
sed -i 's#<default-registry-address>#<registry>#g' *.yaml

# 确认替换结果
grep 'image:' *.yaml
```

> **说明**：如果镜像 tag 后缀（commit hash）与实际推送的版本不符，同样用 `sed` 替换：
>
> ```shell
> sed -i 's/<旧tag后缀>/<新tag后缀>/g' *.yaml
> ```

### 3. 部署 CSI 组件

进入 `manual/esdk/` 目录，按以下顺序执行：

#### 3.1 创建 Namespace

```shell
kubectl create ns huawei-csi
```

#### 3.2 部署 Backend CRD

```shell
kubectl apply -f ./crds/backend/
```

#### 3.3 部署 Snapshot CRD（可选，Kubernetes v1.20+）

`--validate=false` 会跳过客户端侧的 schema 校验。这里需要它，是因为软件包内置的 snapshot CRD 清单所用的 snapshot API 版本可能与集群上的版本不一致。

```shell
kubectl apply -f ./crds/snapshot-crds/ --validate=false
```

#### 3.4 部署 CSIDriver

```shell
kubectl apply -f ./deploy/csidriver.yaml
```

#### 3.5 部署 Controller

```shell
kubectl apply -f ./deploy/huawei-csi-controller.yaml
```

#### 3.6 部署 Node

```shell
kubectl apply -f ./deploy/huawei-csi-node.yaml
```

#### 3.7 验证部署状态

```shell
kubectl get pod -n huawei-csi
```

所有 Pod 状态为 `Running` 即部署成功。

### 4. 配置存储后端（Backend）

使用 `oceanctl` 工具创建 backend，该工具位于 CSI 软件包的 `bin/` 目录。

#### 4.1 Backend 认证

无需手动创建凭据 Secret。执行 `oceanctl create backend`（即下文 4.2 和 4.3）时，它会交互式提示输入存储账号的用户名和密码，并自动在 `huawei-csi` 命名空间中创建对应的 Kubernetes Secret：

```text
Please enter this backend user name:
Please enter this backend password:
```

请使用对目标存储池有管理权限的 Dorado 账号。

#### 4.2 创建 iSCSI Backend

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

执行创建：

```shell
./bin/oceanctl create backend -f backend-blk.yaml -i yaml --log-dir /tmp/
```

#### 4.3 创建 NFS Backend

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

执行创建：

```shell
./bin/oceanctl create backend -f backend-nfs.yaml -i yaml --log-dir /tmp/
```

#### 4.4 验证 Backend 状态

```shell
./bin/oceanctl get backend -n huawei-csi
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

> **说明**：`authClient: "*"` 允许任意 NFS 客户端挂载该卷，便于验证。生产环境应将其限制为特定的客户端 IP 或 CIDR 段（例如 `192.0.2.0/24`）。

### 6. 验证

创建测试 PVC，验证存储对接是否正常：

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

PVC 状态变为 `Bound` 即验证成功。

## 常见问题

### 创建 Backend 报 `context deadline exceeded`

**报错信息：**

```text
failed to configure the backend account. Error from server (InternalError): error when creating "STDIN": Internal error occurred: failed calling webhook "storage-backend-controller.xuanwu.huawei.io": failed to call webhook: Post "https://huawei-csi-controller.huawei-csi.svc:4433/storagebackendclaim?timeout=10s": context deadline exceeded
```

**原因分析：**

- 存储网络不通：CSI controller 无法连接 Dorado 管理地址或 portal。
- kube-apiserver 到 CSI webhook 的通信异常（例如被 HTTPS 代理拦截）。

**排查步骤：**

1. 检查 controller 日志：

   ```shell
   # 查看 controller pod 名称
   kubectl get pod -n huawei-csi

   # 查看日志文件（在 controller 所在节点）
   tail -f /var/log/huawei/storage-backend-controller/*.log
   ```

2. 确认节点可达 Dorado 管理地址：

   ```shell
   ping <dorado-management-ip>
   curl -k https://<dorado-management-ip>:8088
   ```

3. 确认防火墙已放开 4433 端口（见 1.2 节）。

**临时解决方案：**

如排查无果，可尝试重启 CSI controller pod：

```shell
kubectl delete pod -n huawei-csi -l app=huawei-csi-controller
```

或者，作为最后手段，临时删除 webhook（删除后 backend 创建不再做合法性校验）。webhook 会在 controller 重启后自动恢复：

> **警告**：删除 webhook 会关闭后端配置校验。仅在非生产环境的排障场景下使用，并在排障后立即重启 controller 恢复校验。

```shell
kubectl delete validatingwebhookconfiguration storage-backend-controller.xuanwu.huawei.io
# 重启 controller 以恢复 webhook
kubectl delete pod -n huawei-csi -l app=huawei-csi-controller
```

### Pod 无法以非 root 用户访问挂载卷（fsPermission / fsGroup 问题）

Pod 使用 `securityContext` 指定非 root 用户（例如 `runAsUser: 1000`）时，可能遇到卷目录权限不足的问题。有以下三种解决方案：

**方案一：在 StorageClass 中设置 fsPermission**

适用于在开发或测试环境中快速放开权限：

```yaml
parameters:
  fsPermission: "777"
```

> **警告**：`fsPermission: "777"` 会向节点上所有用户开放完整的读/写/执行权限。生产环境请勿使用，应优先选择方案二或方案三中基于 `fsGroup` 的做法。

**方案二：StorageClass 显式指定 fsType + PVC 使用 ReadWriteOnce**

在 StorageClass 中显式指定 `fsType`，并将 PVC 的 `accessMode` 设为 `ReadWriteOnce`，此时 Pod `securityContext` 中的 `fsGroup` 才会生效：

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

**方案三：部署前修改 CSIDriver 的 fsGroupPolicy**

在安装 CSI 前，修改 `csidriver.yaml` 中的 CSIDriverObject 配置：

```yaml
# 在 deploy/csidriver.yaml 中设置
spec:
  fsGroupPolicy: File
```

部署后，Pod `securityContext.fsGroup` 即可生效：

```yaml
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
```
