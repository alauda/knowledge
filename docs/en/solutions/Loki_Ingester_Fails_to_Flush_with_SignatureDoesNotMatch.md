---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Loki ingester pods that are part of the cluster log-aggregation stack log repeated flush failures against the object store. The ingester log line has a shape similar to:

```text
level=error caller=flush.go:261 component=ingester loop=8 org_id=infrastructure
  msg="failed to flush" retries=2 err="failed to flush chunks: store put chunk:
  SignatureDoesNotMatch: The request signature we calculated does not match the
  signature you provided. Check your key and signing method.
    status code: 403, request id:, host id:, num_chunks: 1, ..."
```

Downstream symptoms include a rising `LokiIngesterFlushFailureRateCritical` alert, growing in-memory WAL on the ingesters, and log queries returning gaps once the ingesters start dropping chunks under back-pressure. The stream labels in the error (for example `kubernetes_namespace_name`) make this unmistakably a Loki-to-S3-compatible-store problem, not a networking blip.

## Root Cause

`SignatureDoesNotMatch (403)` from an S3-compatible object store means exactly one thing: the request was signed, and the store rejected the signature. There are only two plausible sources of a bad signature in this path:

1. The access-key ID and secret access key configured on the LokiStack no longer correspond to the credentials the bucket backend expects. This is the common case. Credentials are either expired (time-bound token provided by an external issuer), have been rotated on the object-store side without the rotation being propagated back to the log stack, or the stored secret is referencing a different key pair than the one that was intended.
2. The clock on the ingester pod's host is far enough off that the AWS SigV4 "request time window" check fails. This is vanishingly rare on a cluster with working NTP and shows up as `RequestTimeTooSkewed` rather than `SignatureDoesNotMatch`, so it can usually be excluded quickly.

The Loki ingester path is: write-path → in-memory chunk → flush → PUT object to bucket → tombstone in-memory chunk. With a bad signature every PUT fails, the ingester retries with exponential backoff, and eventually shelves the chunk to the WAL while keeping the stream queue growing. No data has been lost yet — but if the credentials stay wrong long enough for the WAL to fill or for pod restarts to roll over, the ingester will start dropping the oldest chunks.

The alert `LokiIngesterFlushFailureRateCritical` is the supported way this condition surfaces; it is part of the Loki-layer alerting that ships with the LokiStack deployment.

## Resolution

### Preferred: ACP Logging Service — rotate the object-store credentials in the managed Secret

The log stack in ACP (the in-cluster `observability/log` feature and the extension product **Logging Service**) manages the LokiStack via a CRD and references the object-store credentials through a Secret attached to the LokiStack spec. Rotate the credentials in two steps:

1. **Issue a fresh access-key pair on the object store.**
   - Mint a new access-key ID and secret with the same permissions against the same bucket (typically `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` on the chunks bucket).
   - Give the new key a longer validity window than the old one. Temporary credentials that rotate faster than the alerting window produce exactly this outage on schedule.

2. **Update the Secret referenced by the LokiStack spec.**

   ```bash
   # Find which Secret the LokiStack points at
   kubectl get lokistack -A \
     -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}  ->  {.spec.storage.secret.name}{"\n"}{end}'

   # Patch the Secret with the new keys (example uses a generic-opaque secret;
   # key names depend on the Loki object-storage schema — usually
   # access_key_id / access_key_secret or aws_access_key_id / aws_secret_access_key)
   kubectl -n <logging-namespace> create secret generic <secret-name> \
     --from-literal=access_key_id='<NEW-AK>' \
     --from-literal=access_key_secret='<NEW-SK>' \
     --from-literal=bucketnames='<bucket>' \
     --from-literal=endpoint='https://<object-store-endpoint>' \
     --from-literal=region='<region>' \
     --dry-run=client -o yaml \
     | kubectl apply -f -
   ```

3. **Restart the ingester pods** so they pick up the new Secret on the next flush cycle. The Loki operator in the Logging Service extension will recycle them automatically when the Secret's `resourceVersion` changes; if the ingesters do not roll within a few minutes, delete them manually and the StatefulSet controller will replace them cleanly:

   ```bash
   kubectl -n <logging-namespace> rollout restart statefulset/<lokistack-name>-ingester
   ```

4. **Watch the alert clear and the flush rate recover.**

   ```bash
   kubectl -n <logging-namespace> logs \
     -l app.kubernetes.io/component=ingester \
     --tail=50 \
     | grep -iE 'flush|signature|403' || echo "no recent flush errors"
   ```

### OSS fallback: self-managed Loki deployment

If Loki is deployed directly (helm chart or manifests, not the managed CRD), the same root cause and the same remediation apply, with two differences:

- The credentials live in whatever Secret the Loki `StorageConfig` section references — by convention `loki-s3-credentials` or similar, not the LokiStack-operator-managed Secret.
- The restart is against the standalone ingester `StatefulSet` you deployed.

In either case, update the credentials in the Secret, rotate the ingester pods, and verify flush succeeds on the new keys.

## Diagnostic Steps

Narrow the diagnosis quickly to rule out adjacent failure modes before rotating credentials.

1. **Confirm the error is specifically `SignatureDoesNotMatch` on chunk PUT, not a 5xx from the bucket or a DNS / TCP failure.**

   ```bash
   kubectl -n <logging-namespace> logs \
     -l app.kubernetes.io/component=ingester \
     --since=30m \
     | grep -iE 'failed to flush|SignatureDoesNotMatch|Status Code|connection refused'
   ```

   A different 403 reason (`InvalidAccessKeyId`, `AccessDenied`) points to a different fix (the key pair does not exist, or the IAM policy is wrong). A 5xx or network error is an object-store availability problem, not a credential problem.

2. **Verify the Secret the LokiStack references is the one you think it is and carries the expected keys.**

   ```bash
   kubectl get lokistack -n <logging-namespace> <name> \
     -o jsonpath='{.spec.storage.secret}{"\n"}'

   kubectl -n <logging-namespace> get secret <secret-name> \
     -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}'
   ```

   Missing keys (for example an empty `access_key_secret`) produce exactly this error without anything actually expiring.

3. **Do a one-shot sanity check against the bucket from inside the cluster using the same credentials, to separate "credential is wrong" from "Loki is misconfigured".**

   ```bash
   # Run a throw-away pod in the logging namespace with the same Secret mounted
   kubectl -n <logging-namespace> run s3-probe --rm -it \
     --image=amazon/aws-cli --env AWS_ACCESS_KEY_ID=$(kubectl -n <logging-namespace> get secret <secret-name> -o jsonpath='{.data.access_key_id}' | base64 -d) \
     --env AWS_SECRET_ACCESS_KEY=$(kubectl -n <logging-namespace> get secret <secret-name> -o jsonpath='{.data.access_key_secret}' | base64 -d) \
     -- aws --endpoint-url <object-store-endpoint> s3 ls s3://<bucket>/
   ```

   A matching `SignatureDoesNotMatch` here confirms the Secret holds bad credentials; a successful listing means the credentials are fine and the problem is in how Loki is signing (wrong region, wrong endpoint style, SigV2 vs SigV4 mismatch).

4. **Check clock skew on the ingester nodes only if step 3 is inconclusive.**

   ```bash
   for n in $(kubectl get node -o jsonpath='{.items[*].metadata.name}'); do
     echo "== $n =="
     kubectl debug node/$n --image=busybox:1.36 -it -- chroot /host date -u
   done
   ```

   Skew larger than ~15 minutes against real UTC will produce signature errors; normally this triggers `RequestTimeTooSkewed` but some S3-compatible implementations fold that into `SignatureDoesNotMatch`.
