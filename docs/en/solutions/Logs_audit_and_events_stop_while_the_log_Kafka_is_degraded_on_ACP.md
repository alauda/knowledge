---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Logs, audit and events stop while the log Kafka is degraded on ACP

## Issue

Platform logs, audit records and events stop arriving, and the log storage Kafka is part of the reason. Typical reports:

- "The Events tab in the application view is empty, and pods cannot be debugged."
- "Logs, audit and events stop six days ago."
- "One of three Kafka nodes failed, log collection stopped, and `razor` memory spiked."
- "The log disk was full, we deleted the data, and the observability page still shows no logs."

The broker is the log storage Kafka in `cpaas-system` (StatefulSet `cpaas-kafka`, pods `cpaas-kafka-0..2`, with `cpaas-zookeeper`). Its data is on node-local storage, typically `/cpaas/data/kafka0`, plus `/cpaas/data/kafka` and `/cpaas/data/zookeeper`. `lanaya` consumes the log topics into Elasticsearch. `razor` writes audit, events and logs into Kafka on clusters where it is deployed.

When a broker does not start at all, see [cpaas-kafka broker fails to start: corrupt segment, no space, broker id conflict, or deleted StatefulSet on ACP](./cpaas-kafka_broker_fails_to_start_corrupt_segment_no_space_broker_id_conflict_or_deleted_StatefulSet_on_ACP.md).

## Root Cause

### Cause 1: cpaas-kafka-0 is abnormal with a large kafka0 directory, and logs, audit and events stop

The application Events tab is empty, and a pod that cannot start cannot be debugged from the console. `kubectl describe pod` and `kubectl logs` from the backend still show the events and logs. Logs, audit records and events in platform management reach back only to a date several days earlier. The log storage plugin is stuck in `部署中` ("deploying").

`cpaas-kafka-0` is `0/1 Running`, while the other brokers, ZooKeeper, Elasticsearch and `razor` are `1/1`. The Grafana dashboard Platform Middleware / Log Center Plugin Status shows only 2 brokers up, and consumer group `alauda_audit` far behind on every `ALAUDA_AUDIT_TOPIC` partition. `du -sh *` under `/cpaas/data/` on the log storage node shows `kafka0` at tens of gigabytes.

After the owner confirmed that the accumulated data could be discarded, the consumers and Kafka were stopped and the `kafka0` directory was emptied. The log storage plugin then recovered, and the Events page showed events again.

A large `kafka0` alone is not this cause. When every broker is `Running` and the lag is still moving, it is consumption lag, which drains without deleting segments once `lanaya` and Elasticsearch catch up.

### Cause 2: One broker fails and every write fails, and razor is OOMKilled, because each partition needs two in-sync replicas

On a three-broker cluster, one broker failed. Log collection stopped, `razor` memory climbed, and all `razor` pods restarted with last state `Terminated`, `OOMKilled`, exit code `137`. Before the restart, `razor` repeated:

```text
server/server.go:78 | server | Failed to write kafka {"category": "logs", "error": "context deadline exceeded"}
```

It did not move to the healthy brokers. Its `--kafka-endpoint` listed all three broker addresses on port `9092`, so the client configuration is not the fault.

The broker configuration has `default.replication.factor=2` and `min.insync.replicas=2`. `kafka-topics.sh --describe` on `ALAUDA_LOG_TOPIC` shows replication factor 2 and `min.insync.replicas: 2`, and the producers use `acks=all`. Every partition has one of its two replicas on the failed broker, so every ISR drops to 1, below the minimum, and every write is refused. `razor` buffers what it cannot send until it is OOMKilled. When the broker comes back, memory and collection recover.

For `acks=all` producers, a topic tolerates one broker down only when the replication factor minus `min.insync.replicas` is at least 1. For example, factor 3 with minimum 2, or factor 2 with minimum 1.

### Cause 3: After a full log disk was cleaned, the observability page still shows no logs until Kafka and ZooKeeper start again in order

The log disk filled, and data was deleted to free it. The observability page still shows no logs. Deleting the Kafka and ZooKeeper data does not help, and neither does deleting the Elasticsearch, Kafka and ZooKeeper data and then the Elasticsearch log indices. Logs become visible again after `nevermore` is restarted and the Kafka and ZooKeeper data is deleted once more.

