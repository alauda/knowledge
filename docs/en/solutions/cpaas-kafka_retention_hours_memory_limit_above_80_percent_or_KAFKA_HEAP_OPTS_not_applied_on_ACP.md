---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# cpaas-kafka retention hours, memory limit above 80 percent, or KAFKA_HEAP_OPTS not applied on ACP

## Issue

Questions and problems with the Kafka of the platform log storage plugin (StatefulSet `cpaas-kafka` in `cpaas-system`):

- How long does the log storage Kafka keep messages, and how is the retention (`log.retention.hours`) changed?
- The log nodes have a single disk, and during business peaks Kafka data could fill `/`. Can Kafka keep less?
- A rule requires Kafka memory usage at or below 80%, and the `cpaas-kafka` pods run at 80.70% to 82.00% of their container memory limit.
- `KAFKA_HEAP_OPTS` on the StatefulSet says `-Xms6g -Xmx6g` (or `2g`), but the broker Java process still runs with `-Xmx1G -Xms1G`. Logs pile up, and `razor` logs `Send kafka msg error {"topic": "ALAUDA_LOG_TOPIC", ..., "error": "context deadline exceeded"}` and `"error": "kafka write errors (1/1)"`, also for `ALAUDA_AUDIT_TOPIC`.

This Kafka is not a Data Services instance and is not listed on the Data Services page. Its broker settings are environment variables on the container, for example:

| Variable | Value seen |
| --- | --- |
| `KAFKA_LOG_RETENTION_HOURS` | `"48"` |
| `KAFKA_LOG_ROLL_HOURS` | `"12"` |
| `KAFKA_LOG_SEGMENT_DELETE_DELAY_MS` | `"0"` |
| `KAFKA_LOG_DIRS` | `/kafka0` |
| `KAFKA_HEAP_OPTS` | `-Xmx1g -Xms512m` |

Container resources were limits `cpu: "2"` / `memory: 4Gi` and requests `cpu: 200m` / `memory: 256Mi` in one environment. The plugin keeps Kafka settings in the `logcenter` ModuleInfo (`spec.config.components.kafka`). The default Kafka backlog alerts are in the alert policy `cpaas-log-rules` on the global cluster.

## Root Cause

### Cause 1: Kafka keeps log data for 48 hours, set by KAFKA_LOG_RETENTION_HOURS

By default the log storage Kafka keeps data for 2 days: `KAFKA_LOG_RETENTION_HOURS: "48"` in the `cpaas-kafka` environment. Where the variable is absent from the StatefulSet, the default is expected to be the same. Retention is changed by adding or editing that variable, which restarts the Kafka pods.

### Cause 2: Kafka data fills a single disk during peaks, and retention is the trade-off

When the Kafka log directory sits on the same file system as `/`, peak log volume can fill `/` and make the node abnormal. A lower retention reduces that risk but shortens the time available to clear a backlog: with 24 hours, any log data not written to the log store within 24 hours during a backlog is lost. Kafka removes segments only once they pass the retention age; a consumer that catches up does not free disk by itself.

### Cause 3: cpaas-kafka container memory is above an 80% requirement

With a `4Gi` limit and about 3.2Gi used, container memory usage is 80.70% to 82.00%. With no backlog, this is normal: Kafka relies on the page cache, which is counted in container memory. To meet a rule of 80% or less, raise the container memory limit.

### Cause 4: KAFKA_HEAP_OPTS does not reach the broker JVM because the start script sets its own heap

The container starts the broker through `/opt/kafka/bin/start-kafka.sh`, which calls `/opt/kafka/bin/kafka-server-start.sh /opt/kafka/config/server.properties`. In the affected image, `kafka-server-start.sh` contains an unconditional `export KAFKA_HEAP_OPTS="-Xmx1G -Xms1G"`, which overwrites the value from the environment. The StatefulSet and `printenv` show the configured heap, while the broker JVM (`java -Xmx1G -Xms1G -Djava.security.auth.login.config=/opt/kafka/conf/kafka_server_jaas.conf -server -XX:+UseG1GC ...`) runs with 1G. Threads such as `kafka-scheduler`, `data-plane-kafka`, and `ExpirationReaper` belong to that same broker JVM; `kafka_exporter` in the same pod is a separate, non-Java process.

