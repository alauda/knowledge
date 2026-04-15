---
kind:
  - How To
id: ''
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.x, 4.2.x, 4.3.x'
sourceSHA: a1e2182dd8ea70a4d95ff58f5858c90e6376b74ab6e7c3e9a86a24b835f8b691
---

# \[如何\] 通过 VolSync 在 MinIO 和 Ceph RGW 之间备份和恢复数据

## 目的

本手册描述了如何使用 VolSync 镜像中内置的 `rclone` 工具在 MinIO 和 Ceph RGW 之间执行 S3 到 S3 的数据同步。该解决方案已在 ACP 环境中验证，适用于数据备份、跨存储迁移和灾难恢复。

## 解决方案

### 1. 概述

该解决方案利用集成在 VolSync Operator 镜像中的 `rclone` 工具，通过 Kubernetes Jobs 执行 S3 协议的数据同步。它支持全量和增量同步。

**注意**：这不是基于 PVC 的复制（ReplicationSource/Destination），而是在对象存储协议层（S3 到 S3）进行的直接数据传输。

### 2. 用例

- **数据备份**：定期将对象数据从 MinIO 备份到 Ceph RGW。
- **数据迁移**：将业务数据从 MinIO 移动到 Ceph RGW 或反之亦然。
- **灾难恢复**：在 MinIO 故障的情况下，从 Ceph RGW 恢复数据。

### 3. 先决条件

- 集群中已安装 VolSync Operator。
- 确保 VolSync Operator 和 VolSync Job 镜像版本一致（Job 镜像版本必须与已部署的 Operator 版本匹配）。
- `kubectl` 访问权限以及 Job Pods 与 MinIO 和 Ceph RGW 端点之间的网络连接。
- MinIO 和 Ceph RGW 凭证（Access Key / Secret Key）。
- **目标 Ceph RGW 必须专用于此迁移，并且在第一次全量同步之前应为空。**

### 4. 环境准备

根据您的环境导出以下变量：

```bash
export CEPH_OBJECT_STORE_NAME="<CEPH_OBJECT_STORE_NAME>"
export RGW_USER_NAME="<RGW_USER_NAME>"
export WORK_NAMESPACE="<WORK_NAMESPACE>"
export MINIO_ENDPOINT="<MINIO_ENDPOINT>"
export RGW_ENDPOINT="<RGW_ENDPOINT>"
export OPERATOR_VERSION="<OPERATOR_VERSION>"
export VOLSYNC_IMAGE="build-harbor.alauda.cn/acp/volsync:${OPERATOR_VERSION}"
export MINIO_ACCESS_KEY="<MINIO_ACCESS_KEY>"
export MINIO_SECRET_KEY="<MINIO_SECRET_KEY>"
```

### 5. 设置

在 `rook-ceph` 命名空间中创建一个专用用户并获取凭证：

```yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata:
  name: <RGW_USER_NAME>
  namespace: rook-ceph
spec:
  store: <CEPH_OBJECT_STORE_NAME>
  displayName: "VolSync 备份用户"
  capabilities:
    bucket: "*"
```

获取 RGW 凭证：

```bash
RGW_SECRET_NAME=$(kubectl -n rook-ceph get cephobjectstoreuser "${RGW_USER_NAME}" -o jsonpath='{.status.info.secretName}')
RGW_ACCESS_KEY=$(kubectl -n rook-ceph get secret "${RGW_SECRET_NAME}" -o jsonpath='{.data.AccessKey}' | base64 -d)
RGW_SECRET_KEY=$(kubectl -n rook-ceph get secret "${RGW_SECRET_NAME}" -o jsonpath='{.data.SecretKey}' | base64 -d)
export RGW_ACCESS_KEY RGW_SECRET_KEY
```

### 6. 备份操作

#### 6.1 创建 rclone 配置 Secret

```bash
kubectl create namespace "${WORK_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: volsync-rclone-backup-config
  namespace: ${WORK_NAMESPACE}
type: Opaque
stringData:
  rclone.conf: |
    [source-minio]
    type = s3
    provider = Minio
    access_key_id = ${MINIO_ACCESS_KEY}
    secret_access_key = ${MINIO_SECRET_KEY}
    endpoint = ${MINIO_ENDPOINT}
    # 不安全：仅在具有自签名证书的内部环境中使用。
    no_check_certificate = true

    [dest-ceph]
    type = s3
    provider = Ceph
    access_key_id = ${RGW_ACCESS_KEY}
    secret_access_key = ${RGW_SECRET_KEY}
    endpoint = ${RGW_ENDPOINT}
    list_version = 2
EOF
```

#### 6.2 执行备份 Job

```bash
kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: minio-to-ceph-backup
  namespace: ${WORK_NAMESPACE}
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: rclone
          image: ${VOLSYNC_IMAGE}
          command: ["rclone"]
          args: ["sync", "source-minio:", "dest-ceph:", "--progress", "--fast-list", "--metadata"]
          env:
            - name: RCLONE_CONFIG
              value: "/config/rclone.conf"
          volumeMounts:
            - name: config-volume
              mountPath: /config
              readOnly: true
      volumes:
        - name: config-volume
          secret:
            secretName: volsync-rclone-backup-config
EOF
```

### 7. 恢复操作

恢复过程是备份过程的反向操作。

1. 创建一个包含 `source-ceph` 和 `dest-minio` 的 Secret，内含 `rclone.conf`。注意：如果使用 `no_check_certificate = true`，请应用与备份配置相同的 SSL 安全警告。
2. 运行一个 Job，使用 `rclone sync source-ceph: dest-minio:`。

### 8. 重要说明

- **同步风险**：`rclone sync` 会删除目标中不存在于源中的文件。
- **停止写入**：在最终切换之前停止所有业务写入。
- **安全性**：禁用 TLS 验证（`no_check_certificate = true`）会使连接暴露于中间人攻击。这仅在具有自签名证书的内部/测试环境中可接受。对于生产环境，请使用 `ca_cert` 选项提供有效的 CA 包。

## 相关信息

- [VolSync 文档](https://volsync.readthedocs.io/)
- [rclone S3 文档](https://rclone.org/s3/)
