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

# Log Kafka lag on a single partition from oversized log entries or a stuck offset on ACP

## Issue

Logs are late or missing, and the lag of the platform log Kafka sits on **one** partition of `ALAUDA_LOG_TOPIC`, while the other partitions are at 1 or 2. Typical reports:

- "Kafka is backed up and log query fails."
- "One partition has all the lag."
- "One partition does not consume logs, and `lanaya` shows many errors."
- The alert `Kafka 消费队列滞后增长速率 > 0 且持续 1 分钟` ("Kafka consumer lag growth rate above 0 for 1 minute") fires again and again.

The application log topic is `ALAUDA_LOG_TOPIC`, and its platform consumer group is `alauda_log`. `lanaya` (Deployment in `cpaas-system`) consumes the topic and bulk-writes to Elasticsearch. It takes the next batch of a partition only after the current batch is persisted, so one bulk that keeps failing stops that partition. The `lanaya` bulk size is set with the `-es-bulk-size` flag (default 10000). The Elasticsearch settings are in ConfigMap `es-config` in `cpaas-system`.

Per-partition lag is shown on the Grafana dashboards `log/Cpaas Log Stack for Elasticsearch` (Lag detail by `alauda_log/<partition>`) and `Platform Middleware / Kafka Cluster Status`. You can also read it from `kafka-consumer-groups.sh --describe`.

When the lag is spread over many partitions, or two Elasticsearch nodes carry all the load, see [Log Kafka lag from Elasticsearch write hot spots, breaker trips, IK analyzer errors, or too few partitions on ACP](./Log_Kafka_lag_from_Elasticsearch_write_hot_spots_breaker_trips_IK_analyzer_errors_or_too_few_partitions_on_ACP.md).

## Root Cause

### Cause 1: Lag sits on one partition because a few log entries are too large

All the lag is on the log topic, on one partition. On the `log/Cpaas Log Stack for Elasticsearch` dashboard the production and consumption rates match, while the lag of one partition rises in a straight line past 40,000. Every other partition stays at 1 or 2. The broker logs show only routine segment deletion. Scaling `lanaya` out to more replicas has no effect.

The `lanaya` log for that partition shows repeated `Try to record message` entries and Kafka reader entries with a very large `"Content-Length"` (about 10 MB). Filtered by the consumer id, the log shows a loop:

```text
Try to do bulk {"from": 701, "to": 1402, "batch": 701}
Do bulk error ... "error": "[413 Request Entity Too Large] "
Failed to insert message, abort
Try to do consume again
```

Elasticsearch returns `413` for the bulk, because some application log entries are individually huge. Raising `http.max_content_length` to `2000mb` in ConfigMap `es-config`, and setting `-es-bulk-size=100` on `lanaya`, makes the partition move again. A small bulk size lowers throughput, so the lasting fix is to stop the application from writing oversized entries, and then return `-es-bulk-size` to its default.

### Cause 2: One partition stops consuming at a fixed offset, and the stuck record is skipped with kafka-delete-records.sh

One partition of the log topic does not consume at all. Its `CURRENT-OFFSET` stays at one fixed offset, while `lanaya` logs many errors. If the `lanaya` lines for that partition show the `413` loop, use Cause 1 first. No more specific root cause is known. The remediation is to delete the records of that partition up to its latest offset with `kafka-delete-records.sh`, so that the consumer moves past the record it cannot process.

## Resolution

The Kafka commands below run inside `cpaas-kafka-0`. Use the listener and client configuration that this cluster's brokers expose. On some clusters the plaintext `localhost:9092` listener times out, while the TLS listener works with the client properties file mounted in the pod. Do not mix the two. If a script is not on the `PATH`, it is in `/opt/kafka/bin/`.

### Cause 1: Lag sits on one partition because a few log entries are too large

1. Find the `lanaya` lines for the lagging partition, then the bulk loop for its consumer:

   ```bash
   for p in $(kubectl -n cpaas-system get pods -o name | grep lanaya); do
     echo "== $p"
     kubectl -n cpaas-system logs "$p" --tail 10000 | grep '"ptn": "<partition>"' | grep log | tail -3
   done
   kubectl -n cpaas-system logs <lanaya-pod> --tail 10000 | grep '<consumer-id>' | grep -E 'Try to do bulk|413|abort' | tail -10
   ```

   Replace `<partition>` with the lagging partition, and `<consumer-id>` with the id shown on those lines (for example `log-01-04i`). A `413 Request Entity Too Large` loop for that consumer matches this cause.

