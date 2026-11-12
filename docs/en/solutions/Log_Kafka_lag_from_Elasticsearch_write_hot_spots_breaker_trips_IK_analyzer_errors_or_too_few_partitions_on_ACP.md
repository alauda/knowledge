---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.8.x
  - 3.14.x
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Log Kafka lag from Elasticsearch write hot spots, breaker trips, IK analyzer errors, or too few partitions on ACP

## Issue

Logs are late or missing, and the platform log Kafka is backed up. Unlike a plain capacity shortage, the lag has a recognizable shape:

- Two Elasticsearch nodes sit at nearly 100% CPU while a third one idles.
- `lanaya` reports a `Data too large` circuit-breaker message.
- `lanaya` loops on `bulk response error`, and the Elasticsearch log shows IK analyzer offset errors.
- The lag is spread evenly over every partition of a topic that has too few partitions for the clusters it serves, while Elasticsearch has headroom.

The application log topic is `ALAUDA_LOG_TOPIC`, and its platform consumer group is `alauda_log`. `lanaya` (Deployment in `cpaas-system`) consumes it and bulk-writes to Elasticsearch, taking the next batch of a partition only after the current one is persisted.

When the lag sits on a single partition, see [Log Kafka lag on a single partition from oversized log entries or a stuck offset on ACP](./Log_Kafka_lag_on_a_single_partition_from_oversized_log_entries_or_a_stuck_offset_on_ACP.md).

## Root Cause

### Cause 1: Application log indices have one primary shard, so two nodes carry all writes

The daily application index (`log-workload-<date>`) is created with one primary shard. It therefore lands on two Elasticsearch nodes, one for the primary and one for the replica. Those two nodes sit at about 96% CPU while the third idles, and Kafka backs up. Scaling Elasticsearch out does not spread the load. The index can stay `yellow` (1 primary, 1 replica, hundreds of millions of documents), with one shard stuck initializing while the index keeps growing.

The shard count comes from the `log.json` index template (`"index_patterns": "log-*"`, `"index.lifecycle.name": "alauda-log"`). The platform manages that template through key `log.json` of ConfigMap `aiops-logging-config` in `cpaas-system`. Changing `"number_of_shards"` from 1 to `3`, while keeping `"number_of_replicas": 1` and `"refresh_interval": "10s"`, spreads the writes, and log queries return to normal.

When `lanaya` already has as many replicas as the topic has partitions and the daily index still has a single shard on one hot node, the backlog can also clear on its own once the Elasticsearch load drops. Check the `log.json` template in that case as well.

### Cause 2: lanaya writes fail with Data too large from the parent circuit breaker

`lanaya` logs a write error such as:

```text
Data too large, data for [<transport_request>] would be [8958381455/8.3gb], which is larger than the limit of [8958371430/8.3gb], usages [request=0/0b, fielddata=7652620260/7.1gb, ...
```

The Elasticsearch pods are healthy. Fielddata holds most of the breaker budget (7.1 GB of 8.3 GB here), so each bulk write trips the parent breaker, and the displayed logs fall behind. Raising `indices.breaker.total.limit` to `92%` and `indices.breaker.fielddata.limit` to `85%` restores writes. Treat this as a temporary fix. Adding heap is the lasting one.

### Cause 3: lanaya repeats bulk response error because the Elasticsearch IK analyzer rejects documents

`lanaya` cannot consume and loops on:

```text
elasticsearch/elasticsearch.go:166] Database bulk error {"bulkSize": 10000, ... "error": "bulk response error"}
consumer/consumer.go:107] Failed to insert message ... "error": "bulk response error"
consumer/consumer.go:48] Failed to consume message, try to reconnect {"category": "log", ... "error": "bulk response error"}
```

The platform Elasticsearch log (for example Elasticsearch 6.8.23 on ACP 3.14.1) repeats `failed to execute bulk item` for `log-platform-<date>` with:

```text
java.lang.IllegalArgumentException: startOffset must be non-negative, and endOffset must be >= startOffset, and offsets must not go backwards startOffset=846,endOffset=847,lastStartOffset=847 for field 'log_data'
```

A line such as `(index) index {[log-platform-<date>][_doc][...], source[n/a, actual length: [2.7kb], max length: 2kb]}` may be the first error found. It only shows a truncated document in the log message and is not the cause. Without the Elasticsearch hotfix, the platform is affected by a known IK analyzer issue that produces these offset errors on `log_data`. Replacing the Elasticsearch image with the fixed one lets `lanaya` consume normally again.

