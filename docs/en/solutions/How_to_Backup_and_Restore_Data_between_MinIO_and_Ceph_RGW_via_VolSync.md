---
kind:
   - How To
products: 
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
<!-- Document is a solutions by explaining how to perform a specific task or achieve a goal -->
# [How to] Backup and Restore Data between MinIO and Ceph RGW via VolSync

## Purpose

This manual describes how to perform S3-to-S3 data synchronization between MinIO and Ceph RGW using the `rclone` tool built into the VolSync image. This solution has been verified in the ACP environment and is suitable for data backup, cross-storage migration, and disaster recovery.

## Resolution

### 1. Overview
The solution utilizes the `rclone` tool integrated in the VolSync Operator image to perform S3 protocol data synchronization via Kubernetes Jobs. It supports both full and incremental synchronization.

**Note**: This is **not** PVC-based replication (ReplicationSource/Destination), but direct data transfer at the object storage protocol layer (S3-to-S3).

### 2. Use Cases
- **Data Backup**: Periodically backup object data from MinIO to Ceph RGW.
- **Data Migration**: Move business data from MinIO to Ceph RGW or vice-versa.
- **Disaster Recovery**: Recover data from Ceph RGW in case of MinIO failure.

### 3. Prerequisites
- VolSync Operator installed in the cluster.
- `kubectl` access and network connectivity from Job Pods to both MinIO and Ceph RGW endpoints.
- MinIO and Ceph RGW credentials (Access Key / Secret Key).
- **The target Ceph RGW must be dedicated for this migration and should be empty before the first full synchronization.**

### 4. Environment Preparation
Export the following variables based on your environment:
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

### 5. Setup
Create a dedicated user in the `rook-ceph` namespace and retrieve credentials:
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
Retrieve RGW credentials:
```bash
RGW_SECRET_NAME=$(kubectl -n rook-ceph get cephobjectstoreuser "${RGW_USER_NAME}" -o jsonpath='{.status.info.secretName}')
RGW_ACCESS_KEY=$(kubectl -n rook-ceph get secret "${RGW_SECRET_NAME}" -o jsonpath='{.data.AccessKey}' | base64 -d)
RGW_SECRET_KEY=$(kubectl -n rook-ceph get secret "${RGW_SECRET_NAME}" -o jsonpath='{.data.SecretKey}' | base64 -d)
export RGW_ACCESS_KEY RGW_SECRET_KEY
```

### 6. Backup Operation
#### 6.1 Create rclone Config Secret
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

#### 6.2 Execute Backup Job
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

### 7. Restore Operation
The restore process is the reverse of the backup process.
1. Create a Secret with `rclone.conf` containing `source-ceph` and `dest-minio`.
2. Run a Job with `rclone sync source-ceph: dest-minio:`.

### 8. Important Notes
- **Sync Risk**: `rclone sync` deletes files in the destination that are not present in the source.
- **Silence Writing**: Stop business writes before the final cutover.

## Related Information
- [VolSync Documentation](https://volsync.readthedocs.io/)
- [rclone S3 Documentation](https://rclone.org/s3/)