With a 1G heap under a high log volume, the brokers cannot keep up: replica fetchers log `Error sending fetch request ... java.io.IOException: Connection to <broker-id> was disconnected before the response was read`, the controller repeats `Processing automatic preferred replica leader election`, and `razor` writes time out. Mounting a corrected `kafka-server-start.sh` from a ConfigMap and restarting Kafka makes the heap setting take effect. Large on-disk queues on some nodes also made Kafka fail while loading them at startup and needed cleanup. If the backlog persists after the heap is right, the remaining limit is capacity: Kafka and Elasticsearch sharing the same nodes could not sustain the log volume, and log collection for the noisiest namespace was disabled temporarily.

## Resolution

Save the StatefulSet before any change:

```bash
kubectl -n cpaas-system get sts cpaas-kafka -o yaml > /tmp/cpaas-kafka-sts.before.yaml
```

### Cause 1: Kafka keeps log data for 48 hours, set by KAFKA_LOG_RETENTION_HOURS

```bash
kubectl -n cpaas-system get sts cpaas-kafka -o jsonpath='{range .spec.template.spec.containers[*].env[*]}{.name}{"="}{.value}{"\n"}{end}' | grep -E '^KAFKA_LOG_(RETENTION|ROLL|DIRS|SEGMENT)'
```

> **Warning:** Changing the StatefulSet environment restarts the `cpaas-kafka` pods one by one; ingestion slows and lag rises until they are Ready. A shorter retention deletes older segments, including data not consumed yet. Precondition: consumer lag is near zero, and the change was tried on a test cluster of the same version. Rollback: `kubectl apply -f /tmp/cpaas-kafka-sts.before.yaml`; deleted segments do not return.

```bash
kubectl -n cpaas-system set env sts/cpaas-kafka KAFKA_LOG_RETENTION_HOURS=<hours>
kubectl -n cpaas-system rollout status sts/cpaas-kafka
```

