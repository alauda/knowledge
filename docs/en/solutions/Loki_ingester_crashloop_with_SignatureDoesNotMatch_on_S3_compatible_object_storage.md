---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

In a cluster that runs the Loki-based log storage option, the ingester pod fails to flush chunks to its S3-compatible object backend and crash-loops or stays `Ready 0/1`. The error in the ingester log points at HMAC signing rather than at networking:

```text
level=error component=ingester loop=4 org_id=audit msg="failed to flush"
  retries=2
  err="failed to flush chunks: store put chunk: SignatureDoesNotMatch:
       The request signature we calculated does not match the signature
       provided. Check the Secret Access Key and signing method.
       status code: 403, request id: <id>, host id:,
       num_chunks: 1, labels: {…, log_type=\"audit\"}"
```

`kubectl get pod -n <log-storage-ns>` shows the ingester pods either repeatedly restarting or sitting in `Running 0/1`. The Loki gateway and queriers may be up and answering reads (because reads don't write — the same credentials are used, but a misconfigured signing version is more likely to surface on a write).

> If your cluster runs the ClickHouse-backed log-storage option instead of the Loki one, this article does not apply — the failure mode below is specific to Loki's S3 client.

## Root Cause

`SignatureDoesNotMatch` from an S3-compatible endpoint is the API-level way of saying "I rebuilt the request signature using my copy of the Secret Access Key + the AWS signing version you advertised, and it does not match the one you sent." It is **never** about reachability — TLS, DNS, and TCP all worked, otherwise the error would not have come back from the bucket. It is always about credentials or signing parameters. The most common shapes:

- The `access_key_id` or `access_key_secret` field in the Secret has a stray newline, a trailing space, or was base64-decoded one too many times when it was generated.
- The endpoint URL is not the one the credentials were issued for (different region, different tenant, different MinIO/RGW gateway).
- The signature version expected by the bucket (`s3v4`) does not match what the client is using (some MinIO/RGW deployments require `s3v4` and the Loki Secret was constructed with the older `s3` style).
- The `region` field is missing or wrong, and the backend's signing implementation includes the region in its HMAC.
- The bucket name in the Secret does not actually exist or has been renamed.

Each of these makes the server's recomputed signature differ from the one Loki sent — and the server returns the same `SignatureDoesNotMatch` regardless of which one was wrong.

## Resolution

Walk the Secret one field at a time and confirm each value against what the storage provider configured.

### 1. Read the current Secret values

```bash
kubectl get secret -n <log-storage-ns> <loki-storage-secret> \
  -o jsonpath='{.data}' \
  | jq 'with_entries(.value |= @base64d)'
```

Inspect each key (the field names depend on the Loki schema; common ones are `access_key_id`, `access_key_secret`, `endpoint`, `bucketnames`, `region`):

- No leading/trailing whitespace, no embedded newlines (`\n`), no quotes.
- Endpoint is the full URL the bucket lives behind, including scheme and any port (`https://s3.<vendor>.example:9000`).
- Region matches the region the credential was issued in.

### 2. Smoke-test the credentials with a generic S3 client from inside the cluster

Run a throwaway pod with `aws-cli` or `mc` (MinIO client) and the **exact same Secret values**, and try a write into the same bucket. If the same key/secret/endpoint succeeds from a generic client, the Secret is fine and the issue is in how Loki packs them — typically a region or signature-version mismatch. If the generic client also gets `SignatureDoesNotMatch`, the credential itself is wrong and needs reissuing on the storage side.

```bash
kubectl run -it --rm s3-smoke \
  --image=amazon/aws-cli \
  --env=AWS_ACCESS_KEY_ID="$AKID" \
  --env=AWS_SECRET_ACCESS_KEY="$SAK" \
  --env=AWS_DEFAULT_REGION="$REGION" \
  -- s3 --endpoint-url "$ENDPOINT" cp /etc/hostname s3://<bucket>/probe
```

### 3. Force `s3v4` if the backend requires it

For MinIO / Ceph RGW / non-AWS-S3 backends, the Loki S3 storage section needs to advertise the right signature version. The Loki schema field is usually `signature_version: s3v4`. Add it to the storage section of the Loki / LokiStack CR (or to whatever the local CR is called). Restart the affected pods so they re-read the storage block:

```bash
kubectl -n <log-storage-ns> rollout restart statefulset/<loki-ingester>
```

### 4. Re-issue the credential when needed

If the generic-client smoke test also fails, ask the storage admin to issue a new key/secret pair scoped to the bucket Loki is using, drop the values into the Secret, and roll the ingester. There is no Loki-side workaround for a broken credential.

## Diagnostic Steps

1. Capture the failing flush line from the ingester and confirm the error code is exactly `SignatureDoesNotMatch` (status 403). Other 403s — `AccessDenied`, `InvalidAccessKeyId` — point at IAM policy or wrong key id, *not* at the signing problem this article addresses:

   ```bash
   kubectl logs -n <log-storage-ns> <loki-ingester-pod> --tail=200 \
     | grep -E 'SignatureDoesNotMatch|AccessDenied|InvalidAccessKeyId'
   ```

2. Diff the Secret's decoded fields against the storage provider's configuration page. Most "I copied the right key" mistakes turn out to be a hidden newline at the end of one of the values, introduced when the YAML was hand-edited. A non-base64 reading of the field will end with `\n` if so.

3. Verify the bucket exists and the credential has write permission on it from the smoke-test pod above. A successful `cp` proves the credential pair, the endpoint, and the region are all consistent — the remaining suspect is the signing version, which is fixed in step 3 of the resolution.

4. If the credentials and the signing version are confirmed correct and the failure persists, capture a HAR-style trace of the failing request from a sidecar `tcpdump` and send it to the storage vendor — the recomputed signature on the server side is the only evidence that pinpoints which header bytes diverge:

   ```bash
   kubectl exec -n <log-storage-ns> <loki-ingester-pod> \
     -- sh -c "tcpdump -i any -s0 -w /tmp/loki-flush.pcap host <endpoint-host>"
   ```

5. While diagnosing, the cluster's other observability paths (metrics, events) keep working — only the log path is affected. Confirm that any user-facing alert about the log pipeline being degraded is firing on the right component before paging the storage team.
