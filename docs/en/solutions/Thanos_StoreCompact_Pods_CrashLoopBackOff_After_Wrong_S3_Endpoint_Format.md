---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Thanos pods that back the long-term metrics store (typically named `observability-thanos-*` or `thanos-store-*` / `thanos-compact-*`) are stuck in `CrashLoopBackOff`. The container log reports that the bucket iteration is failing against the S3 gateway:

```text
level=error ts=2023-10-20T13:48:04.604601932Z caller=compact.go:499
  msg="retriable error" err="compaction: sync: BaseFetcher: iter bucket: context canceled"
level=error ts=2023-10-20T13:48:04.604692710Z caller=main.go:161
  err="BaseFetcher: iter bucket: The specified key does not exist."
```

The pods keep restarting because the Thanos object-storage client cannot list objects in the configured bucket and the process exits on the unrecoverable error.

## Root Cause

The `endpoint` field in the Thanos object-storage Secret is set to a URL shape the Thanos S3 client does not understand. A common mistake is to paste the full virtual-hosted bucket URL — `<bucket>.s3.<region>.amazonaws.com` — into `endpoint`. Thanos expects only the S3 service host; it appends the bucket itself from the separate `bucket:` field. When the hostname already includes the bucket, the resulting request targets `<bucket>.<bucket>.s3...` which does not exist, and every list call returns `The specified key does not exist.`.

## Resolution

Fix the Secret so `endpoint` contains only the S3 service host (no bucket prefix), and restart the Thanos pods so they pick up the corrected credentials.

1. Inspect the current Secret. The monitor stack stores the Thanos S3 credentials in a Secret (commonly named `thanos-object-storage`) inside the observability namespace:

   ```bash
   kubectl -n cpaas-system get secret thanos-object-storage \
     -o jsonpath='{.data.thanos\.yaml}' | base64 -d
   ```

   The decoded payload looks like:

   ```yaml
   type: s3
   config:
     bucket: YOUR_S3_BUCKET
     endpoint: YOUR_S3_ENDPOINT
     insecure: true
     access_key: YOUR_ACCESS_KEY
     secret_key: YOUR_SECRET_KEY
   ```

2. Confirm the `endpoint` value matches the S3-service host pattern, **not** the virtual-hosted bucket host:

   - Correct: `s3.<region>.amazonaws.com` (or the regional endpoint of the S3-compatible gateway in use).
   - Wrong: `<bucket>.s3.<region>.amazonaws.com`, because Thanos prepends the bucket itself from the `bucket:` field.

3. Patch the Secret with the corrected `thanos.yaml` payload:

   ```bash
   kubectl -n cpaas-system edit secret thanos-object-storage
   ```

   Keep `bucket`, `access_key`, and `secret_key` as they are; rewrite only `endpoint` to the bare service host.

4. Force the Thanos workloads to re-read the Secret by deleting the crashing pods. The parent StatefulSet / Deployment will recreate them:

   ```bash
   kubectl -n cpaas-system delete pod -l app.kubernetes.io/name=thanos
   ```

Replace the namespace and label selector with the values used in the installed monitor stack if they differ.

## Diagnostic Steps

Tail the logs of a crashing Thanos pod to confirm the error is about bucket iteration and not another class of S3 failure (e.g. expired credentials, TLS, or DNS):

```bash
kubectl -n cpaas-system logs <thanos-pod-name> --previous
```

If the message contains `BaseFetcher: iter bucket: The specified key does not exist.`, the cause is almost always the endpoint format — expired/invalid credentials surface as `AccessDenied` or `SignatureDoesNotMatch` instead.

Verify the effective configuration after the Secret edit:

```bash
kubectl -n cpaas-system get secret thanos-object-storage \
  -o jsonpath='{.data.thanos\.yaml}' | base64 -d
```

Confirm the new pod list is healthy and no longer restarting:

```bash
kubectl -n cpaas-system get pods -l app.kubernetes.io/name=thanos
```

If pods still crash with the same error after the edit, the S3 gateway may genuinely be missing the bucket — list it directly from a utility pod with `aws s3 ls s3://<bucket>` (or the equivalent for the S3-compatible provider) to rule out a bucket-provisioning gap before touching the Secret again.