Editing the YAML (`kubectl -n cpaas-system edit sts cpaas-kafka`, or the StatefulSet's YAML in the console) is the same change: add or modify `name: KAFKA_LOG_RETENTION_HOURS` with a quoted value such as `"48"`. If a plugin update restores the old value, read the environment again and repeat.

### Cause 2: Kafka data fills a single disk during peaks, and retention is the trade-off

1. Size retention as the hours of peak log volume that fit on the Kafka disk with headroom, but no shorter than the longest backlog you must survive. Set it as in Cause 1.
2. Watch the Kafka backlog alerts in `cpaas-log-rules` and set thresholds that warn before data reaches the retention age.
3. Plan a separate disk for log data if `/` is the only disk.

For a log node whose disk is already full of Elasticsearch and Kafka data, free Elasticsearch space by deleting old indices as in [/cpaas/data full with ZooKeeper down or Elasticsearch on the root disk on ACP](cpaas_data_full_with_ZooKeeper_down_or_Elasticsearch_on_the_root_disk_on_ACP.md), and let the shorter Kafka retention remove old segments.

### Cause 3: cpaas-kafka container memory is above an 80% requirement

```bash
kubectl -n cpaas-system top pod | grep cpaas-kafka
kubectl -n cpaas-system get sts cpaas-kafka -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" "}{.resources}{"\n"}{end}'
```

Pick a limit that puts usage below 80% (usage divided by 0.8, rounded up; about 3.2Gi needs more than 4Gi). Page cache can grow toward the new limit, so check again after a few days.

> **Warning:** Changing the resources restarts the `cpaas-kafka` pods one by one. Precondition: the Kafka nodes have the extra memory free and consumer lag is near zero. Rollback: `kubectl apply -f /tmp/cpaas-kafka-sts.before.yaml`.

```bash
kubectl -n cpaas-system edit sts cpaas-kafka
kubectl -n cpaas-system rollout status sts/cpaas-kafka
```

Set `resources.limits.memory` of the Kafka container. If a plugin update restores the old limit, set the same value in the log storage plugin configuration.

### Cause 4: KAFKA_HEAP_OPTS does not reach the broker JVM because the start script sets its own heap

1. Compare the three values and read the script:

   ```bash
   kubectl -n cpaas-system get sts cpaas-kafka -o jsonpath='{range .spec.template.spec.containers[*].env[*]}{.name}={.value}{"\n"}{end}' | grep HEAP
   kubectl -n cpaas-system exec cpaas-kafka-0 -- printenv KAFKA_HEAP_OPTS
   kubectl -n cpaas-system exec cpaas-kafka-0 -- sh -c "ps -ef | grep '[k]afka_server_jaas' | grep -o -- '-Xm[sx][^ ]*'"
   kubectl -n cpaas-system exec cpaas-kafka-0 -- grep -n 'KAFKA_HEAP_OPTS' /opt/kafka/bin/kafka-server-start.sh
   ```

   The environment showing the configured heap, the broker process showing `-Xmx1G`, and an unconditional `export KAFKA_HEAP_OPTS="-Xmx1G -Xms1G"` in the script confirm this cause.

2. Copy the script out and correct it so the environment value wins, for example by wrapping the line in the upstream Kafka form `if [ "x$KAFKA_HEAP_OPTS" = "x" ]; then export KAFKA_HEAP_OPTS="-Xmx1G -Xms1G"; fi`:

   ```bash
   kubectl -n cpaas-system exec cpaas-kafka-0 -- cat /opt/kafka/bin/kafka-server-start.sh > /tmp/kafka-server-start.sh
   vi /tmp/kafka-server-start.sh
   kubectl -n cpaas-system create configmap cpaas-kafka-server-start --from-file=kafka-server-start.sh=/tmp/kafka-server-start.sh
   ```

3. Mount it over the original and restart Kafka.

   > **Warning:** Changing the StatefulSet restarts the `cpaas-kafka` pods; log produce and consume pause on each broker while it restarts. Set `KAFKA_HEAP_OPTS` well below the container memory limit, or the pod is `OOMKilled`. Precondition: Cause 4 is confirmed and the StatefulSet YAML is saved. Rollback: `kubectl apply -f /tmp/cpaas-kafka-sts.before.yaml`, then delete the ConfigMap. A plugin update can replace the StatefulSet; check the mount after every update.

   ```bash
   kubectl -n cpaas-system edit sts cpaas-kafka
   ```

   Add a volume from ConfigMap `cpaas-kafka-server-start` with `defaultMode: 0755`, and in the Kafka container a `volumeMount` with `mountPath: /opt/kafka/bin/kafka-server-start.sh` and `subPath: kafka-server-start.sh`. Then:

   ```bash
   kubectl -n cpaas-system rollout status sts/cpaas-kafka
   kubectl -n cpaas-system exec cpaas-kafka-0 -- sh -c "ps -ef | grep '[k]afka_server_jaas' | grep -o -- '-Xm[sx][^ ]*'"
   ```

   The broker process must now show the configured heap.

4. If a broker fails while loading a large on-disk queue at startup, clear that queue before restarting it; see Cause 1 of [Platform log Kafka brokers fail: no leader election, exit 137, Pending on DiskPressure, Ceph write errors, or OOM on ACP](Platform_log_Kafka_brokers_fail_no_leader_election_exit_137_Pending_on_DiskPressure_Ceph_write_errors_or_OOM_on_ACP.md).
5. If the backlog persists with the right heap, add capacity: move Kafka or Elasticsearch to separate nodes, or reduce the log volume (for example by disabling log collection for a noisy namespace) until capacity is added.

## Diagnostic Steps

1. Confirm it is the platform log Kafka: `kubectl -n cpaas-system get sts,pods | grep cpaas-kafka`.
2. Retention and disk:

   ```bash
   lsblk
   kubectl -n cpaas-system exec cpaas-kafka-0 -- df -h /kafka0
   du -sh /cpaas/data/kafka*
   ```

   Kafka data on the same disk as `/`, or near the disk's size, is Cause 2.
3. `kubectl top` usage divided by the limit above 80%, with no lag, is Cause 3. If consumer lag is also growing, fix the backlog first.
4. Heap: when the broker JVM's `-Xmx` differs from `KAFKA_HEAP_OPTS` in the environment, read the start script (Cause 4). The Java process that loads `kafka_server_jaas.conf` is the broker; `kafka_exporter` is not a Java process.
5. Backlog alerts: in the global cluster's alert policies, check that `cpaas-log-rules` exists and its Kafka rules are normal. A firing lag rule means data older than `KAFKA_LOG_RETENTION_HOURS` in the backlog is at risk.
