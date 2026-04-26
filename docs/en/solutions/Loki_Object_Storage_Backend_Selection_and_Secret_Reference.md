---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A Loki deployment moves chunks and the index out of the Pod filesystem into an object store. The selection of backend (S3-compatible, GCS, Azure, Swift) determines the schema of a Kubernetes `Secret` whose name is referenced from the `LokiStack` (or Helm values) `storage` block. This article enumerates the keys each backend expects and the cross-cutting fields shared by all.

## Resolution

### Backend selection matrix

| Backend | LokiStack `spec.storage.secret.type` | Primary Secret keys |
|---|---|---|
| AWS S3 | `s3` | `endpoint`, `region`, `bucketnames`, `access_key_id`, `access_key_secret` |
| S3-compatible (MinIO, Wasabi, R2) | `s3` | same as AWS S3, with the bucket's HTTP(S) endpoint |
| GCS | `gcs` | `bucketname`, `key.json` |
| Azure Blob | `azure` | `environment`, `account_name`, `account_key`, `container` |
| Swift | `swift` | `auth_url`, `username`, `password`, `project_name`, `container_name`, `region` |

### Step 1 — Create the bucket and grant the credentials

Provision one bucket (or one bucket with separate prefixes) for chunks. The credentials provided to Loki must be scoped to that bucket and must permit `get`, `put`, `list`, and `delete` on objects inside it.

### Step 2 — Author the Secret

The example below is for an in-cluster MinIO deployment exposed at `minio.minio.svc.cluster.local:9000`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: loki-bucket-credentials
  namespace: logging
type: Opaque
stringData:
  endpoint: "http://minio.minio.svc.cluster.local:9000"
  region: "us-east-1"
  bucketnames: "loki-chunks"
  access_key_id: "loki"
  access_key_secret: "<password-from-MinIO-tenant>"
```

Notes that apply across backends:

- For `s3`, `region` is mandatory in the schema even when the backend is region-less (MinIO ignores it but the LokiStack reconciler will fail validation if the field is missing).
- For `gcs`, `key.json` is the entire downloaded service-account JSON file, kept as one literal string under that key.
- For `azure`, `environment` is `AzureGlobal`, `AzureChinaCloud`, `AzureGermanCloud`, or `AzureUSGovernment`.
- For `swift`, the keystone-v3 fields with empty values must still be present as empty strings — the reconciler trips on missing keys, not on empty ones.

### Step 3 — Reference the Secret from LokiStack

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
      name: loki-bucket-credentials
      type: s3
  storageClassName: default
```

Apply the LokiStack and the operator rolls the StatefulSets:

```bash
kubectl apply -f lokistack.yaml
kubectl -n logging get lokistacks.loki.grafana.com -w
```

### Step 4 — Verify connectivity

Once the Pods are up, query the `Loki` Distributor's readiness probe through the Service. A healthy backend returns `ready` within a few seconds:

```bash
kubectl -n logging exec deploy/logging-loki-distributor -- \
  wget -qO- http://localhost:3100/ready
```

## Diagnostic Steps

If the operator reports `failed to validate storage secret`:

```bash
kubectl -n logging describe lokistack logging-loki | grep -A5 Storage
```

The condition message names the missing or malformed field. Compare its name to the schema for the chosen backend.

If the StatefulSet starts but Pods crash with object-store errors:

```bash
kubectl -n logging logs statefulset/logging-loki-distributor --tail=100 | grep -i bucket
```

A common pattern is `403 Forbidden` — usually the credentials are scoped to a different bucket than the one named in `bucketnames`. Re-issue the credentials, bind them to the correct bucket, recreate the Secret with `kubectl create secret ... --dry-run=client -o yaml | kubectl apply -f -`, then trigger a rollout:

```bash
kubectl -n logging rollout restart statefulset
```
