---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500462
---

# Configuring Velero with an S3-compatible object store that has no real region

## Issue

On Alauda Container Platform (install package `installer-v4.3.0-online`, ACP v4.3.13, kube v1.34.5), Velero runs as the `velero` ModulePlugin in the `cpaas-system` namespace (chart `ait/chart-velero` v4.1.0; Velero core `velero:v1.15.2-v4.1.0`; the only S3 object-store plugin shipped is `velero-plugin-for-aws:v1.11.1-v4.1.0`, which registers the `velero.io/aws` ObjectStore). That AWS plugin requires a non-empty `region` value in the BackupStorageLocation config and does not auto-discover a region when the backing endpoint is not AWS S3.

When the BackupStorageLocation has no `region` set and the configured `s3Url` points at a non-AWS endpoint, the plugin's region-discovery code emits the error string `region for AWS backupstoragelocation not automatically discoverable. Please set the region in the backupstoragelocation config` on the reconcile path.

Many on-premise S3-compatible object stores (for example IBM Cloud Object Storage) have no concept of AWS regions and are addressed exclusively by path-style URLs (`<host>/<bucket>`) rather than the virtual-host style (`<bucket>.<host>`) the AWS plugin uses by default. For those endpoints the BackupStorageLocation must also set `s3ForcePathStyle: "true"` for the AWS plugin to be able to talk to the bucket.

## Resolution

Set a placeholder `region` value (`us-east-1` is the standard choice) in the BackupStorageLocation config to satisfy the AWS plugin's region requirement; this allows the BackupStorageLocation to reconcile against an S3-compatible store that has no real regions.

On ACP the velero ModulePlugin's `cpins` exposes `region` and `s3Url` as first-class keys under `spec.config.configuration.backupStorageLocation.config`. Edit the `velero` ClusterPluginInstance in `cpaas-system` so the placeholder region propagates from the ModulePlugin down to the managed BackupStorageLocation:

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

The `s3ForcePathStyle` key is not exposed as a first-class field on the velero `cpins` schema, so path-style addressing has to be set directly on the BackupStorageLocation CR in `cpaas-system`. The ACP CRD and admission accept the full config shape (`region`, `s3Url`, `s3ForcePathStyle`, `insecureSkipTLSVerify`) as a free-form `map[string]string`; setting `s3ForcePathStyle: "true"` switches the AWS plugin from virtual-host-style URLs to path-style URLs:

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

Use both surfaces together for an S3-compatible endpoint without regions and path-style addressing: set `region` (and `s3Url`) through the `velero` `cpins` so the ModulePlugin manages those values, then set `s3ForcePathStyle` (and any TLS-skip flag the endpoint needs) directly on the resulting BackupStorageLocation.

## Diagnostic Steps

Inspect the BackupStorageLocation in `cpaas-system` to read off `spec.config` and the reconcile status; when the region is missing the status surfaces the `region for AWS backupstoragelocation not automatically discoverable. Please set the region in the backupstoragelocation config` message verbatim:

```bash
kubectl -n cpaas-system get backupstoragelocation
kubectl -n cpaas-system describe backupstoragelocation <name>
```

Read the Velero pod logs in `cpaas-system` for the same region-discovery error and other BackupStorageLocation reconcile failures emitted by the AWS plugin:

```bash
kubectl -n cpaas-system logs deploy/velero
```

Confirm the velero ModulePlugin config is what the `cpins` actually carries — `region` and `s3Url` should appear under `spec.config.configuration.backupStorageLocation.config` once the edit above has been applied:

```bash
kubectl get clusterplugininstance velero -o yaml
```
