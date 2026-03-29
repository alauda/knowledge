---
kind:
   - How To
id: ""
products: 
   - Alauda Container Platform
ProductsVersion:
   - 4.1.x, 4.2.x, 4.3.x
---
<!-- Document is a solutions by explaining how to perform a specific task or achieve a goal -->
# [How to] 基于 VolSync 实现 MinIO 到 Ceph RGW 的数据备份与恢复

## Purpose

本手册详细介绍了如何使用 VolSync 镜像内置的 `rclone` 工具，在 MinIO 与 Ceph RGW 之间进行 S3 到 S3 的数据同步。本方案已在 ACP 环境中完成全流程验证，适用于数据备份、跨存储迁移及灾难恢复场景。

## Resolution

### 1. 概述
本方案利用 VolSync Operator 镜像中集成的 `rclone` 工具，通过 Kubernetes Job 执行 S3 协议的数据同步。该方法支持全量同步与增量同步。

**注意**：本方案**不是**基于 PVC 的复制（ReplicationSource/Destination），而是直接在对象存储协议层（S3-to-S3）进行数据传输。

### 2. 适用场景
- **数据备份**：定期将 MinIO 中的对象数据备份至 Ceph RGW。
- **数据迁移**：将业务数据从 MinIO 迁移到 Ceph RGW，或反向回迁。
- **灾难恢复**：在 MinIO 发生故障时，从 Ceph RGW 恢复数据。

### 3. 前提条件
- 集群已安装 VolSync Operator，且迁移 Job 使用的镜像版本必须与当前 Operator 版本一致。
- 具备 `kubectl` 权限且 Job Pod 能够同时访问 MinIO 和 Ceph RGW 的网络端点。
- 已收集 MinIO 源端的访问地址及具备 `Read/List` 权限的 Access Key / Secret Key。
- **目标 Ceph RGW 必须是本次迁移专用环境，且首次执行全量迁移前应为空**。

### 4. 环境准备
建议在执行本文档命令前，先按客户环境导出以下变量：
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

### 5. 备份前准备
在 `rook-ceph` 命名空间下创建专用用户并动态获取凭证：
```yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata:
  name: <RGW_USER_NAME>
  namespace: rook-ceph
spec:
  store: <CEPH_OBJECT_STORE_NAME>
  displayName: "VolSync Backup User"
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

### 6. 数据备份操作
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
    # 仅在内网受控、使用自签名证书时启用；生产环境建议配置受信任证书并关闭该选项
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

### 7. 数据恢复操作
恢复过程即备份过程的逆向操作，只需交换源和目标。
1. 创建包含 `source-ceph` 和 `dest-minio` 的 `rclone.conf` Secret。注意：如果使用 `no_check_certificate = true`，请参考备份配置中的安全提示。
2. 执行 `rclone sync source-ceph: dest-minio:` 任务。

### 8. 注意事项
- **Sync 风险**：`rclone sync` 会删除目标端中源端不存在的文件。
- **写入静默**：迁移切换前请停止业务写入。
- **证书校验风险**：若启用 `no_check_certificate = true`，将跳过 TLS 证书校验，存在中间人攻击风险；生产环境请优先使用可信 CA 证书并关闭该选项。

## Related Information
- [VolSync 官方文档](https://volsync.readthedocs.io/)
- [rclone 官方文档](https://rclone.org/s3/)
