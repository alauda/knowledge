---
products:
  - Alauda DevOps
kind:
  - Solution
id: KB1756983863-4270
sourceSHA: b4ae5bb0e1dff139d22ff571f8e757504b64c8c7d1329f61834fb2df191aced4
---

# Harbor 注册中心存储迁移：PVC 到 S3

## 问题

本指南提供了将 Harbor 注册中心数据从 PVC（持久卷声明）存储迁移到 S3 兼容存储的逐步说明。此迁移有助于提高可扩展性并减少存储管理开销。

## 环境

此解决方案与 Alauda Build 的 Harbor v2.12.z 兼容。

## 解决方案

### 先决条件

在开始迁移之前，请确保您已：

- **重要**：一个完全部署的 Harbor 实例，并启用了 `只读模式`。要启用只读模式，请导航至 Harbor 网页 `管理 → 配置 → 系统设置 → 存储库只读`。
- **重要**：由于在迁移期间需要将 Harbor 设置为只读模式，建议首先在测试环境中模拟此过程，评估迁移时间，并分配足够的维护窗口。
- 一个 S3 兼容的存储服务（MinIO、Ceph、AWS S3 等），并具有适当的访问凭证。
- 一个预先创建的 S3 存储桶，用于存储 Harbor 注册中心数据。
- 下载并同步 rclone 迁移工具镜像到您的内部注册中心，以便在后续步骤中使用：

```txt
# 中国地区下载链接
https://cloud.alauda.cn/attachments/knowledge/337969938/rclone-amd64.tgz
https://cloud.alauda.cn/attachments/knowledge/337969938/rclone-arm64.tgz

# 其他地区下载链接
https://cloud.alauda.io/attachments/knowledge/337969938/rclone-amd64.tgz
https://cloud.alauda.io/attachments/knowledge/337969938/rclone-arm64.tgz
```

### S3 区域配置

#### 如何确定正确的区域

请参考您的 S3 提供商的官方文档，以确定您特定服务的正确区域。大多数提供商会在其控制台、监控面板或文档中提供此信息。

### 迁移过程

#### 将注册中心数据迁移到 S3

本节描述如何使用 rclone 将现有的 Harbor 注册中心数据从 PVC 迁移到 S3 存储。迁移过程包括：

1. **数据同步**：将所有注册中心数据从 PVC 复制到 S3
2. **数据验证**：验证迁移数据的完整性

执行以下脚本以执行迁移：

```bash
export S3_HOST=http://xxxxx:xxx # S3 存储端点
export S3_PROVIDER=Minio # 根据 S3 类型进行配置。支持的提供商：Minio、Ceph、AWS 等。参考：https://rclone.org/docs/#configure
export S3_KEY_ID=xxxx
export S3_ACCESS_KEY=xxxxx
export S3_BUCKET=harbor # 请提前在 S3 中创建此存储桶
export S3_REGION=us-east-1 # 如果 S3 没有区域，则不需要此项。如果存在，请配置并在下面的配置中添加 region = $S3_REGION
export SYNC_IMAGE=rclone/rclone:1.71.0 # 替换为您的内部注册中心镜像
export HARBOR_REGISTRY_PVC=xxxxx
export HARBOR_NS=xxxxx

cat>sync-and-check-s3.yaml<<EOF
apiVersion: v1
data:
  rclone.conf: |-
    [harbor-s3]
    type = s3
    provider = $S3_PROVIDER
    env_auth = false
    access_key_id = $S3_KEY_ID
    secret_access_key = $S3_ACCESS_KEY
    endpoint = $S3_HOST
    acl = private
    # 如果您的 S3 服务需要，请添加区域配置
    # region = $S3_REGION
kind: ConfigMap
metadata:
  name: s3-config
  namespace: $HARBOR_NS
---
apiVersion: batch/v1
kind: Job
metadata:
  name: sync-and-check-s3
  namespace: $HARBOR_NS
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      initContainers:
        # 步骤 1：同步数据到 S3
        - image: $SYNC_IMAGE
          imagePullPolicy: IfNotPresent
          name: sync-data
          args:
            - sync
            - /data
            - harbor-s3:$S3_BUCKET
            - --progress
          resources:
            limits:
              cpu: 4
              memory: 4Gi
            requests:
              cpu: 1
              memory: 1Gi
          volumeMounts:
            - mountPath: /root/.config/rclone/
              name: rclone-config
            - mountPath: /data
              name: data
      containers:
        # 步骤 2：检查/验证同步
        - image: $SYNC_IMAGE
          imagePullPolicy: IfNotPresent
          name: check-sync
          args:
            - check
            - /data
            - harbor-s3:$S3_BUCKET
            - --one-way
            - --progress
          resources:
            limits:
              cpu: 4
              memory: 4Gi
            requests:
              cpu: 1
              memory: 1Gi
          volumeMounts:
            - mountPath: /root/.config/rclone/
              name: rclone-config
            - mountPath: /data
              name: data
      volumes:
        - configMap:
            name: s3-config
          name: rclone-config
        - name: data
          persistentVolumeClaim:
            claimName: $HARBOR_REGISTRY_PVC
EOF

kubectl apply -f sync-and-check-s3.yaml
```

