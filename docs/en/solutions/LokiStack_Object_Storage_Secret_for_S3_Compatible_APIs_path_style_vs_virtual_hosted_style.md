---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

LokiStack needs to be configured against an S3-compatible object store — MinIO, Hitachi HCP, Cloudian HyperStore, Ceph RGW, a self-hosted S3 gateway, etc. — not AWS S3 directly. Two related questions come up:

1. Which fields does the LokiStack's object-storage `Secret` need when the back-end is an S3-compatible API rather than AWS?
2. Which TLS certificate should the object-store endpoint present, given that LokiStack can address it in either **path-style** (`https://<host>/<bucket>/<key>`) or **virtual-hosted-style** (`https://<bucket>.<host>/<key>`)?

Getting either wrong produces a LokiStack that fails to connect (`403 SignatureDoesNotMatch`, `403 InvalidAccessKeyId`) or that connects but trips TLS verification (`x509: certificate is valid for <host>, not <bucket>.<host>`).

## Resolution

### Object-storage Secret shape for S3-compatible APIs

The `Secret` referenced by the `LokiStack.spec.storage.secret` field carries the credentials and endpoint coordinates. For an S3-compatible back-end, the required keys are:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: logging-loki-s3
  namespace: cluster-logging
stringData:
  # Bucket and region.
  bucketnames: logging-loki-index,logging-loki-chunks
  region:      us-east-1                      # often ignored by S3-compatible backends
                                              #   but some validate its presence.
  # Endpoint — set explicitly because the default is the AWS endpoint map.
  endpoint:    https://s3.example.internal    # <-- your S3-compatible service URL

  # Credentials.
  access_key_id:     <your-access-key>
  access_key_secret: <your-secret-key>

  # Optional: URL-style toggle (Loki v3.3+ / LokiStack v6.3+).
  # 'true' = path-style (default); 'false' = virtual-hosted-style.
  forcepathstyle: "true"
```

Key points:

- **`endpoint`** is the single most common mistake. Omitting it or pointing at the AWS endpoint leads to the driver trying to resolve `s3.<region>.amazonaws.com`, which of course does not reach the internal store.
- **`region`** is required even for backends that ignore it — the S3 SDK still signs requests with a region string. Any valid-looking value works if the backend does not validate it; use `us-east-1` when unsure.
- **`access_key_id`** and **`access_key_secret`** are the S3-compatible equivalent of AWS IAM credentials. The backend usually lets you create dedicated keys scoped to the LokiStack buckets.

Verify the `Secret` was picked up by the LokiStack:

```bash
kubectl -n cluster-logging get lokistack logging-loki -o \
  jsonpath='{.spec.storage.secret}{"\n"}{.status.conditions[*].type}={.status.conditions[*].status}{"\n"}'
```

### URL style — path-style vs virtual-hosted-style

S3 supports two ways to address a bucket:

- **path-style** (default for LokiStack against S3-compatible backends): `https://<endpoint-host>/<bucket>/<key>`. The bucket name appears in the URL path.
- **virtual-hosted-style** (AWS default): `https://<bucket>.<endpoint-host>/<key>`. The bucket name is a subdomain.

Older LokiStack / Loki versions hard-code path-style for S3-compatible backends. Starting with Loki v3.3 (bundled with the LokiStack operator v6.3 and later), the `forcepathstyle` Secret key toggles between the two:

- `forcepathstyle: "true"` (default) — path-style URLs.
- `forcepathstyle: "false"` — virtual-hosted-style URLs.

Match the style the object-storage backend **actually supports**. Many S3-compatible backends accept both, but some (older MinIO releases, certain appliance-backed gateways) reject one or the other. Consult the backend's documentation or test with `curl` before committing:

```bash
# path-style test
curl -v https://<endpoint-host>/<bucket>/ -o /dev/null

# virtual-hosted-style test
curl -v https://<bucket>.<endpoint-host>/ -o /dev/null
```

A `404` or `403` from the bucket itself is fine (the path exists, authentication aside); a connection error or `400 Bad Request` indicates the style is unsupported by the backend.

### TLS certificate — what name does the endpoint need to carry?

The certificate the backend presents must match the URL style LokiStack uses:

- **Path-style**: the certificate must be valid for `<endpoint-host>`. The bucket name does not appear in the SNI.
- **Virtual-hosted-style**: the certificate must be valid for `<bucket>.<endpoint-host>`. Typically served via a wildcard certificate like `*.<endpoint-host>`.

If the certificate does not match, LokiStack reports a TLS verification error in its operator log:

```text
x509: certificate is valid for s3.example.internal,
      not logging-loki-chunks.s3.example.internal
```

Two fixes:

- Issue the backend a certificate that covers the right SAN (specific bucket name for a single bucket, or wildcard on the endpoint host for any bucket).
- Switch `forcepathstyle` to match the certificate (if the cert is only valid for the bare endpoint host, use path-style; if only for wildcard subdomains, use virtual-hosted-style).

### CA configuration

When the backend uses an internal CA that the cluster does not trust by default, provide the CA bundle through the LokiStack's `spec.storage.tls.caName` field, pointing at a ConfigMap with the `service-ca.crt`-style key:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: logging-loki-s3-ca
  namespace: cluster-logging
data:
  service-ca.crt: |
    -----BEGIN CERTIFICATE-----
    <internal CA certificate>
    -----END CERTIFICATE-----
---
apiVersion: loki.grafana.com/v1
kind: LokiStack
metadata:
  name: logging-loki
spec:
  storage:
    secret:
      name: logging-loki-s3
      type: s3
    tls:
      caName: logging-loki-s3-ca
  # ... rest of spec ...
```

The LokiStack operator mounts the ConfigMap into the Loki pods and adds it to the TLS trust store, so TLS verification against the backend succeeds.

## Diagnostic Steps

If LokiStack reports `Storage: Degraded`, read its status for the operator's specific complaint:

```bash
kubectl -n cluster-logging get lokistack logging-loki -o yaml | \
  yq '.status.conditions[] | select(.type=="Storage" or .type=="Ready")'
```

Match the message against the usual culprits:

| Message contains | Likely cause |
|---|---|
| `SignatureDoesNotMatch` | access_key_secret wrong |
| `InvalidAccessKeyId` | access_key_id wrong |
| `failed to resolve host` | endpoint wrong or DNS missing |
| `x509: certificate is valid for …, not …` | URL style / certificate mismatch (see above) |
| `x509: certificate signed by unknown authority` | CA bundle missing / wrong |
| `NoSuchBucket` | bucketnames entry points at a bucket that does not exist |

Test the object-store reachability directly from inside the cluster to rule out network issues:

```bash
kubectl run s3-probe --image=amazon/aws-cli --rm -it --restart=Never -- \
  sh -c '
    export AWS_ACCESS_KEY_ID=<access-key>
    export AWS_SECRET_ACCESS_KEY=<secret-key>
    aws --endpoint-url https://s3.example.internal \
        --region us-east-1 \
        s3 ls s3://logging-loki-chunks/
  '
```

A listing (even empty) confirms credentials and endpoint reach. Pass `--no-verify-ssl` only as a temporary diagnostic to isolate TLS issues — never leave it enabled for production.

After fixing the Secret or URL style, force a LokiStack reconcile by touching the LokiStack's spec (a no-op annotation update, for example) and watch:

```bash
kubectl -n cluster-logging get lokistack logging-loki -w
```

`Ready=True` with no degraded conditions confirms the object-storage path is healthy.
