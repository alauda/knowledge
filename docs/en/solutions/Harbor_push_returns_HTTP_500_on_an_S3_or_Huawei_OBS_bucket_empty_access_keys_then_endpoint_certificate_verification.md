---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Harbor push returns HTTP 500 on an S3 or Huawei OBS bucket: empty access keys, then endpoint certificate verification

## Issue

The Harbor registry stores images in an S3-compatible bucket (for example a Huawei OBS public bucket), and pushes fail:

- `docker push` or `podman push` to Harbor fails with an HTTP `500` status.
- Image synchronization (replication) tasks fail at the push step with a `500` error.
- The bucket is public, so the access key and secret key were left empty.
- After the access key and secret key are filled in, the registry reports a certificate verification failure when it connects to S3.

The two causes below are usually met in sequence: clear Cause 1 first; Cause 2 is the error that can appear once Cause 1 is fixed. A push that returns 500 on NFS or NAS storage, without an S3 backend, is a different problem.

## Root Cause

### Cause 1: the S3 access key and secret key are empty

The S3 credential Secret referenced by the Harbor resource contains the keys `REGISTRY_STORAGE_S3_ACCESSKEY` and `REGISTRY_STORAGE_S3_SECRETKEY`, but both values are empty, because the bucket is public. A public bucket can be public for reads (GET) only, while a push writes objects, so pushes fail with a `500`. Filling in a valid access key and secret key fixes it: even for a public bucket, the registry needs keys that can write to it.

### Cause 2: the registry fails certificate verification against the S3 endpoint

With the keys in place, the registry fails certificate verification when it connects to the S3 endpoint over HTTPS. When the endpoint also serves plain HTTP (the Huawei OBS console lists `HTTPS/HTTP` as the supported protocols of the Endpoint and the bucket access domain), changing the registry's S3 endpoint (`regionendpoint`) from `https://` to `http://` restores image push and synchronization.

## Resolution

### Cause 1

1. Find the Secret the Harbor resource uses for S3 and check whether its values are empty, without printing them:

   ```bash
   kubectl -n <namespace> get harbor <name> -o yaml | grep -n -E 'imageChartStorage|type: s3|existingSecret|bucket|regionendpoint'
   kubectl -n <namespace> get secret <s3-secret> -o jsonpath='{.data.REGISTRY_STORAGE_S3_ACCESSKEY}' | wc -c
   kubectl -n <namespace> get secret <s3-secret> -o jsonpath='{.data.REGISTRY_STORAGE_S3_SECRETKEY}' | wc -c
   ```

   `0` means the value is empty or missing. If the live Secret uses different key names, compare it with a Harbor whose S3 pushes succeed and set the keys under the names that Secret already has.

2. Write an access key and secret key with write access to the bucket into the Secret.

   > **Warning:** Only when a key value is empty. Impact: the registry presents new credentials to S3; a wrong key repeats the 500. Precondition: an access key and secret key that can write to the bucket. Rollback: `kubectl apply -f /tmp/s3-secret-before.yaml`. The 500 itself did not delete any blob.

   ```bash
   kubectl -n <namespace> get secret <s3-secret> -o yaml > /tmp/s3-secret-before.yaml
   kubectl -n <namespace> create secret generic <s3-secret> \
     --from-literal=REGISTRY_STORAGE_S3_ACCESSKEY='<access-key>' \
     --from-literal=REGISTRY_STORAGE_S3_SECRETKEY='<secret-key>' \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

3. Restart the registry so it reads the new values.

   > **Warning:** Impact: pushes and pulls are interrupted until the new Pods are Ready. The Deployment recreates the Pods on the same spec; nothing needs to be rolled back.

   ```bash
   kubectl -n <namespace> get deploy -o name | grep harbor-registry
   kubectl -n <namespace> rollout restart deployment <harbor-registry-deployment>
   kubectl -n <namespace> rollout status deployment <harbor-registry-deployment>
   ```

4. Retry the push or the replication task. If the 500 is gone and the new error is certificate verification, continue with Cause 2.

### Cause 2

1. Confirm that the endpoint serves plain HTTP (see Diagnostic Steps, step 3, or the provider console), then save the Harbor resource:

   ```bash
   kubectl -n <namespace> get harbor <name> -o yaml > /tmp/harbor-s3-endpoint.yaml
   grep -n regionendpoint /tmp/harbor-s3-endpoint.yaml
   ```

2. Change only the scheme of `regionendpoint` to `http://`, at the path where `grep` found it, keeping the host and any port.

   > **Warning:** Only when certificate verification is the remaining error, the keys are present, and the endpoint serves plain HTTP. Impact: the access key and the image layers travel without TLS, readable by anyone on that network path; the operator reconciles and the registry restarts. Rollback: `kubectl apply -f /tmp/harbor-s3-endpoint.yaml`. If the provider does not serve plain HTTP, this repair does not apply.

   ```bash
   kubectl -n <namespace> edit harbor <name>
   ```

   ```yaml
   spec:
     helmValues:
       persistence:
         imageChartStorage:
           type: s3
           s3:
             regionendpoint: http://<obs-endpoint>
   ```

3. If the registry Pods do not pick up the change, restart them as in Cause 1, step 3. Then retry the push and the replication task.

## Diagnostic Steps

1. Confirm the registry backend is S3 and read the registry log around a failed push:

   ```bash
   kubectl -n <namespace> get harbor <name> -o yaml | grep -n -E 'type: s3|existingSecret|regionendpoint'
   kubectl -n <namespace> logs deploy/<harbor-registry-deployment> --all-containers --tail=300 | grep -i -E 's3|certificate|x509|denied|500'
   ```

   The registry reports a certificate verification failure with an `x509:` prefix.

2. Push returns 500 and either S3 key in the Secret has length 0: Cause 1.

3. Keys present and the registry log shows certificate verification failing against the S3 endpoint: Cause 2. Check which protocols the endpoint serves, from a node the registry routes through:

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://<obs-endpoint>
   curl -sS -o /dev/null -w '%{http_code}\n' http://<obs-endpoint>
   ```

   A TLS error on the first command and an HTTP status on the second match Cause 2.

4. After either fix, retry the failed replication task or push one small tag, then pull it back.

To move an existing registry from a PVC to S3 storage, see [How to migrate harbor registry pvc storage to s3](How_to_migrate_harbor_registry_pvc_storage_to_s3.md).