### Cause 4: The topic has too few partitions for the clusters it serves

An Elasticsearch with 3 master and 8 data nodes stores logs for 15 clusters. Elasticsearch runs at about 60% memory and 40% CPU, the indices are normal, and the cluster is still behind. `_cluster/health` is `green` with 0 unassigned shards, and every log component is `Running` without restarts. The `lanaya` logs show delays (`dly`) of tens of hours on the log partitions.

Consumption parallelism is too low for the volume. Expanding the log topic from 30 to 60 partitions makes the platform backlog, and the backlog of external consumer groups, fall steadily. `lanaya` replicas beyond the partition count add nothing, and adding replicas does not help while Elasticsearch is the limit. A `razor` line such as `Validate token error ... the server has asked for the client to provide credentials` in the same period is not related.

## Resolution

Load the Elasticsearch credentials once for the API calls below:

```bash
ES_USER=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.username}' | base64 -d)
ES_PASS=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.password}' | base64 -d)
es() { kubectl -n cpaas-system exec cpaas-elasticsearch-0 -c cpaas-elasticsearch -- \
  curl -sS -u "${ES_USER}:${ES_PASS}" "$@"; }
```

### Cause 1: Application log indices have one primary shard, so two nodes carry all writes

1. Confirm the signature:

   ```bash
   es 'http://cpaas-elasticsearch:9200/_cat/shards/log-workload-*?v&s=index' | tail -20
   es 'http://cpaas-elasticsearch:9200/_cat/nodes?v&h=name,cpu,heap.percent'
   es 'http://cpaas-elasticsearch:9200/_template?pretty' | grep -n -E '"log-\*"|number_of_shards|number_of_replicas|alauda-log'
   ```

   One primary (`p`) and one replica (`r`) per daily application index, with two nodes near 96% CPU, matches this cause.

2. Change the shard count in the ConfigMap. The platform reverts direct template edits, so edit it here.

   > **Warning:** Changing `number_of_shards` in the `log.json` template affects every index created from it afterwards. More shards per daily index means more shards in the cluster in total. Precondition: only when the daily application index has one primary and two nodes carry the write load. Rollback: `kubectl apply -f /tmp/aiops-logging-config.before.yaml`; indices that already exist keep the shard count they were created with.

   ```bash
   kubectl -n cpaas-system get cm aiops-logging-config -o yaml > /tmp/aiops-logging-config.before.yaml
   kubectl -n cpaas-system edit cm aiops-logging-config
   ```

   In key `log.json`, set `"number_of_shards": 3`, and keep `"number_of_replicas": 1` and `"refresh_interval": "10s"`.

3. Existing indices keep their shard count, so the load spreads from the next daily index onward.

### Cause 2: lanaya writes fail with Data too large from the parent circuit breaker

1. Confirm the signature:

   ```bash
   kubectl -n cpaas-system logs deploy/lanaya --tail=200 | grep 'Data too large'
   es 'http://cpaas-elasticsearch:9200/_nodes/stats/breaker?pretty' | grep -E '"(parent|fielddata)"|limit_size|estimated_size'
   ```

2. Raise the breaker limits.

   > **Warning:** Raising the breaker limits lets Elasticsearch use more heap before it rejects requests. If the heap is really exhausted, the node can hit a Java `OutOfMemoryError` instead of rejecting the write. Precondition: only when `lanaya` logs `Data too large` and fielddata dominates the usage. Save the current settings first. Rollback: set both keys to `null` to return to the defaults.

   ```bash
   es 'http://cpaas-elasticsearch:9200/_cluster/settings?pretty' > /tmp/es-cluster-settings.before.json
   es -X PUT -H 'Content-Type: application/json' \
     'http://cpaas-elasticsearch:9200/_cluster/settings' \
     -d '{"persistent":{"indices.breaker.total.limit":"92%","indices.breaker.fielddata.limit":"85%"}}'
   ```

3. Writes should resume immediately. If the breaker keeps tripping, add heap by raising the Elasticsearch memory limit on the log storage plugin.

### Cause 3: lanaya repeats bulk response error because the Elasticsearch IK analyzer rejects documents

