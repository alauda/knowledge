---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The cluster log store on the ACP platform logging stack (`observability/log` + the **Logging Service** extension) can be backed by two different engines:

- An Elasticsearch deployment, usually with Kibana for search.
- A Loki deployment (a `LokiStack` in-cluster, backed by object storage), queried from the platform's monitoring or logging console integration.

Elasticsearch is being phased out as the supported in-cluster log store. The replacement is Loki, which has a smaller resource footprint, is integrated with the platform's console for log-to-metric correlation, and is actively developed upstream. Clusters still running Elasticsearch as their log sink should migrate to a `LokiStack`-backed Loki deployment.

The migration is non-destructive for currently flowing logs — the collector can forward to both stores concurrently during a cut-over window. Historical log data does not automatically move across; plan separately whether to retain the Elasticsearch index as read-only for the retention window, or to export and re-ingest.

## Resolution

### 1. Pre-flight

Confirm the current log-store shape, record the retention / sizing, and budget for the new backing storage.

```bash
kubectl -n cluster-logging get elasticsearch
kubectl -n cluster-logging get clusterlogging instance \
  -o jsonpath='{.spec.logStore}{"\n"}'
```

Loki stores log chunks in object storage (S3-compatible). Make sure an object bucket is available — ACP's **MinIO** (`storage/storagesystem_minio`) is one path; any S3-compatible endpoint (AWS S3, GCS via interop, the cluster's Ceph RGW on `storage/storagesystem_ceph`) also works. Create:

- A bucket reserved for Loki chunks (for example `loki-chunks`).
- A service-account or access-key pair with read/write on the bucket.
- A Secret in the logging namespace holding the credentials and endpoint:

  ```yaml
  apiVersion: v1
  kind: Secret
  metadata:
    name: loki-object-storage
    namespace: cluster-logging
  type: Opaque
  stringData:
    access_key_id: "<AKID>"
    access_key_secret: "<SECRET>"
    endpoint: "https://s3.example.com"
    bucketnames: "loki-chunks"
    region: "us-east-1"
  ```

### 2. Install the Loki operator

Install the Loki operator through the ACP extension (`extend`) surface. Subscribe to the operator in the logging namespace and wait for the CSV to report `Succeeded`:

```bash
kubectl -n cluster-logging get csv | grep -i loki
```

### 3. Create a `LokiStack`

Size the `LokiStack` to match the observed log volume on the existing Elasticsearch index. A `small` / `1x.extra-small` size profile is enough for a moderate production cluster; step up if the Elasticsearch ingest rate was above roughly 5 MB/s.

```yaml
apiVersion: loki.grafana.com/v1
kind: LokiStack
metadata:
  name: logging-loki
  namespace: cluster-logging
spec:
  size: 1x.small
  storage:
    schemas:
      - version: v13
        effectiveDate: "2024-01-01"
    secret:
      name: loki-object-storage
      type: s3
  storageClassName: gp3-csi
  tenants:
    mode: static
    authentication:
      - tenantName: application
        tenantId: application
        oidc: {}
      - tenantName: infrastructure
        tenantId: infrastructure
        oidc: {}
      - tenantName: audit
        tenantId: audit
        oidc: {}
```

Apply and wait for the stack to come up:

```bash
kubectl apply -f lokistack.yaml
kubectl -n cluster-logging get lokistack logging-loki -o yaml | sed -n '/conditions:/,/^[a-z]/p'
kubectl -n cluster-logging get pods -l app.kubernetes.io/name=loki
```

### 4. Point the collector at Loki

Edit the `ClusterLogForwarder` to add a Loki output and a pipeline that forwards the same log streams there, alongside the existing Elasticsearch output:

```yaml
apiVersion: logging.k8s.io/v1
kind: ClusterLogForwarder
metadata:
  name: instance
  namespace: cluster-logging
spec:
  outputs:
    - name: default-loki
      type: lokiStack
      lokiStack:
        target:
          name: logging-loki
          namespace: cluster-logging
        authentication:
          token:
            from: serviceAccount
        labelKeys:
          application:
            ignoreGlobal: false
          infrastructure:
            ignoreGlobal: false
          audit:
            ignoreGlobal: false
    - name: default-es
      type: elasticsearch
      elasticsearch:
        url: https://elasticsearch.cluster-logging.svc:9200
        version: 6
  pipelines:
    - name: to-loki
      inputRefs:
        - application
        - infrastructure
        - audit
      outputRefs:
        - default-loki
    - name: to-es
      inputRefs:
        - application
        - infrastructure
        - audit
      outputRefs:
        - default-es
```

Run this dual-write mode long enough to be confident Loki is receiving the full stream (24–48 h is typical). Spot-check a record that is indexable in both — a message from a known pod — and confirm it appears on each side.

### 5. Cut over

Once Loki is confirmed as the source of truth, remove the Elasticsearch output and pipeline from the `ClusterLogForwarder`:

```bash
kubectl -n cluster-logging edit clusterlogforwarder instance
# delete the `default-es` output and the `to-es` pipeline block
```

Then switch the cluster-logging CR's `logStore` to `lokiStack`:

```bash
kubectl -n cluster-logging patch clusterlogging instance \
  --type=merge \
  -p '{"spec":{"logStore":{"type":"lokiStack","lokiStack":{"name":"logging-loki"}}}}'
```

### 6. Decommission Elasticsearch

Retain the Elasticsearch index as read-only for the data-retention window you require, or export / delete according to your data policy. When the index is no longer needed:

```bash
kubectl -n cluster-logging delete elasticsearch elasticsearch
kubectl -n cluster-logging delete kibana kibana 2>/dev/null || true
```

Free the PVCs that were backing the Elasticsearch data nodes:

```bash
kubectl -n cluster-logging get pvc -l app=elasticsearch
kubectl -n cluster-logging delete pvc -l app=elasticsearch
```

The object storage claimed by Loki persists in the bucket — size its lifecycle policy against the retention you want on Loki side.

## Diagnostic Steps

Confirm the collector has picked up both outputs while dual-writing:

```bash
POD=$(kubectl -n cluster-logging get pods -l component=collector \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n cluster-logging exec $POD -- vector top
```

Each output should show a non-zero input-event counter and a matching output-event counter within a tolerance of buffer flushing. A steadily climbing `component_errors_total` against the Loki sink points at either a credential problem on the object-storage Secret or a sizing issue on the `LokiStack`:

```bash
kubectl -n cluster-logging get lokistack logging-loki -o yaml \
  | yq '.status'
kubectl -n cluster-logging logs deploy/logging-loki-distributor --tail=200
```

A run of `429 Too Many Requests` from the distributor means the stream is exceeding the `LokiStack`'s per-tenant ingestion rate — bump the size class, or add a `LokiStack.spec.limits.tenants` override for the high-volume tenant.

Confirm searchability from the query side. Using the in-cluster `logcli` against the Loki gateway:

```bash
kubectl -n cluster-logging exec deploy/logging-loki-query-frontend -- \
  logcli query '{kubernetes_namespace_name="kube-system"}' --limit 5 \
  --addr=http://logging-loki-gateway.cluster-logging.svc.cluster.local
```

A non-empty result confirms: the collector is writing, the distributor is accepting, the ingester is flushing to object storage, and the querier can retrieve. Any empty return at this step localises the fault to whichever hop is zero on `vector top` or on the LokiStack `.status`.
</content>
</invoke>