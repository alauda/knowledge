---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2'
id: KB260200006
sourceSHA: 3eb5e699721b27d0f26bc8d29ed3f5c6dc8fdbed6d09c6a05e727284bd76de1e
---

# 如何清理平台内置的镜像注册表

## 问题

在使用平台内置的镜像注册表进行安装时，注册表中的镜像数量会随着每次平台升级而增加。升级后，旧版本的镜像不再需要，但仍然占用存储空间，导致存储资源的浪费。

## 环境

此解决方案与 Alauda Container Platform (ACP) 版本 4.1.x 和 4.2.x 兼容。

## 解决方案

### 背景

当前平台不支持区分旧版和新版镜像，MinIO 的垃圾回收 (GC) 逻辑存在一定的限制。这使得无法选择性地清理未使用的镜像。因此，推荐的方法是完全删除 MinIO 中的所有镜像，然后重新上传所需的镜像。

### 先决条件

在执行清理操作之前，您必须：

- **记录集群插件和 Operator**：记录当前安装在平台上的所有集群插件和 Operators
- **备份自定义镜像**：如果您在注册表中存储了非平台镜像，请备份它们或单独记录以便在清理后重新上传
- **安排维护窗口**：此操作将暂时影响平台镜像的可用性，因此请在维护窗口期间进行计划

### 概述

清理过程主要包括三个部分：

1. **清理镜像注册表**：备份 MinIO 数据，记录已安装的插件/Operators，并清空注册表存储
2. **恢复 ACP 核心镜像**：重新上传 ACP 核心镜像并验证功能
3. **恢复集群插件和 Operator 镜像**：准备包，重新上传并验证

---

## 第 1 部分：清理镜像注册表

### 备份 MinIO 数据

**重要**：在执行任何清理操作之前，您必须备份全球集群所有三个控制平面节点上的 MinIO 目录。

在每个控制平面节点上执行备份命令：

```bash
# 替换为当前主节点的实际 IP 地址
ip=192.168.3.10

# 创建 MinIO 目录的备份
tar -cvf ${ip}-minio.tar /cpaas/minio

# 重要：验证备份文件大小与原始目录大小是否匹配
ls -lh ${ip}-minio.tar
du -sh /cpaas/minio
```

**重要说明**：

- 在所有三个控制平面节点上执行此备份
- 验证备份文件大小以确保数据完整性
- 将备份文件存储在安全的位置

### 获取已安装的 Operators

在清理注册表之前，记录所有已安装的 Operators。在全球集群上执行以下命令以列出跨集群安装的所有 Operators：

```bash
kubectl get operatorviews -A   -o custom-columns='CLUSTER:.metadata.namespace,NAME:.metadata.name,PHASE:.status.operatorStatus.phase,ARTIFACT:.status.operatorStatus.installation.artifactName,INSTALLED_CSV:.status.operatorStatus.installation.subscription.installedCSV,DISPLAY_NAME:.status.packageManifestStatus.channels[0].currentCSVDesc.displayName' | awk 'NR==1 || ($3 == "Installed")'  
```

**输出示例**：

```text
CLUSTER      NAME                             PHASE       ARTIFACT                 INSTALLED_CSV                                        DISPLAY_NAME
global       clickhouse-operator              Installed   clickhouse-operator      clickhouse-operator.v4.2.0                           ClickHouse
global       envoy-gateway-operator           Installed   envoy-gateway-operator   envoy-gateway-operator.v1.5.0-build.20251226181113   Alauda build of Envoy Gateway
global       rds-operator                     Installed   rds-operator             rds-operator.v4.2.2                                  Alauda Container Platform Data Services RDS Framework
```

**字段描述**：

- **CLUSTER**：集群名称
- **NAME**：Operator 名称
- **PHASE**：Operator 阶段（应为 "Installed"）
- **ARTIFACT**：与 Operator 对应的 Artifact 资源名称
- **INSTALLED_CSV**：已安装的 CSV 版本（注意：如果 Operator 创建失败或等待批准，此字段可能为空）
- **DISPLAY_NAME**：显示名称

### 获取已安装的集群插件

在全球集群上执行以下命令以列出跨集群安装的所有对齐/无关集群插件：

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

**输出示例**：

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

**字段描述**：

