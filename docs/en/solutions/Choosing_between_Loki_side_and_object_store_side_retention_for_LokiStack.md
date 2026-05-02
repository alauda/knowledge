---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A LokiStack-backed log store keeps growing indefinitely. The expected behaviour was that old logs would be pruned after some retention period, but objects remain in the backing bucket forever. Three related questions usually surface together:

- Where is retention supposed to be set — in the LokiStack CR (`spec.limits.global.retention`, `spec.limits.tenants.<tenant>.retention`) or in the object-store bucket lifecycle?
- If retention is set in the LokiStack CR, when does the data actually disappear from the bucket?
- Is there a way to delete already-accumulated logs that predate the retention configuration?

## Resolution

LokiStack supports two retention paths and they are not equivalent.

### Path 1 — bucket-side lifecycle policy (recommended)

Every supported object-storage backend exposes some form of bucket lifecycle policy that auto-deletes objects after N days. Examples:

- **S3 / MinIO** — `aws s3api put-bucket-lifecycle-configuration` with a JSON policy that targets the LokiStack key prefix.
- **Ceph RGW (`storagesystem_ceph`)** — `radosgw-admin` lifecycle subcommand or the S3-compatible API.
- **GCS** — `gsutil lifecycle set`.
- **Azure Blob** — Lifecycle Management blade in the storage account.

Retention configured at the bucket layer:

- runs on the storage provider's own scheduler (no in-cluster cost),
- prunes whole objects without any chunk-level bookkeeping,
- avoids the API-call costs that Loki's compactor incurs when it asks the backend to delete chunks one at a time,
- has no "sweeper lag" — objects vanish at the policy-evaluation cadence, not on Loki's compaction interval.

For a uniform retention across every tenant and stream, this is the supported path. Set the bucket lifecycle and leave the LokiStack CR's retention block empty.

Sample S3-compatible lifecycle (delete every object older than 7 days under the loki key prefix):

```json
{
  "Rules": [
    {
      "ID": "loki-7d-retention",
      "Status": "Enabled",
      "Filter": { "Prefix": "loki/" },
      "Expiration": { "Days": 7 }
    }
  ]
}
```

```bash
aws --endpoint-url https://s3.example.com s3api put-bucket-lifecycle-configuration \
  --bucket cpaas-loki \
  --lifecycle-configuration file://lifecycle.json
```

Verify the policy is in force:

```bash
aws --endpoint-url https://s3.example.com s3api get-bucket-lifecycle-configuration \
  --bucket cpaas-loki
```

### Path 2 — Loki-side retention via the LokiStack CR

The LokiStack CR exposes per-tier retention that the Loki compactor enforces. The compactor walks the index, marks chunks older than the limit for deletion, then issues backend deletes. Use this path when the cluster needs different retention windows per tenant or per labelled stream — bucket lifecycle cannot tell streams apart, but Loki can.

Global retention of 7 days:

```yaml
apiVersion: loki.grafana.com/v1
kind: LokiStack
metadata:
  name: logging-loki
  namespace: cpaas-logging
spec:
  managementState: Managed
  limits:
    global:
      retention:
        days: 7
```

Per-tenant retention (different for `application`, `infrastructure`, `audit`):

```yaml
spec:
  limits:
    global:
      retention:
        days: 30
    tenants:
      application:
        retention:
          days: 7
      audit:
        retention:
          days: 90
```

Per-stream retention via `streams[]` selectors (use to keep one team's logs longer than the namespace default):

```yaml
spec:
  limits:
    tenants:
      application:
        retention:
          days: 7
          streams:
            - selector: '{kubernetes_namespace_name="payments"}'
              days: 30
```

Apply the LokiStack CR and watch the compactor pod log start to issue retention scans:

```bash
kubectl -n cpaas-logging logs deploy/lokistack-compactor --tail=200 \
  | grep -E 'retention|compaction'
```

The compactor runs every `compactor.compaction-interval` (default 10 minutes). Real bucket-side deletion lags Loki's mark by a few interval cycles — there will be objects past the retention window present in the bucket for some time. For very tight retention (e.g. < 24 hours), this lag is visible in the bucket size graph.

### Choosing between the two

| Use case | Recommended path |
|---|---|
| One uniform retention for all logs | **Bucket lifecycle.** Don't touch LokiStack CR retention. |
| Different retention per tenant or per stream | **LokiStack CR retention.** Optionally pair with a generous bucket-side lifecycle as a safety net. |
| Need to delete already-accumulated old logs immediately | Apply bucket lifecycle (it acts on existing objects within hours), or invoke a one-off `compactor` retention pass with a tight LokiStack `days` value. |
| Storage provider charges per API call (cloud S3) | **Bucket lifecycle.** Loki compactor's per-chunk delete API calls are billed per call. |

If both paths are configured, the more aggressive of the two wins — bucket lifecycle is the floor (it deletes regardless of what Loki thinks), Loki's compactor is a finer-grained overlay on top.

### Object-storage gotcha — lifecycle policies that don't actually delete

Some object stores have bugs in their lifecycle implementation that leave residual objects around. The known offenders include older NooBaa/MCG releases on Ceph that mark objects for deletion but never finish the sweep. If the bucket size keeps growing despite a configured lifecycle, audit the bucket directly:

```bash
aws --endpoint-url https://s3.example.com s3 ls s3://cpaas-loki --recursive --summarize \
  | tail -3
```

A growing object count over days where every object should have been pruned points at the storage backend, not Loki. In that case, fall back to LokiStack CR retention until the storage backend is upgraded.

## Diagnostic Steps

Confirm the LokiStack CR retention took effect:

```bash
kubectl -n cpaas-logging get lokistack logging-loki \
  -o jsonpath='{.spec.limits}' | jq
```

Confirm the compactor pod is running and processing retention:

```bash
kubectl -n cpaas-logging get pod -l app.kubernetes.io/component=compactor
kubectl -n cpaas-logging logs deploy/lokistack-compactor --tail=100 \
  | grep -E 'retention sweep|deleted'
```

Lines like `retention sweep finished, deleted N chunks` confirm Loki is doing its job.

For bucket-side lifecycle, list the policy and the most recent objects to spot stragglers:

```bash
aws --endpoint-url https://s3.example.com s3api get-bucket-lifecycle-configuration \
  --bucket cpaas-loki

aws --endpoint-url https://s3.example.com s3 ls s3://cpaas-loki/loki/index/ \
  --recursive | sort -k1,2 | tail -20
```

Files older than the configured days are objects the lifecycle policy has not yet pruned — wait one full lifecycle interval (typically 24 h) before assuming a bug.

If chunks survive but indices are gone (or vice versa), the compactor's retention pass crashed mid-sweep. Restart it and rerun:

```bash
kubectl -n cpaas-logging rollout restart deploy/lokistack-compactor
```

For a manual one-off purge of everything older than a fixed timestamp (recovery scenario only — no point-in-time recovery after this), use the storage provider's CLI directly to delete by `LastModified` filter rather than waiting on Loki's compactor.