The failure is tied to the startup order of ZooKeeper, Kafka and Elasticsearch. Start ZooKeeper first, then Kafka once ZooKeeper is fully ready, then Elasticsearch once Kafka is fully ready. It is not known which of the last steps made the difference, so the Resolution repeats all of them in that order.

## Resolution

The Kafka commands below run inside `cpaas-kafka-0`. Use the listener and client properties file that this cluster's brokers expose. If a script is not on the `PATH`, it is in `/opt/kafka/bin/`.

### Cause 1: cpaas-kafka-0 is abnormal with a large kafka0 directory, and logs, audit and events stop

1. Confirm the signature. On the log storage node:

   ```bash
   cd /cpaas/data && du -sh *
   ```

   On the cluster:

   ```bash
   kubectl get pod -A -owide | grep -E 'kafka|razor|zookeeper|elas'
   ```

   In Grafana, Platform Middleware / Log Center Plugin Status, check how many brokers are up and the lag per consumer group.

2. Record the replica counts, then stop the consumers and Kafka:

   ```bash
   kubectl -n cpaas-system get deploy lanaya
   kubectl -n cpaas-system get sts cpaas-kafka
   kubectl -n cpaas-system scale deploy lanaya --replicas=0
   kubectl -n cpaas-system scale sts cpaas-kafka --replicas=0
   ```

   If the cluster also runs `razor` against this Kafka, stop it as well.

3. Empty `kafka0`.

   > **Warning:** Emptying `kafka0` discards every log, audit and event record still in Kafka, and those records never reach the store. Precondition: only when `cpaas-kafka-0` is abnormal, the directory is large, the owner has confirmed that the accumulated data can be discarded, and the consumers and Kafka are stopped. Rollback: none.

   On each log node:

   ```bash
   cd /cpaas/data/kafka0 && rm -rf ./*
   ```

4. Start Kafka, then the consumers, with their previous replica counts:

   ```bash
   kubectl -n cpaas-system scale sts cpaas-kafka --replicas=<previous>
   kubectl -n cpaas-system scale deploy lanaya --replicas=<previous>
   ```

   When the plugin is healthy, open an application's Events tab.

### Cause 2: One broker fails and every write fails, and razor is OOMKilled, because each partition needs two in-sync replicas

1. Confirm the signature:

   ```bash
   kubectl -n cpaas-system exec cpaas-kafka-0 -- \
     kafka-topics.sh --bootstrap-server <bootstrap> \
     --command-config <client-properties> --describe --topic ALAUDA_LOG_TOPIC
   kubectl -n cpaas-system logs <razor-pod> -p | grep 'Failed to write kafka'
   kubectl -n cpaas-system describe pod <razor-pod> | grep -E 'OOMKilled|Restart Count'
   ```

   `ReplicationFactor: 2` with `min.insync.replicas=2`, and an `Isr` of one broker for every partition while one broker is down, match this cause.

2. Bring the failed broker back first. That alone restores collection.

3. To tolerate one broker down in the future, change the topic configuration together with product support, in a maintenance window. Read the current topic configuration:

   ```bash
   kubectl -n cpaas-system exec cpaas-kafka-0 -- \
     kafka-configs.sh --bootstrap-server <bootstrap> \
     --command-config <client-properties> --describe --entity-type topics --entity-name ALAUDA_LOG_TOPIC
   ```

   > **Warning:** Lowering `min.insync.replicas` to 1 lets a write succeed with a single copy, so losing that broker before replication catches up loses those records. Raising the replication factor instead needs a partition reassignment and more disk on every broker. Precondition: only when this cause is confirmed and the change is agreed. Rollback: `kafka-configs.sh ... --alter --entity-type topics --entity-name ALAUDA_LOG_TOPIC --delete-config min.insync.replicas` returns the topic to the broker default.

   Check `ALAUDA_AUDIT_TOPIC` and `ALAUDA_EVENT_TOPIC` the same way, because `razor` also writes audit records and events.

### Cause 3: After a full log disk was cleaned, the observability page still shows no logs until Kafka and ZooKeeper start again in order

