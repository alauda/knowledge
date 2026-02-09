---
products:
   - Alauda Container Platform
kind:
   - Solution
ProductsVersion:
   - 4.2
   - 4.1
---

# How to clean up platform built-in Image Registry

## Issue

When using the platform's built-in image registry for installation, the number of images in the registry increases with each platform upgrade. After the upgrade, old version images are no longer needed but continue to occupy storage space, resulting in wasted storage resources.

## Environment

This solution is compatible with Alauda Container Platform (ACP) versions 4.1.x and 4.2.x.

## Resolution

### Background

The current platform does not support distinguishing between old and new image versions, and MinIO's garbage collection (GC) logic has certain limitations. This makes it impossible to selectively clean up unused images. Therefore, the recommended approach is to completely delete all images from MinIO and then re-upload the required images.

### Prerequisites

Before performing the cleanup operation, you must:

- **Record Cluster Plugins and Operators**: Document all cluster plugins and Operators currently installed on the platform
- **Backup Custom Images**: If you have stored non-platform images in the registry, back them up or record them separately for re-upload after cleanup
- **Schedule Maintenance Window**: This operation will temporarily affect platform image availability, so plan it during a maintenance window

### Overview

The cleanup process involves the following steps:

1. **Backup**: Back up the MinIO directory on all three control plane nodes of the global cluster
2. **Record**: Document all cluster plugins and Operators installed on the platform
3. **Clean Up**: Completely clear the registry storage in MinIO
4. **Re-upload Core Images**: Upload ACP Core images using the current installation package
5. **Re-upload Plugins**: Re-upload the recorded cluster plugins and Operators
6. **Verification**: Test image pull functionality

### Step 1: Backup MinIO Data

**CRITICAL**: Before performing any cleanup operations, you must back up the MinIO directory on all three control plane nodes of the global cluster.

Execute the backup command on each control plane node:

```bash
# Replace with the actual IP address of the current master node
ip=192.168.3.10

# Create a backup of the MinIO directory
tar -cvf ${ip}-minio.tar /cpaas/minio

# IMPORTANT: Verify that the backup file size matches the original directory size
ls -lh ${ip}-minio.tar
du -sh /cpaas/minio
```

**Important Notes**:
- Perform this backup on all three control plane nodes
- Verify the backup file size to ensure data integrity
- Store the backup files in a safe location

### Step 2: Record Cluster Plugins and Operators

Before clearing the registry, document all cluster plugins and Operators currently installed.

*Note: The R&D team will provide specific commands for recording cluster plugins and Operators. Please check with technical support for the latest recording procedures.*

### Step 3: Clear Registry Data

Enter any control plane node of the global cluster and execute the cleanup command within the registry MinIO container:

```bash
# Access the registry MinIO container (method may vary depending on deployment)
# Example using kubectl:
kubectl exec -it -n <registry-namespace> <registry-minio-pod> -- bash

# Execute the cleanup command to clear the registry bucket
source /etc/config/minio.env && \
  mc --insecure alias set minio https://127.0.0.1:9000 $MINIO_ACCESS_KEY $MINIO_SECRET_KEY && \
  mc --insecure rm --recursive --force minio/registry/
```

**Warning**: This operation will **permanently delete** all images in the registry. Ensure that you have completed the backup step.

### Step 4: Re-upload ACP Core Images

Prepare the ACP Core installation package and push the core images to the registry:

```bash
# Configure registry credentials
REGISTRY=example.registry.address:11440
USERNAME=exampleusername
PASSWORD=examplepassword

# Navigate to the installer directory
core_dir=/cpaas/installer
cd $core_dir

# Upload all core images
bash "res/upload.sh" "all" "${REGISTRY}" "${USERNAME}" "${PASSWORD}"

# Upload necessary core images
bash "res/upload.sh" "necessary" "${REGISTRY}" "${USERNAME}" "${PASSWORD}"
```

**Important**:
- Replace the placeholder values with your actual registry address and credentials
- Ensure the registry service is running and accessible
- Monitor the upload process for any errors

### Step 5: Re-upload Cluster Plugins and Operators

Prepare the extension package plugins and push them to the platform:

```bash
# Configure platform access credentials
Platform_URL="https://exampleaddress"
Platform_USER="exampleusername"
Platform_PASSWORD="examplepassword"

# Navigate to the plugins directory
plugin_dir="/cpaas/installer/plugins"
cd $plugin_dir

# Upload all plugins one by one
for i in `ls $plugin_dir`; do
  violet push $i \
    --platform-address $Platform_URL \
    --platform-username $Platform_USER \
    --platform-password $Platform_PASSWORD
done
```

**Important**:
- This step only uploads the plugin packages to the platform using `violet push`
- The plugins must be installed separately after upload is completed
- Verify that each plugin is successfully uploaded

### Step 6: Test Image Pull

After completing the re-upload process, verify that images can be successfully pulled:

```bash
# Test pulling a core platform image
nerdctl pull ${REGISTRY}/acp/core:latest

# Test pulling a plugin image (replace with actual plugin name and version)
nerdctl pull ${REGISTRY}/acp/plugin-name:version

# Verify image pull success
nerdctl images | grep ${REGISTRY}
```

### Additional Considerations

**For Custom Images**:

If you have stored custom or non-platform images in the registry:
- Ensure you have backed up these images before the cleanup
- Re-upload these custom images after completing the platform image re-upload
- Verify that custom applications can still pull the required images

**Contact Support**:

If you encounter any issues during the cleanup process, please contact technical support for assistance.
