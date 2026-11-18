---
kind:
  - Troubleshooting
products:
  - Alauda Application Services
ProductsVersion: []
---

# Data Services backup to external S3 storage fails with access denied when s3:GetBucketVersioning is not granted

## Issue

An external S3-compatible object storage is configured as a backup storage for Data Services, and the connection to it fails. The connection error names a missing permission on the bucket, in the form:

```text
s3:GetBucketVersioning on <bucket>
```

and the RDS operator log reports `access denied` for the same storage.

## Root Cause

### Cause 1: the S3 user lacks s3:GetBucketVersioning on the backup bucket

When the platform checks the backup storage, it does more than log in: it calls the S3 API `GetBucketVersioning` on the configured bucket. The object storage authorizes every S3 action separately, against the user or bucket policy of the access key. A policy that grants object read and write, or bucket listing, but not `s3:GetBucketVersioning` on that bucket makes the storage answer `AccessDenied` to that call, and the platform reports the storage connection as failed.

The fix is on the object storage side: grant `s3:GetBucketVersioning` on the bucket to the user whose access key the platform uses. No change is needed on the platform.

## Resolution

### Cause 1

1. Identify the bucket and the access key configured for the backup storage on the platform, and the user (or sub-user) on the object storage that owns that access key.

2. On the object storage, add `s3:GetBucketVersioning` on that bucket to the user's policy or to the bucket policy. S3-compatible storage products expose this in their own console as a bucket or user permission; where AWS-style JSON policies are supported, the statement looks like this:

   ```json
   {
     "Effect": "Allow",
     "Principal": {"AWS": ["<user-arn-or-id>"]},
     "Action": ["s3:GetBucketVersioning"],
     "Resource": ["arn:aws:s3:::<bucket>"]
   }
   ```

   The resource is the bucket itself (`arn:aws:s3:::<bucket>`), not the objects in it (`arn:aws:s3:::<bucket>/*`); a grant on objects only does not cover this bucket-level action. Keep the permissions the user already has for reading and writing backup objects.

3. Test the storage connection again from the platform, or run the backup again. The connection succeeds and the `access denied` messages stop in the RDS operator log.

## Diagnostic Steps

1. From a machine that reaches the object storage, call the same API with the same credentials (AWS CLI shown; any S3 client works):

   ```bash
   export AWS_ACCESS_KEY_ID=<access-key>
   export AWS_SECRET_ACCESS_KEY=<secret-key>
   aws s3api get-bucket-versioning --bucket <bucket> --endpoint-url https://<s3-endpoint> --region <region>
   ```

   - `An error occurred (AccessDenied) when calling the GetBucketVersioning operation` confirms this cause.
   - After the fix, the call returns `{}` (versioning never configured) or a JSON object with a `Status` field. Either is a pass; versioning does not have to be enabled.

2. For comparison, list the bucket with the same credentials:

   ```bash
   aws s3 ls s3://<bucket> --endpoint-url https://<s3-endpoint> --region <region>
   ```

   A listing that succeeds while step 1 returns `AccessDenied` shows that the credentials are valid and only the bucket-level permission is missing.

3. Rule out look-alikes in the same connection check: `NoSuchBucket` from `GetBucketVersioning` means the bucket name on the platform does not match a bucket on the storage (check the spelling), and `InvalidAccessKeyId` or `SignatureDoesNotMatch` means the key pair itself is wrong. Neither is fixed by granting permissions.
