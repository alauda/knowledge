---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
  - Alauda Application Services
ProductsVersion:
  - "3.10"
  - "3.12"
  - "3.14"
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
---

# Kafka log disk grows to hundreds of gigabytes or topic retention differs from the configured value on ACP

## Issue

One of these is reported for Kafka:

- On the log nodes, `/cpaas/data/kafka0` or a broker PVC climbs to hundreds of gigabytes, although consumer lag is near zero and log delay is under a minute.
- One broker restarts in a loop while its peers stay up, and only that node's `kafka0` directory is hundreds of gigabytes. The peers' `/opt/kafka/logs/server.log` repeats, from `ReplicaFetcherThread`:

```text
java.io.IOException: Connection to <broker-address>:9092 (id: <broker-id> rack: null) failed.
```

- Data Services topic retention was set to 2 hours, but a topic still shows 168 hours after it is created or synced in the console.

Related articles: *Kafka broker PVC full or still too small after expansion on ACP* (expanding a full broker PVC and aligning the `Kafka` CR size), and *Avoid Kafka Topic Data Loss When Deleting an Abnormal Topic CR* (deleting an abnormal `RdsTopic` on affected versions).

## Root Cause

### Cause 1: Hundreds of gigabytes on disk with almost no lag

`kafka0` holds more than 600 GB on most brokers, consumer lag is not growing, and end-to-end log delay is under one minute. Consumed records stay on disk until the retention time or the log size limit deletes them, so the volume matches roughly `daily ingest x replica count x retention` (for example 48 hours of retention with two replicas). If the log shipper does not compress, the volume is larger still. Segments of other topics (for example `devops-pipeline`) that are still inside the retention window are kept as well. This state is normal.

It is not this cause when one broker is several times larger than its peers, that broker is restarting, and the ISR contains only that broker; that is Cause 3.

### Cause 2: Console sync writes a 168-hour template over the retention you set

In Data Services the global topic retention is set to 2 hours, but a topic created afterwards still shows 168 hours. Changing `log.retention.hours` and restarting Kafka does not change it, and neither does writing the same value through the configuration file. Retention configured on the Kafka instance in the Data Services console does apply to topics created from the command line. When such a topic is then synced in the console and converted to an `RdsTopic`, rds-api 3.18.1 writes a fixed template whose retention is 168 hours; the field is in the template because the page failed without it. The global setting is not wrong; the sync overwrites it on that topic.

### Cause 3: One broker's kafka0 fills the disk because it holds the leaders

One broker restarts repeatedly while the others stay up. That broker's `kafka0` directory has grown to roughly 400 to 500 GB and filled the disk, while the same directory on the other brokers holds only tens of gigabytes. `kafka-topics.sh --describe` shows almost all partition leaders on the restarting broker, and the ISR contains only that broker's id (for example `Leader: 1100` and `Isr: 1100` while `Replicas` lists `1100,1101,1102`). The peers log the replica fetch failure shown in Issue for `ALAUDA_LOG_TOPIC` and `ALAUDA_AUDIT_TOPIC` partitions. The full disk makes the leader broker intermittently unhealthy, which keeps interrupting replication, so the peers never catch up and the single copy keeps growing.

Before this state becomes visible, the whole Kafka can fail to start; it starts after about 20 minutes once the health-check timing is lengthened and the JVM memory is raised, after which only the full broker keeps restarting. When the disk cannot be expanded, deleting that broker's `kafka0` directory and reducing the default retention from 48 hours to 24 hours returns Kafka to normal.

## Resolution

### Cause 1: Hundreds of gigabytes on disk with almost no lag

Confirm that lag is not growing and delay is under about a minute, then treat the bytes as retained segments. List sizes and segment ages before changing retention:

```bash
kubectl -n <namespace> exec <cluster>-kafka-0 -- sh -c 'du -sh /var/lib/kafka/data/* | sort -h'
kubectl -n <namespace> exec <cluster>-kafka-0 -- sh -c 'ls -lh /var/lib/kafka/data/<topic>-<partition> | head'
```

On the log nodes, the same check is `du -sh /cpaas/data/kafka0/*`.

Capacity that matches `daily ingest x replica count x retention` can be left as it is. Shorten retention only when the owner wants less history:

```bash
kubectl -n <namespace> get kafkatopic,rdstopic
kubectl -n <namespace> edit rdstopic <topic>
```

Set `spec.config.retention.ms` to the agreed window (48 hours is `172800000`). Segments of other topics inside the window age out with retention; do not delete them by hand. If lag on `ALAUDA_LOG_TOPIC` is high at the same time, the growth is unread data; fix the consumers before shortening retention.

### Cause 2: Console sync writes a 168-hour template over the retention you set

Use this only when a topic shows 168 hours after it was synced or converted to an `RdsTopic` in the console, and the retention the owner configured (for example 2 hours) is the value that should be stored.

```bash
kubectl -n <namespace> get rdstopic <topic> -o jsonpath='{.spec.config.retention\.ms}{"\n"}'
kubectl -n <namespace> get rdstopic <topic> -o yaml > <topic>.rdstopic.bak.yaml
```

> **Warning:** Writing a shorter `retention.ms` deletes segments older than the new window, and they do not come back. Do it only for a topic whose YAML still shows the 168-hour template after a console sync, and only after the topic owner has accepted the shorter window. Roll back by setting `retention.ms` back to `604800000` (168 hours); segments already deleted stay deleted.