1. Record the replica counts, confirm that the disk has room, and check whether the log storage workloads came up together after the cleanup:

   ```bash
   df -hT /cpaas /cpaas/data
   kubectl -n cpaas-system get sts cpaas-zookeeper cpaas-kafka cpaas-elasticsearch
   kubectl -n cpaas-system get pods -o wide | grep -E 'cpaas-zookeeper|cpaas-kafka|cpaas-elasticsearch|nevermore'
   ```

2. Restart the collector.

   > **Warning:** Restarting DaemonSet `nevermore` pauses log, audit and event collection on each node while its pod restarts. Precondition: only when logs are still missing after the disk cleanup and the log storage pods are `Running`. Rollback: none needed; the DaemonSet recreates the pods.

   ```bash
   kubectl -n cpaas-system rollout restart ds/nevermore
   kubectl -n cpaas-system rollout status ds/nevermore
   ```

3. If logs are still missing, stop Elasticsearch, Kafka and ZooKeeper:

   ```bash
   kubectl -n cpaas-system scale sts cpaas-elasticsearch cpaas-kafka cpaas-zookeeper --replicas=0
   kubectl -n cpaas-system get pods | grep -E 'cpaas-zookeeper|cpaas-kafka|cpaas-elasticsearch'
   ```

4. Empty the Kafka and ZooKeeper directories.

   > **Warning:** Emptying `/cpaas/data/zookeeper`, `/cpaas/data/kafka` and `/cpaas/data/kafka0` deletes every log, audit and event record still in Kafka and the ZooKeeper state of the log cluster, and those records never reach storage. Elasticsearch indices are not touched. Precondition: only when the log disk was already cleaned, logs are still not visible after the `nevermore` restart, and all three StatefulSets are at 0 replicas. Rollback: none.

   On each Kafka node, empty the directories and keep them:

   ```bash
   cd /cpaas/data/zookeeper && rm -rf ./*
   cd /cpaas/data/kafka && rm -rf ./*
   cd /cpaas/data/kafka0 && rm -rf ./*
   ```

5. Start ZooKeeper, then Kafka, then Elasticsearch, and wait for each to be fully ready before the next. Use the replica counts you recorded:

   ```bash
   kubectl -n cpaas-system scale sts cpaas-zookeeper --replicas=<previous>
   kubectl -n cpaas-system rollout status sts/cpaas-zookeeper
   kubectl -n cpaas-system scale sts cpaas-kafka --replicas=<previous>
   kubectl -n cpaas-system rollout status sts/cpaas-kafka
   kubectl -n cpaas-system scale sts cpaas-elasticsearch --replicas=<previous>
   kubectl -n cpaas-system rollout status sts/cpaas-elasticsearch
   ```

   If `kubectl get deploy,sts` shows Elasticsearch as a Deployment on this cluster, scale `deploy/cpaas-elasticsearch` instead.

6. When all pods are `Running`, query current logs on the observability page.

## Diagnostic Steps

1. Read the broker and consumer state:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep -E 'kafka|zookeeper|razor|lanaya'
   kubectl -n cpaas-system logs -p cpaas-kafka-0 | tail -30
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | `cpaas-kafka-0` at `0/1` with a very large `kafka0` and old data, and the plugin stuck deploying | Cause 1 |
   | Every broker `Running` and lag still moving | Consumption lag, do not empty `kafka0` |
   | All brokers but one up, writes refused, and `razor` `OOMKilled` | Cause 2, read the topic describe for the factor and `min.insync.replicas` |
   | Every log pod `Running` after a full-disk cleanup, and still no logs on the observability page | Cause 3 |

## Related Information

- Related articles: [cpaas-kafka broker fails to start: corrupt segment, no space, broker id conflict, or deleted StatefulSet on ACP](./cpaas-kafka_broker_fails_to_start_corrupt_segment_no_space_broker_id_conflict_or_deleted_StatefulSet_on_ACP.md) covers brokers that do not start.
- [Log Kafka lag on a single partition from oversized log entries or a stuck offset on ACP](./Log_Kafka_lag_on_a_single_partition_from_oversized_log_entries_or_a_stuck_offset_on_ACP.md)
- [Elasticsearch log storage Pending or every cluster loses logs after the log disk fills on ACP](./Elasticsearch_log_storage_Pending_or_every_cluster_loses_logs_after_the_log_disk_fills_on_ACP.md)
