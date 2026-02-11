---
products:
   - Alauda Container Platform
kind:
   - Solution
ProductsVersion:
   - 4.1,4.2
id: KB260200006
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

The cleanup process consists of three main parts:

1. **Clean up Image Registry**: Back up MinIO data, record installed plugins/Operators, and clear registry storage
2. **Restore ACP Core Images**: Re-upload ACP Core images and verify functionality
3. **Restore Cluster Plugins and Operator Images**: Prepare packages, re-upload, and verify

---

## Part 1: Clean up Image Registry

### Backup MinIO Data

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

### Get Installed Operators

Before clearing the registry, record all installed Operators. Execute the following command on the global cluster to list all Operators installed across clusters:

```bash
kubectl get operatorviews -A   -o custom-columns='CLUSTER:.metadata.namespace,NAME:.metadata.name,PHASE:.status.operatorStatus.phase,ARTIFACT:.status.operatorStatus.installation.artifactName,INSTALLED_CSV:.status.operatorStatus.installation.subscription.installedCSV,DISPLAY_NAME:.status.packageManifestStatus.channels[0].currentCSVDesc.displayName' | awk 'NR==1 || ($3 == "Installed")'  
```

**Output Example**:

```text
CLUSTER      NAME                             PHASE       ARTIFACT                 INSTALLED_CSV                                        DISPLAY_NAME
global       clickhouse-operator              Installed   clickhouse-operator      clickhouse-operator.v4.2.0                           ClickHouse
global       envoy-gateway-operator           Installed   envoy-gateway-operator   envoy-gateway-operator.v1.5.0-build.20251226181113   Alauda build of Envoy Gateway
global       rds-operator                     Installed   rds-operator             rds-operator.v4.2.2                                  Alauda Container Platform Data Services RDS Framework
```

**Field Descriptions**:
- **CLUSTER**: Cluster name
- **NAME**: Operator name
- **PHASE**: Operator phase (should be "Installed")
- **ARTIFACT**: Artifact resource name corresponding to the Operator
- **INSTALLED_CSV**: Installed CSV version (Note: This field may be empty if Operator creation failed or waiting for approval)
- **DISPLAY_NAME**: Display name

### Get Installed Cluster Plugins

Execute the following command on the global cluster to list all aligned/agnostic cluster plugins installed across clusters:

```bash
kubectl get modulepluginview -o go-template='{{-
printf "%-40s %-10s %-40s %s\n" "MODULE" "LIFECYCLE" "INSTALLED(CLUSTER:VERSION)" "DISPLAY_NAME"
-}}{{- range .items }}
{{- $module := index .metadata.labels "cpaas.io/module-name" -}}
{{- $displayName := index .metadata.annotations "cpaas.io/display-name" -}}

{{- $lifecycle := index .metadata.labels "cpaas.io/lifecycle-type" -}}
{{- if or (not $lifecycle) (eq $lifecycle "") -}}
{{- $lifecycle = "agnostic" -}}
{{- end -}}
 
{{- if or (eq $lifecycle "agnostic") (eq $lifecycle "aligned") -}}
  {{- $installed := "" -}}
  {{- range $i, $ins := .status.installed -}}
    {{- if $i -}}
      {{- $installed = printf "%s, %s:%s" $installed $ins.cluster $ins.version -}}
    {{- else -}}
      {{- $installed = printf "%s:%s" $ins.cluster $ins.version -}}
    {{- end -}}
  {{- end -}}
{{- printf "%-40s %-10s %-40s %-40s" $module $lifecycle $installed $displayName -}}
{{ "\n" -}}
{{- end -}}
{{- end -}}'
```

**Output Example**:

```text
MODULE                                   LIFECYCLE  INSTALLED(CLUSTER:VERSION)               DISPLAY_NAME
aml-global                               agnostic                                            {"en": "Alauda AI Essentials", "zh": "Alauda AI Essentials"}
application-services-core                agnostic                                            {"en": "Alauda Container Platform Data Services Essentials", "zh": "Alauda Container Platform Data Services Essentials"}
argo-rollouts                            aligned                                             {"en": "Alauda Build of Argo Rollouts", "zh": "Alauda Build of Argo Rollouts"}
argocd                                   agnostic                                            {"en": "Alauda Container Platform GitOps", "zh": "Alauda Container Platform GitOps"}
asm-global                               aligned                                             {"en": "Alauda Service Mesh Essentials", "zh": "Alauda Service Mesh Essentials"}
capi-provider-aws                        agnostic   global:v4.0.10                           {"en": "Alauda Container Platform EKS Provider", "zh": "Alauda Container Platform EKS Provider"}
capi-provider-azure                      agnostic   global:v4.0.8                            {"en": "Alauda Container Platform AKS Provider", "zh": "Alauda Container Platform AKS Provider"}
capi-provider-cce                        agnostic   global:v4.0.10                           {"en": "Alauda Container Platform CCE Provider", "zh": "Alauda Container Platform CCE Provider"}
capi-provider-gcp                        agnostic   global:v4.0.8                            {"en": "Alauda Container Platform GKE Provider", "zh": "Alauda Container  ...
```

**Field Descriptions**:
- **MODULE**: Cluster plugin name
- **LIFECYCLE**: Cluster plugin type (core, aligned, or agnostic)
- **INSTALLED(CLUSTER:VERSION)**: Lists plugin installation status across clusters in `<cluster>:<version>` or `<cluster>:<version>, <cluster>: <version>` format
- **DISPLAY_NAME**: Display name

**Important**: This recording must be completed before clearing the registry to avoid plugin status issues due to missing images.

### Clear Registry Data

Enter any control plane node of the global cluster and execute the cleanup command within the MinIO container:

```bash
# Access the MinIO container in kube-system namespace
# Execute the cleanup command to clear the registry bucket
kubectl exec -it -n kube-system <minio-pod> -- sh -c '
  source /etc/config/minio.env && \
    mc --insecure alias set minio https://127.0.0.1:9000 $MINIO_ACCESS_KEY $MINIO_SECRET_KEY && \
    mc --insecure rm --recursive --force minio/registry/
'
```

**Warning**: This operation will **permanently delete** all images in the registry. Ensure that you have completed the backup step.

---

## Part 2: Restore ACP Core Images

### Re-upload ACP Core Images

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

### Test Core Image Pull

After completing the re-upload process, verify that ACP Core images can be successfully pulled:

```bash
# Test pulling a core platform image
nerdctl pull ${REGISTRY}/acp/core:latest

# Verify image pull success
nerdctl images | grep ${REGISTRY}
```

---

## Part 3: Restore Cluster Plugins and Operator Images

### Prepare Operator and Cluster Plugin Installation Packages

Based on the recorded Operators and cluster plugins from Part 1, prepare the corresponding installation packages:

1. Ensure you have installation packages for all recorded Operators and cluster plugins
2. Verify that package versions match the installed versions recorded in Part 1
3. Place the installation packages in an accessible location for upload

### Re-upload Cluster Plugins and Operators

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
for i in "$plugin_dir"/*; do
  [ -e "$i" ] || continue
  i=$(basename "$i")
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

### Test Plugin and Operator Image Pull

After completing the re-upload process, verify that plugin and Operator images can be successfully pulled:

```bash
# Test pulling a plugin image (replace with actual plugin name and version)
nerdctl pull ${REGISTRY}/acp/plugin-name:version

# Test pulling an Operator image (replace with actual Operator name and version)
nerdctl pull ${REGISTRY}/operator-name:version

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