```bash
kubectl -n <namespace> edit rdstopic <topic>
```

```yaml
spec:
  config:
    retention.ms: "7200000"   # 2 hours
```

The other workaround is to type the retention time in the console when the topic is created, instead of relying on the global default for a topic that the console will sync. Restarting the brokers after changing `log.retention.hours` does not replace the template value already written onto a synced topic.

### Cause 3: One broker's kafka0 fills the disk because it holds the leaders

1. Confirm the skew before deleting anything. On the platform log Kafka the bootstrap address is `cpaas-kafka:9092`; pass the client configuration file the brokers use for authenticated access:

```bash
kubectl -n cpaas-system get pods -o wide | grep cpaas-kafka
kubectl -n cpaas-system exec <broker-pod> -- \
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server cpaas-kafka:9092 \
  --command-config <client-properties-file> --describe
kubectl -n cpaas-system exec <peer-broker-pod> -- \
  sh -c 'grep -E "Connection to .* failed|ReplicaFetcherThread" /opt/kafka/logs/server.log | tail -20'
```

Expected: almost every leader is the restarting broker, the ISR lists only its id, and the peers log `Connection to <broker-address>:9092 (id: <id> rack: null) failed.` for that id. Run `du -sh /cpaas/data/kafka0` on each log node: the full node holds hundreds of gigabytes and the peers tens of gigabytes.

2. If the volume can grow, expand it (see *Kafka broker PVC full or still too small after expansion on ACP*), then shorten retention so the same broker does not fill the new size. The remaining steps apply only when the disk cannot be expanded.

3. If the restarting broker never stays up long enough to describe topics, lengthen its health-check timing and raise its JVM heap so that a start of about 20 minutes is not killed. Save the workload first; if a controller reverts the edit, make the same change on the object that owns the workload. This only makes the describe and cleanup possible; it does not stop the full broker from restarting.

```bash
kubectl -n cpaas-system get sts cpaas-kafka -o yaml > cpaas-kafka.sts.bak.yaml
```

4. Pause the log consumer `razor` so it stops reading while the cleanup runs, and let consumers drain.

> **Warning:** Stopping `razor` pauses that log component until it is scaled back. Do it only when Cause 3 is confirmed and the disk cannot be expanded. Roll back by scaling it to the replica count printed by the second command.

```bash
kubectl get deploy,sts -A | grep -i razor
kubectl -n <razor-namespace> get <kind>/<razor> -o jsonpath='{.spec.replicas}{"\n"}'
kubectl -n <razor-namespace> scale <kind>/<razor> --replicas=0
```

A Pod named `razor-0` belongs to a StatefulSet, so `<kind>` is `sts` (in `cpaas-system`).

5. Delete the oversized copy on the full node only.

> **Warning:** `rm -rf /cpaas/data/kafka0/*` on the full node destroys the log segments on that node, including records the lagging peers never replicated, so recent logs can be lost. It is irreversible. Run it only when Cause 3 is confirmed (one broker restarting, peers up, ISR is only that broker, this node's `kafka0` is the copy at hundreds of gigabytes), the disk cannot be expanded, no process is using the directory, and a maintenance window accepts the loss. There is no rollback.

```bash
ls /cpaas/data/kafka0
rm -rf /cpaas/data/kafka0/*
```

6. Reduce the broker default retention from 48 to 24 hours.

> **Warning:** Setting the broker default `log.retention.hours` to `24` deletes segments older than 24 hours on every topic that inherits the default; those segments do not come back. Roll back by setting it to `48`. A topic that sets its own `retention.ms` keeps that value.

```bash
kubectl -n cpaas-system exec <broker-pod> -- \
  /opt/kafka/bin/kafka-configs.sh --bootstrap-server cpaas-kafka:9092 \
  --command-config <client-properties-file> \
  --alter --entity-type brokers --entity-default \
  --add-config log.retention.hours=24
```

If the command fails because the broker is still down after the delete, run it once the broker is Ready. If a controller reconciles broker configuration from a Kafka object, set `log.retention.hours: 24` in that object's Kafka config (the object that currently shows 48) so the controller keeps the new default.

7. Scale `razor` back to the saved replica count and confirm that all brokers stay Running and the ISR lists every replica again.

## Diagnostic Steps

1. Measure lag before deleting anything. Lag near zero plus a large directory is Cause 1. Lag climbing on `ALAUDA_LOG_TOPIC` is a consumer problem, not this article.

2. Compare the size of `kafka0` (or `/var/lib/kafka/data`) across brokers. Similar sizes point to Cause 1; one broker many times larger, restarting, with the ISR reduced to that broker, is Cause 3.

```bash
kubectl -n <namespace> exec <broker-pod> -- du -sh /var/lib/kafka/data
du -sh /cpaas/data/kafka0
```

3. If Data Services shows 2 hours and the topic shows 168 hours after a console sync, it is Cause 2, even when a Kafka restart keeps 168 hours:

```bash
kubectl -n <namespace> get rdstopic <topic> -o jsonpath='{.spec.config}{"\n"}'
```

4. A JVM out-of-memory line in the previous broker log, with every broker replaying a large log at startup, is a startup failure, not Cause 3 (see *Kafka and ZooKeeper down from storage stalls, a full node disk, or a probe kill during log replay on ACP*).
