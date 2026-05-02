---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Configuring Velero with an S3-compatible object store that has no region
## Overview

The cluster's data-protection controller (Velero-based) ships an `aws` plugin that talks to S3 and S3-compatible object stores. The plugin was originally built for AWS S3 and treats the bucket region as a required attribute. Many on-premise S3-compatible systems (IBM COS on-prem, MinIO, Ceph RGW, NetApp StorageGRID, ECS, on-prem Cloudian, and others) do not expose a region concept at all. Without a region, the plugin's discovery code returns an error such as:

```text
region for AWS backupstoragelocation not automatically discoverable. Please set the region in the backupstoragelocation config
```

and the `BackupStorageLocation` (BSL) — and therefore the parent `DataProtectionApplication` (DPA) — refuses to reconcile.

The fix is to supply a placeholder region and force path-style addressing so the plugin can talk to the endpoint without trying to resolve a virtual-hosted bucket DNS name in an AWS region.

## Resolution

### Set a placeholder region and `s3ForcePathStyle`

Edit the `DataProtectionApplication` and add `region` plus `s3ForcePathStyle` to the `velero.config` section of the affected backup location:

```yaml
spec:
  backupLocations:
    - velero:
        provider: aws
        objectStorage:
          bucket: <bucket-name>
          prefix: <optional-prefix>
        config:
          # Plugin demands a region. Any non-empty value works because the
          # backend ignores it.
          region: us-east-1
          # Address objects as https://<endpoint>/<bucket>/<key> instead of
          # https://<bucket>.<endpoint>/<key>, which is what most on-prem
          # gateways expect.
          s3ForcePathStyle: "true"
          # Set the endpoint of the storage gateway here.
          s3Url: https://<endpoint>
          # Set to "true" only for self-signed gateways.
          insecureSkipTLSVerify: "false"
        credential:
          name: cloud-credentials
          key: cloud
```

Save the resource and watch the controller reconcile:

```bash
kubectl get dpa -n <data-protection-ns>
kubectl describe dpa/<name> -n <data-protection-ns>
```

### Why both flags are required

- `region` — the plugin's connection bootstrap uses this for the AWS SDK signer. A placeholder is enough because the on-prem endpoint does not validate it.
- `s3ForcePathStyle: "true"` — without it, the SDK constructs URLs of the form `https://<bucket>.<endpoint>/<key>`, expecting wildcard DNS for the bucket name. On-prem gateways typically only respond at `https://<endpoint>/<bucket>/<key>`.

### Apply the same settings to snapshot locations

If the same on-prem S3 store is used by `snapshotLocations`, add `region` and `s3ForcePathStyle` to that block as well. The two sections are reconciled independently and any missing value will cause the controller to error in the same way.

### After the change

The controller re-reconciles the BSL automatically. Trigger a small backup to confirm end-to-end write access:

```bash
kubectl create -f - <<'EOF'
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: smoke-test
  namespace: <data-protection-ns>
spec:
  includedNamespaces:
    - <small-namespace>
EOF
```

The backup's `status.phase` should reach `Completed` and the bucket should contain a new object under the configured prefix.

## Diagnostic Steps

1. Check the DPA conditions for the region error:

   ```bash
   kubectl describe dpa/<name> -n <data-protection-ns>
   ```

   Look for `status: "False"` with the message about a non-discoverable region.

2. Confirm the BSL state:

   ```bash
   kubectl get backupstoragelocation -n <data-protection-ns>
   ```

   It should move to `Available` after the patch.

3. Read the Velero pod logs for any residual SDK error:

   ```bash
   kubectl logs -n <data-protection-ns> deployment/velero --tail=200 | grep -E -i 'BackupStorageLocation|region|signature|endpoint'
   ```

4. From outside the cluster, validate the credentials and endpoint with an `aws s3` or `mc` client to rule out gateway-side issues before changing the cluster configuration.