1. Confirm the signature:

   ```bash
   kubectl -n cpaas-system logs deploy/lanaya --tail=500 | grep -E 'bulk response error' | tail -5
   for p in $(kubectl -n cpaas-system get pod -l service_name=cpaas-elasticsearch -o name); do
     kubectl -n cpaas-system logs "$p" -c cpaas-elasticsearch --tail=2000 | grep -m3 'startOffset must be non-negative'
   done
   kubectl -n cpaas-system get sts cpaas-elasticsearch -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
   ```

   `startOffset must be non-negative ... for field 'log_data'` in the Elasticsearch log, together with `bulk response error` in `lanaya`, matches this cause.

2. Ask Alauda support for the Elasticsearch hotfix image that matches the platform version. Compare its tag with the image printed above to see whether the hotfix is already applied.

3. Apply the hotfix image.

   > **Warning:** Replacing the Elasticsearch image rolls every Elasticsearch pod, and search and ingestion pause on each pod while it restarts. Precondition: only when the offset error is confirmed, the hotfix image is the one provided for this platform version, and you saved the StatefulSet (and the `rpch` that pins the image, if one exists). Rollback: apply the saved StatefulSet or `rpch` to return to the previous image.

   ```bash
   kubectl -n cpaas-system get sts cpaas-elasticsearch -o yaml > /tmp/cpaas-elasticsearch.sts.before.yaml
   kubectl get rpch -A | grep -i elasticsearch
   ```

   Apply the image the way support specifies for that version. Then confirm that `lanaya` stops logging `bulk response error` and that the consume rate rises.

### Cause 4: The topic has too few partitions for the clusters it serves

1. Read the current partition count. Use the listener and client configuration that this cluster's brokers expose:

   ```bash
   kubectl -n cpaas-system exec cpaas-kafka-0 -- \
     kafka-topics.sh --bootstrap-server <bootstrap> \
     --command-config <client-properties> --describe --topic ALAUDA_LOG_TOPIC | head -3
   ```

2. Add partitions.

   > **Warning:** A partition count can only be increased. New partitions change which partition a key maps to, and they use more broker disk and file handles. Precondition: only when Elasticsearch has headroom (Causes 1 to 3 are ruled out) and the lag persists across many partitions. Rollback: none; a topic cannot shrink its partition count.

   ```bash
   kubectl -n cpaas-system exec cpaas-kafka-0 -- \
     kafka-topics.sh --bootstrap-server <bootstrap> \
     --command-config <client-properties> --alter --topic ALAUDA_LOG_TOPIC --partitions 60
   ```

3. Watch the platform and external consumer groups in the describe output. Both backlogs should fall steadily. Scale `lanaya` only up to the partition count.

## Diagnostic Steps

1. Read per-partition lag from the `log/Cpaas Log Stack for Elasticsearch` dashboard or with `kafka-consumer-groups.sh --describe --group alauda_log`.

2. Check the consumer and the nodes:

   ```bash
   kubectl -n cpaas-system logs deploy/lanaya --tail=300 | grep -Ei 'Data too large|bulk response error|Failed to insert'
   es 'http://cpaas-elasticsearch:9200/_cat/nodes?v&h=name,cpu,heap.percent'
   es 'http://cpaas-elasticsearch:9200/_cat/indices?v' | grep -v green
   ```

3. Match the signature:

   | What you see | Cause |
   |---|---|
   | Two nodes near 100% CPU and a third idle, with today's `log-workload-*` index at one primary | Cause 1 |
   | `Data too large` with fielddata holding most of the breaker | Cause 2 |
   | `bulk response error` in `lanaya` and `startOffset must be non-negative` in the Elasticsearch log | Cause 3 |
   | Lag spread evenly over every partition, Elasticsearch well below its limits, and all indices `green` | Cause 4 |

## Related Information

- Related articles: [Log Kafka lag on a single partition from oversized log entries or a stuck offset on ACP](./Log_Kafka_lag_on_a_single_partition_from_oversized_log_entries_or_a_stuck_offset_on_ACP.md) covers lag that sits on one partition.
- [Elasticsearch log index replica count reverts after editing the index template on ACP](./Elasticsearch_log_index_replica_count_reverts_after_editing_the_index_template_on_ACP.md)
- [Log search misses entries: IK analyzer tokens, uppercase keywords, clock skew, or page scope on ACP](./Log_search_misses_entries_IK_analyzer_tokens_uppercase_keywords_clock_skew_or_page_scope_on_ACP.md)