#### 迁移验证

监控迁移进度（可选）

```bash
kubectl logs -n $HARBOR_NS -l job-name=sync-and-check-s3 -c sync-data -f
```

日志中包含 "0 differences found" 表示同步成功。

```bash
export HARBOR_NS=xxxxx
kubectl logs -n $HARBOR_NS -l job-name=sync-and-check-s3 |  grep "0 differences found"
Defaulted container "check-sync" out of: check-sync, sync-data (init)
2025/09/01 07:30:12 NOTICE: S3 bucket harbor: 0 differences found
```

#### 更新 Harbor 配置以使用 S3 存储

在成功迁移数据后，更新 Harbor 配置以使用 S3 存储而不是 PVC。此步骤配置 Harbor 直接从/向 S3 存储桶读取和写入注册中心数据。

创建一个包含 S3 访问凭证的 Kubernetes Secret。该 Secret 必须包含 Harbor 注册中心所需的以下密钥：

- `REGISTRY_STORAGE_S3_ACCESSKEY`: Base64 编码的 S3 访问密钥
- `REGISTRY_STORAGE_S3_SECRETKEY`: Base64 编码的 S3 秘密密钥

```yaml
apiVersion: v1
data:
  REGISTRY_STORAGE_S3_ACCESSKEY: <base64-encoded-access-key>
  REGISTRY_STORAGE_S3_SECRETKEY: <base64-encoded-secret-key>
kind: Secret
metadata:
  name: s3-secret
  namespace: <harbor-namespace>  # 替换为您的 Harbor 命名空间
type: Opaque
```

将以下内容添加到 Harbor 资源中（请注意，除了注册中心的存储配置外，其他配置必须保留）：

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: Harbor
metadata:
  name: harbor
spec:
  helmValues:
    persistence:
       enabled: true
# 添加以下内容 
       imageChartStorage:
         disableredirect: true
         s3:
           existingSecret: s3-secret # S3 访问密钥和秘密密钥的 Secret
           bucket: harbor # 在 S3 集群中创建的存储桶
           region: us-east-1 # S3 区域（AWS S3 必需，MinIO/Ceph 可选）
           regionendpoint: http://xxxxx # S3 集群访问地址，请注意必须包含访问端口
           v4auth: true
         type: s3
# END
```

### 验证和测试

完成配置更新后，通过测试 Harbor 功能验证迁移是否成功：

1. **测试 Docker 操作**：在本地登录到 Harbor，并验证 docker push/pull 操作是否正常工作
2. **检查存储**：确认新镜像是否存储在 S3 存储桶中
3. **验证现有镜像**：确保之前迁移的镜像仍然可以成功拉取
