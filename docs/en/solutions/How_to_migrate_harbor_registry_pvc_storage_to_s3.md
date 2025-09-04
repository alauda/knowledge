---
products:
   - Alauda DevOps
kind:
   - Solution
---

# How to Migrate Harbor Registry PVC Storage to S3

## Issue

This guide provides step-by-step instructions for migrating Harbor registry data from PVC (Persistent Volume Claim) storage to S3-compatible storage. This migration helps improve scalability and reduces storage management overhead.

## Environment

This solution is compatible with Alauda Build of Harbor v2.12.z.

## Resolution

### Prerequisites

Before starting the migration, ensure you have:

- **Important**: A fully deployed Harbor instance with `read-only mode` enabled. To enable read-only mode, Navigate to `Administration → Configuration → System Settings → Repository Read Only`.
- **Important**: Since Harbor needs to be set to read-only mode during migration, it's recommended to simulate this process in a test environment first, evaluate the migration time, and allocate sufficient maintenance window.
- An S3-compatible storage service (MinIO, Ceph, AWS S3, etc.) with appropriate access credentials
- A pre-created S3 bucket for storing Harbor registry data
- Ensure sufficient resources are available in the cluster where Harbor is deployed.
- The rclone migration tool image synced to your internal registry:

```txt
# Download URL for China Region
https://cloud.alauda.cn/attachments/knowledge/337969938/rclone-amd64.tgz
https://cloud.alauda.cn/attachments/knowledge/337969938/rclone-arm64.tgz

# Download URLs for Other Regions
https://cloud.alauda.io/attachments/knowledge/337969545/rclone-amd64.tgz
https://cloud.alauda.io/attachments/knowledge/337969545/rclone-arm64.tgz
```

### S3 Region Configuration

#### How to Determine the Correct Region

Please refer to your S3 provider's official documentation to determine the correct region for your specific service. Most providers will have this information available in their console, dashboard, or documentation.

#### Region Configuration in Migration Script

In the migration script, the region is configured via the `S3_REGION` environment variable:

```bash
export S3_REGION=us-east-1  # Set your actual region here
```

**Important Notes:**

- If your S3 service doesn't use regions, you can leave this variable empty
- If your S3 service requires a region, you must set the correct value
- Incorrect region configuration may cause authentication or connection failures

### Migration Process

#### Migrate Registry Data to S3

This section describes how to migrate existing Harbor registry data from PVC to S3 storage using rclone. The migration process includes:

1. **Data Synchronization**: Copy all registry data from PVC to S3
2. **Data Verification**: Verify the integrity of migrated data

Execute the following script to perform the migration:

```bash
export S3_HOST=http://xxxxx:xxx # S3 storage endpoint
export S3_PROVIDER=Minio # Configure based on S3 type. Supported providers: Minio, Ceph, AWS, etc. Refer to: https://rclone.org/docs/#configure
export S3_KEY_ID=xxxx
export S3_ACCESS_KEY=xxxxx
export S3_BUCKET=harbor # Create this bucket in S3 beforehand
export S3_REGION=us-east-1 # If S3 doesn't have regions, this is not needed. If it exists, configure it and add region = $S3_REGION in the config below
export SYNC_IMAGE=rclone/rclone:1.71.0 # Replace with your internal registry image
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
    # Add region configuration if your S3 service requires it
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
        # Step 1: Sync data to S3
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
        # Step 2: Check/verify the sync
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

# Monitor the migration progress
kubectl logs -n $HARBOR_NS -l job-name=sync-and-check-s3 -c sync-data -f
```

> **Note**: The migration job uses two containers:
>
> - `sync-data` (init container): Performs the actual data synchronization
> - `check-sync` (main container): Verifies data integrity after synchronization

#### Verify Migration Success

The log containing "0 differences found" indicates successful synchronization.

```bash
export HARBOR_NS=xxxxx
kubectl logs -n $HARBOR_NS -l job-name=sync-and-check-s3 |  grep "0 differences found"
Defaulted container "check-sync" out of: check-sync, sync-data (init)
2025/09/01 07:30:12 NOTICE: S3 bucket harbor: 0 differences found
```

#### Update Harbor Configuration to Use S3 Storage

After successfully migrating the data, update the Harbor configuration to use S3 storage instead of PVC. This step configures Harbor to read and write registry data directly from/to the S3 bucket.

Create a Kubernetes Secret containing S3 access credentials. The secret must include the following keys that Harbor registry expects:

- `REGISTRY_STORAGE_S3_ACCESSKEY`: Base64-encoded S3 access key
- `REGISTRY_STORAGE_S3_SECRETKEY`: Base64-encoded S3 secret key

```yaml
apiVersion: v1
data:
  REGISTRY_STORAGE_S3_ACCESSKEY: <base64-encoded-access-key>
  REGISTRY_STORAGE_S3_SECRETKEY: <base64-encoded-secret-key>
kind: Secret
metadata:
  name: s3-secret
  namespace: <harbor-namespace>  # Replace with your Harbor namespace
type: Opaque
```

Add the following content to the Harbor resource (note that storage configurations other than registry must be preserved):

```yaml
apiVersion: operator.alaudadevops.io/v1alpha1
kind: Harbor
metadata:
  name: harbor
spec:
  helmValues:
    persistence:
       enabled: true
+      imageChartStorage:
+        disableredirect: true
+        s3:
+          existingSecret: s3-secret # an secret for S3 accesskey and secretkey
+          bucket: harbor # Storage bucket created in S3 cluster
+          region: us-east-1 # S3 region (required for AWS S3, optional for MinIO/Ceph)
+          regionendpoint: http://xxxxx # S3 cluster access address, note that the access port must be included
+          v4auth: true
+        type: s3
```

### Verification and Testing

After completing the configuration update, verify that the migration was successful by testing Harbor functionality:

1. **Test Docker Operations**: Log in to Harbor locally and verify that docker push/pull operations work correctly
2. **Check Storage**: Confirm that new images are being stored in the S3 bucket
3. **Verify Existing Images**: Ensure that previously migrated images can still be pulled successfully

## Troubleshooting

### Common Issues and Solutions

If you encounter issues during the migration:

- **S3 Connection Errors**: Check Harbor pod logs for any S3 connection errors
- **Authentication Issues**: Verify S3 credentials and bucket permissions
- **Network Connectivity**: Ensure the S3 endpoint is accessible from the Harbor cluster
- **Data Integrity**: Review the migration job logs for any data integrity issues
- **Upload Failures**: If upload fails, you can delete the job and recreate it. rclone will detect already transferred content and only transfer missing parts.