- **MODULE**：集群插件名称
- **LIFECYCLE**：集群插件类型（核心、对齐或无关）
- **INSTALLED(CLUSTER:VERSION)**：以 `<cluster>:<version>` 或 `<cluster>:<version>, <cluster>: <version>` 格式列出插件在各集群中的安装状态
- **DISPLAY_NAME**：显示名称

**重要**：此记录必须在清理注册表之前完成，以避免由于缺少镜像而导致的插件状态问题。

### 清除注册表数据

进入全球集群的任意控制平面节点，并在注册表 MinIO 容器内执行清理命令：

```bash
# 访问注册表 MinIO 容器（方法可能因部署而异）
# 示例使用 kubectl：
kubectl exec -it -n <registry-namespace> <registry-minio-pod> -- bash

# 执行清理命令以清空注册表桶
source /etc/config/minio.env && \
  mc --insecure alias set minio https://127.0.0.1:9000 $MINIO_ACCESS_KEY $MINIO_SECRET_KEY && \
  mc --insecure rm --recursive --force minio/registry/
```

**警告**：此操作将**永久删除**注册表中的所有镜像。确保您已完成备份步骤。

---

## 第 2 部分：恢复 ACP 核心镜像

### 重新上传 ACP 核心镜像

准备 ACP 核心安装包并将核心镜像推送到注册表：

```bash
# 配置注册表凭据
REGISTRY=example.registry.address:11440
USERNAME=exampleusername
PASSWORD=examplepassword

# 进入安装程序目录
core_dir=/cpaas/installer
cd $core_dir

# 上传所有核心镜像
bash "res/upload.sh" "all" "${REGISTRY}" "${USERNAME}" "${PASSWORD}"

# 上传必要的核心镜像
bash "res/upload.sh" "necessary" "${REGISTRY}" "${USERNAME}" "${PASSWORD}"
```

**重要**：

- 用您的实际注册表地址和凭据替换占位符值
- 确保注册表服务正在运行并可访问
- 监控上传过程以查找任何错误

### 测试核心镜像拉取

完成重新上传过程后，验证 ACP 核心镜像是否可以成功拉取：

```bash
# 测试拉取核心平台镜像
nerdctl pull ${REGISTRY}/acp/core:latest

# 验证镜像拉取成功
nerdctl images | grep ${REGISTRY}
```

---

## 第 3 部分：恢复集群插件和 Operator 镜像

### 准备 Operator 和集群插件安装包

根据第 1 部分记录的 Operators 和集群插件，准备相应的安装包：

1. 确保您拥有所有记录的 Operators 和集群插件的安装包
2. 验证包版本与第 1 部分记录的已安装版本匹配
3. 将安装包放置在可访问的位置以便上传

### 重新上传集群插件和 Operators

准备扩展包插件并将其推送到平台：

```bash
# 配置平台访问凭据
Platform_URL="https://exampleaddress"
Platform_USER="exampleusername"
Platform_PASSWORD="examplepassword"

# 进入插件目录
plugin_dir="/cpaas/installer/plugins"
cd $plugin_dir

# 逐个上传所有插件
for i in "$plugin_dir"/*; do
  [ -e "$i" ] || continue
  i=$(basename "$i")
  violet push $i \
    --platform-address $Platform_URL \
    --platform-username $Platform_USER \
    --platform-password $Platform_PASSWORD
done
```

**重要**：

- 此步骤仅使用 `violet push` 将插件包上传到平台
- 上传完成后，必须单独安装插件
- 验证每个插件是否成功上传

### 测试插件和 Operator 镜像拉取

完成重新上传过程后，验证插件和 Operator 镜像是否可以成功拉取：

```bash
# 测试拉取插件镜像（替换为实际插件名称和版本）
nerdctl pull ${REGISTRY}/acp/plugin-name:version

# 测试拉取 Operator 镜像（替换为实际 Operator 名称和版本）
nerdctl pull ${REGISTRY}/operator-name:version

# 验证镜像拉取成功
nerdctl images | grep ${REGISTRY}
```

### 其他考虑事项

**对于自定义镜像**：

如果您在注册表中存储了自定义或非平台镜像：

- 确保在清理之前备份这些镜像
- 在完成平台镜像重新上传后重新上传这些自定义镜像
- 验证自定义应用程序是否仍然可以拉取所需的镜像

**联系支持**：

如果在清理过程中遇到任何问题，请联系技术支持以获取帮助。
