---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500462
sourceSHA: f694fe2cb200e39d5a9181d5afdcff32fbbf3a4e41ceadf4bda707c484db0a15
---

# 使用没有真实地域的 S3 兼容对象存储配置 Velero

## 问题

在 Alauda 容器平台（安装包 `installer-v4.3.0-online`，ACP v4.3.13，kube v1.34.5）上，Velero 作为 `cpaas-system` 命名空间中的 `velero` ModulePlugin 运行（图表 `ait/chart-velero` v4.1.0；Velero 核心 `velero:v1.15.2-v4.1.0`；唯一提供的 S3 对象存储插件是 `velero-plugin-for-aws:v1.11.1-v4.1.0`，它注册了 `velero.io/aws` ObjectStore）。该 AWS 插件要求在 BackupStorageLocation 配置中设置非空的 `region` 值，并且在后端端点不是 AWS S3 时不会自动发现区域。

当 BackupStorageLocation 没有设置 `region` 且配置的 `s3Url` 指向非 AWS 端点时，插件的区域发现代码在协调路径上发出错误字符串 `region for AWS backupstoragelocation not automatically discoverable. Please set the region in the backupstoragelocation config`。

许多本地 S3 兼容对象存储（例如 IBM Cloud Object Storage）没有 AWS 区域的概念，并且仅通过路径样式 URL（`<host>/<bucket>`）进行寻址，而不是 AWS 插件默认使用的虚拟主机样式（`<bucket>.<host>`）。对于这些端点，BackupStorageLocation 还必须设置 `s3ForcePathStyle: "true"`，以便 AWS 插件能够与存储桶进行通信。

## 解决方案

在 BackupStorageLocation 配置中设置一个占位符 `region` 值（`us-east-1` 是标准选择），以满足 AWS 插件的区域要求；这允许 BackupStorageLocation 与没有真实区域的 S3 兼容存储进行协调。

在 ACP 中，velero ModulePlugin 的 `cpins` 将 `region` 和 `s3Url` 作为一等键暴露在 `spec.config.configuration.backupStorageLocation.config` 下。编辑 `cpaas-system` 中的 `velero` ClusterPluginInstance，以便占位符区域从 ModulePlugin 传播到管理的 BackupStorageLocation：

```bash
kubectl edit clusterplugininstance velero
```

```yaml
spec:
  config:
    configuration:
      backupStorageLocation:
        config:
          region: us-east-1
          s3Url: https://<s3-compatible-endpoint>
```

`s3ForcePathStyle` 键未作为 velero `cpins` 架构中的一等字段暴露，因此路径样式寻址必须直接在 `cpaas-system` 中的 BackupStorageLocation CR 上设置。ACP CRD 和入场接受完整的配置形状（`region`、`s3Url`、`s3ForcePathStyle`、`insecureSkipTLSVerify`）作为自由格式的 `map[string]string`；设置 `s3ForcePathStyle: "true"` 将 AWS 插件从虚拟主机样式 URL 切换到路径样式 URL：

```bash
kubectl -n cpaas-system edit backupstoragelocation <name>
```

```yaml
spec:
  config:
    region: us-east-1
    s3Url: https://<s3-compatible-endpoint>
    s3ForcePathStyle: "true"
    insecureSkipTLSVerify: "true"
```

将两个表面结合使用，以便在没有区域和路径样式寻址的 S3 兼容端点上：通过 `velero` `cpins` 设置 `region`（和 `s3Url`），以便 ModulePlugin 管理这些值，然后直接在生成的 BackupStorageLocation 上设置 `s3ForcePathStyle`（以及端点所需的任何 TLS 跳过标志）。

## 诊断步骤

检查 `cpaas-system` 中的 BackupStorageLocation，以读取 `spec.config` 和协调状态；当缺少区域时，状态会逐字显示 `region for AWS backupstoragelocation not automatically discoverable. Please set the region in the backupstoragelocation config` 消息：

```bash
kubectl -n cpaas-system get backupstoragelocation
kubectl -n cpaas-system describe backupstoragelocation <name>
```

在 `cpaas-system` 中读取 Velero pod 日志，以获取相同的区域发现错误和 AWS 插件发出的其他 BackupStorageLocation 协调失败：

```bash
kubectl -n cpaas-system logs deploy/velero
```

确认 velero ModulePlugin 配置是 `cpins` 实际携带的内容 — 一旦应用了上述编辑，`region` 和 `s3Url` 应该出现在 `spec.config.configuration.backupStorageLocation.config` 下：

```bash
kubectl get clusterplugininstance velero -o yaml
```
