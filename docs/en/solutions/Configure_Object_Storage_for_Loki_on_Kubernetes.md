---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

Loki stores its chunks and index in an object store. When Loki is deployed through an operator (LokiStack-style CRD) or as the upstream Helm chart, the operator/chart expects a Kubernetes `Secret` whose keys describe how to reach the bucket — endpoint URL, credentials, bucket name, region. The exact key set depends on the backend; this article enumerates the parameters required for each supported object store and shows how to assemble the corresponding Secret.

## Resolution

### Step 1 — Choose a backend and prepare the bucket

Loki supports any of the following:

- AWS S3
- S3-compatible (MinIO, Wasabi, Cloudflare R2, in-cluster object stores)
- Google Cloud Storage (GCS)
- Azure Blob Storage
- Swift (OpenStack)

Pre-create one bucket per Loki tier (chunks and ruler), or one bucket with separate prefixes. Reserve service-account credentials with `s3:Get/Put/Delete/List` (or the equivalent IAM scope on GCS/Azure/Swift).

### Step 2 — Build the credentials Secret

The Secret name is referenced by the LokiStack/Helm values; the keys inside are backend-specific.

#### S3 / S3-compatible (MinIO included)

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: loki-objstore
  namespace: logging
type: Opaque
stringData:
  endpoint: "https://s3.us-east-1.amazonaws.com"
  region: "us-east-1"
  bucketnames: "loki-chunks"
  access_key_id: "AKIA..."
  access_key_secret: "..."
```

For MinIO running in-cluster, set `endpoint: "http://minio.minio.svc.cluster.local:9000"` and `region: "us-east-1"` (MinIO ignores region but Loki insists on the field).

For S3 with TLS interception or self-signed CA, append a `ca.crt` key holding the PEM bundle and reference it from the LokiStack `spec.tls.caName` field.

#### Google Cloud Storage (GCS)

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: loki-objstore
  namespace: logging
type: Opaque
stringData:
  bucketname: "loki-chunks"
  key.json: |
    {
      "type": "service_account",
      "project_id": "...",
      "private_key_id": "...",
      "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
      "client_email": "loki-sa@example-project.iam.gserviceaccount.com",
      "client_id": "..."
    }
```

#### Azure Blob

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: loki-objstore
  namespace: logging
type: Opaque
stringData:
  environment: "AzureGlobal"
  account_name: "lokistorage"
  account_key: "..."
  container: "loki-chunks"
```

#### Swift (OpenStack)

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: loki-objstore
  namespace: logging
type: Opaque
stringData:
  auth_url: "https://keystone.example.com:5000/v3"
  username: "loki"
  user_domain_name: "Default"
  user_id: ""
  password: "..."
  domain_id: ""
  domain_name: "Default"
  project_id: ""
  project_name: "loki"
  project_domain_id: ""
  project_domain_name: "Default"
  region: "RegionOne"
  container_name: "loki-chunks"
```

### Step 3 — Reference the Secret from LokiStack

For the LokiStack CRD shipped by ACP `observability/log` (Logging Service), the storage section points at the Secret by name and declares the backend type:

```yaml
apiVersion: loki.grafana.com/v1
kind: LokiStack
metadata:
  name: logging-loki
  namespace: logging
spec:
  size: 1x.small
  storage:
    schemas:
      - version: v13
        effectiveDate: "2024-01-01"
    secret:
      name: loki-objstore
      type: s3        # or gcs / azure / swift
  storageClassName: default
```

For the upstream Helm chart, set the equivalent values under `loki.storage.bucketNames` and `loki.storage.<backend>` — the Helm chart writes the same Secret structure underneath.

### Step 4 — Restart Loki components

Whether deployed through the operator (LokiStack reconciliation will roll the StatefulSets) or through Helm:

```bash
kubectl -n logging rollout restart statefulset
```

## Diagnostic Steps

If Loki Pods crash-loop with `failed to connect to object storage` or similar:

- Inspect a Loki Pod log for the exact backend error:

  ```bash
  kubectl -n logging logs statefulset/logging-loki-distributor --tail=50
  ```

- Verify the Secret keys match the schema for the chosen backend (one missing key surfaces as `field is required`):

  ```bash
  kubectl -n logging get secret loki-objstore -o jsonpath='{.data}' | jq 'keys'
  ```

- For S3-compatible backends, exec into a Pod and probe the endpoint with `curl` to rule out networking and TLS issues:

  ```bash
  kubectl -n logging exec deploy/logging-loki-distributor -- \
    curl -v https://s3.us-east-1.amazonaws.com/loki-chunks
  ```

- For GCS, decode the `key.json` from the Secret and confirm it parses as valid JSON and the `client_email` is granted `roles/storage.objectAdmin` on the bucket:

  ```bash
  kubectl -n logging get secret loki-objstore -o jsonpath='{.data.key\.json}' | base64 -d | jq .
  ```