2. Save the current configuration:

   ```bash
   kubectl -n cpaas-system get cm es-config -o yaml > /tmp/es-config.before.yaml
   kubectl -n cpaas-system get deploy lanaya -o yaml > /tmp/lanaya.before.yaml
   ```

3. Raise the request size limit and lower the bulk size.

   > **Warning:** A larger `http.max_content_length` lets one request use more heap, and a smaller `-es-bulk-size` lowers `lanaya` throughput on every partition. The `lanaya` edit restarts its pods. `http.max_content_length` is a static Elasticsearch node setting, so it takes effect only after the Elasticsearch pods restart. Restart them one at a time. Elasticsearch does not accept a value above about 2 GB, so do not go past `2000mb`. Precondition: only when this cause is confirmed (lag on one partition and `413` in `lanaya` for it), and the Elasticsearch heap is about half of its memory limit. Rollback: apply `/tmp/es-config.before.yaml` and `/tmp/lanaya.before.yaml`, then restart Elasticsearch one pod at a time.

   ```bash
   kubectl -n cpaas-system edit cm es-config
   kubectl -n cpaas-system edit deploy lanaya
   ```

   Set `http.max_content_length: 2000mb` in `es-config`, and add `-es-bulk-size=100` to the `lanaya` arguments. Restart the Elasticsearch pods one at a time:

   ```bash
   for p in $(kubectl -n cpaas-system get pod -l service_name=cpaas-elasticsearch -o name); do
     kubectl -n cpaas-system delete "$p"; sleep 15
     kubectl -n cpaas-system wait --for=condition=Ready "$p" --timeout=15m
   done
   ```

4. After the partition catches up and the application no longer writes oversized entries, remove `-es-bulk-size` again.

### Cause 2: One partition stops consuming at a fixed offset, and the stuck record is skipped with kafka-delete-records.sh

1. Read the stuck offset and the log-end offset of each partition:

   ```bash
   kubectl -n cpaas-system exec cpaas-kafka-0 -- \
     kafka-consumer-groups.sh --bootstrap-server <bootstrap> \
     --command-config <client-properties> --describe --group alauda_log
   ```

   A partition whose `CURRENT-OFFSET` does not move between runs, while the other partitions advance, matches this cause.

2. Delete the records of that partition up to the log-end offset.

   > **Warning:** `kafka-delete-records.sh` permanently deletes every record in that partition below the offset you give. With the log-end offset, the whole unconsumed range of that partition never reaches the log store. Precondition: only when one partition is stuck at a fixed offset while the others consume, Cause 1 is ruled out, and losing those records is accepted. Rollback: none.

   ```bash
   kubectl -n cpaas-system exec -i cpaas-kafka-0 -- sh -c 'cat > /tmp/delete-records.json' <<'EOF'
   {"partitions": [{"topic": "ALAUDA_LOG_TOPIC", "partition": <partition>, "offset": <log-end-offset>}], "version": 1}
   EOF
   kubectl -n cpaas-system exec cpaas-kafka-0 -- \
     kafka-delete-records.sh --bootstrap-server <bootstrap> \
     --command-config <client-properties> --offset-json-file /tmp/delete-records.json
   ```

   Use the topic and partition that the describe output named.

3. Run the describe again and confirm that `CURRENT-OFFSET` moves.

## Diagnostic Steps

1. Read per-partition lag from the dashboard, or with the group describe in Cause 2.

2. Check the consumer:

   ```bash
   kubectl -n cpaas-system logs deploy/lanaya --tail=300 | grep -Ei '413|Failed to insert|abort'
   ```

3. Match the signature:

   | What you see | Cause |
   |---|---|
   | Lag on one partition, and `lanaya` repeats `413 Request Entity Too Large` for it | Cause 1 |
   | Lag on one partition whose `CURRENT-OFFSET` stays at one fixed offset, without the `413` loop | Cause 2 |
   | Lag on many partitions, or two Elasticsearch nodes near 100% CPU | See the related article |

## Related Information

- Related articles: [Log Kafka lag from Elasticsearch write hot spots, breaker trips, IK analyzer errors, or too few partitions on ACP](./Log_Kafka_lag_from_Elasticsearch_write_hot_spots_breaker_trips_IK_analyzer_errors_or_too_few_partitions_on_ACP.md) covers lag spread over many partitions and lag caused by the Elasticsearch side.
- [Logs, audit and events stop while the log Kafka is degraded on ACP](./Logs_audit_and_events_stop_while_the_log_Kafka_is_degraded_on_ACP.md)
