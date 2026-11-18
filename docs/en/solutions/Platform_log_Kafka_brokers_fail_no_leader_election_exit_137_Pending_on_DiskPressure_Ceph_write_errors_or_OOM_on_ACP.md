---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.14.x
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Platform log Kafka brokers fail: no leader election, exit 137, Pending on DiskPressure, Ceph write errors, or OOM on ACP

## Issue

The platform log Kafka (`cpaas-kafka-*` with `cpaas-zookeeper-*` in `cpaas-system`) fails as a broker, not as a slow consumer. Typical reports:

- `lanaya` cannot connect to Kafka, and the broker log says a leader election failed.
- `cpaas-kafka-1` and `cpaas-kafka-2` are in `Error` with tens of thousands of restarts and exit code `137`; adding replicas does not help.
- A `cpaas-kafka` pod is `Pending` and log delivery has stopped.
- Observability shows no logs; the logging pods start healthy and later go abnormal, and the Kafka log shows data write failures on a Ceph-backed volume.
- The broker log shows `java.lang.OutOfMemoryError: Java heap space` or `Direct buffer memory`, logs pile up, and `razor` logs `Send kafka msg error` with `context deadline exceeded` or `kafka write errors`.

This article is only for the platform log pipeline. A Data Services Kafka instance used by applications is a different workload; do not apply the wipe, `Pending`, or metadata branches here to it.

Related articles: [cpaas-kafka broker fails to start: corrupt segment, no space, broker id conflict, or deleted StatefulSet on ACP](cpaas-kafka_broker_fails_to_start_corrupt_segment_no_space_broker_id_conflict_or_deleted_StatefulSet_on_ACP.md), [Kafka and ZooKeeper down from storage stalls, a full node disk, or a probe kill during log replay on ACP](Kafka_and_ZooKeeper_down_from_storage_stalls_a_full_node_disk_or_a_probe_kill_during_log_replay_on_ACP.md), [Logs, audit, and events stop while the log Kafka is degraded on ACP](Logs_audit_and_events_stop_while_the_log_Kafka_is_degraded_on_ACP.md), and [cpaas-kafka retention hours, memory limit above 80 percent, or KAFKA_HEAP_OPTS not applied on ACP](cpaas-kafka_retention_hours_memory_limit_above_80_percent_or_KAFKA_HEAP_OPTS_not_applied_on_ACP.md).

## Root Cause

### Cause 1: the brokers cannot elect a leader because the Kafka metadata is corrupt

The brokers are up enough to log, and the log says a leader election failed because metadata is corrupt. A normal restart does not elect a leader. Clearing the Kafka data directory restores elections. Lag and a large on-disk queue of the `nevermore` log agent under `/cpaas` (the `audit`, `event`, and `log` trees and their `diskqueue` directories) can remain afterwards; clearing those trees on every node and restarting `nevermore` drains it, at the cost of every record that had not been shipped yet.

### Cause 2: cpaas-kafka pods restart with exit code 137 and extra replicas still crash

Exit code `137` means the container received `SIGKILL`: either the kernel OOM killer (`OOMKilled` in the container's last state) or the kubelet after a failed liveness probe (a `Liveness probe failed` event). A failing or full disk does not produce 137 directly, but it can slow startup until the probe kills the container. When the loop persists after disk and memory are checked and scaling out has failed, the recovery that works is a full rebuild of the log cluster: stop the writers and the stores, clear the Elasticsearch, Kafka, and ZooKeeper data directories, and start the stores in order. Every stored log and the ZooKeeper state of the log cluster are lost.

A broker that is killed by its probe while it is still loading segments is the narrower replay case in the Kafka and ZooKeeper article linked above; that recovery does not delete Elasticsearch data.

### Cause 3: the Kafka pod is Pending because its node has DiskPressure

Disk usage crossed the kubelet eviction threshold, the Kafka pod was evicted, and it stays `Pending`, so log delivery stops. Expanding or freeing the disk and then deleting the pod lets it schedule again. The same `Pending` state clears after `NotReady` nodes recover; restarting pods does not fix a `NotReady` node.

### Cause 4: Kafka data writes fail on a Ceph-backed volume

Kafka logs from before a restart show data write failures, and the Kafka PVC is on Ceph. Expanding that Kafka volume brings Kafka back, and log display returns (one case: ACP 4.2.1 on x86 with MicroOS nodes).

### Cause 5: cpaas-kafka runs out of JVM heap or direct buffer memory

```text
java.lang.OutOfMemoryError: Java heap space
ERROR kafka.network.Processor - Processor got uncaught exception.
java.lang.OutOfMemoryError: Direct buffer memory
```

`ReplicaFetcherThread` also logs `Error sending fetch request ... java.lang.OutOfMemoryError: Java heap space`. Log volume grew beyond what the Kafka configuration can carry, the broker JVM ran out of memory, and Kafka stopped processing log data. `nevermore` builds up a local backlog meanwhile; when Kafka recovers it sends the backlog in a burst, and `apollo` on the global cluster can hit OOM and restart, which partly affects the console.

Raising only the container resources does not stop the OOM; `lanaya` can then also go OOM. Raising the broker heap (`KAFKA_HEAP_OPTS`) stops it. Check the running JVM afterwards: on some images the start script sets its own heap, and the environment value never reaches the broker (see the retention and heap article linked above).

## Resolution

Some of the workloads below are Deployments on one version and StatefulSets on another. If `kubectl scale` rejects the kind, use the kind printed by `kubectl -n cpaas-system get deploy,sts`.

### Cause 1: the brokers cannot elect a leader because the Kafka metadata is corrupt

1. Stop the writer and the brokers:

   ```bash
   kubectl -n cpaas-system scale deploy/lanaya --replicas=0
   kubectl -n cpaas-system scale sts/cpaas-kafka --replicas=0
   ```

2. Clear the Kafka data directory on each broker node.

   > **Warning:** Clearing the Kafka data directory destroys every record on that broker; consumers lose the backlog. Precondition: only when the broker log shows a failed leader election or corrupt metadata, a normal restart did not elect a leader, both workloads above are at 0, `lsof` shows no Kafka process in the directory, and the path is the Kafka volume (often `/cpaas/data/kafka0`), not ZooKeeper. Rollback: none.

   Delete the contents, not the mount directory itself:

   ```bash
   rm -rf <kafka-data-dir>/*
   ```

3. Scale `cpaas-kafka` back to its previous replica count, wait until a leader is elected, then scale `lanaya` back.
4. Only if lag remains and the `nevermore` queue trees under `/cpaas` are large, clear them and restart `nevermore`.

   > **Warning:** Clearing `/cpaas/audit`, `/cpaas/event`, and `/cpaas/log` drops every record that never reached Kafka, and also removes the agent's own logs under `/cpaas/log`. Precondition: Kafka elects leaders again, and `du` shows these agent trees, not the Elasticsearch data directory. Rollback: none; `nevermore` recreates empty queues.

   ```bash
   du -sh /cpaas/audit /cpaas/event /cpaas/log
   rm -rf /cpaas/audit/* /cpaas/event/* /cpaas/log/*
   kubectl -n cpaas-system rollout restart ds/nevermore
   ```

### Cause 2: cpaas-kafka pods restart with exit code 137 and extra replicas still crash

1. Find who sends the kill before you delete anything:

   ```bash
   kubectl -n cpaas-system describe pod cpaas-kafka-1 | grep -E -A3 'Last State|Liveness probe failed'
   df -h /cpaas /cpaas/data
   dmesg -T | grep -iE 'oom|i/o error' | tail
   ```

2. Record the replica counts:

   ```bash
   kubectl -n cpaas-system get deploy,sts | grep -E 'lanaya|devops-controller|courier|razor|cpaas-kibana|cpaas-elasticsearch|cpaas-kafka|cpaas-zookeeper'
   ```

3. Stop the writers and the stores (skip names that do not exist, such as `cpaas-elasticsearch-master` on a small-scale layout).

   > **Warning:** This stops log collection, log search, Kibana, and the inspection queries served by `courier` for the whole cluster, and the next step deletes every stored log, every unconsumed Kafka record, and the ZooKeeper state of the log cluster. Precondition: exit 137 persists after the disk and memory checks, scaling out already failed, and the owner accepts a full rebuild of the log cluster. Rollback: none for the data.

   ```bash
   kubectl -n cpaas-system scale deploy/lanaya deploy/devops-controller deploy/courier deploy/razor deploy/cpaas-kibana --replicas=0
   kubectl -n cpaas-system scale sts/cpaas-elasticsearch sts/cpaas-elasticsearch-master sts/cpaas-kafka sts/cpaas-zookeeper --replicas=0
   ```

4. When every pod is gone, on each data node record owner and mode, then clear the contents of each data directory (take the paths from the pods' volume mounts; never a directory that also holds etcd or application data):

   ```bash
   stat -c '%U:%G %a %n' <elasticsearch-data-dir> <kafka-data-dir> <zookeeper-data-dir>
   rm -rf <elasticsearch-data-dir>/* <kafka-data-dir>/* <zookeeper-data-dir>/*
   ```

   Recreate any directory you removed with the same owner and mode.

5. Start back to the recorded counts, waiting for each to be Ready: ZooKeeper, Kafka, Elasticsearch master, Elasticsearch data, then `cpaas-kibana`, `razor`, `courier`, `lanaya`, and `devops-controller`. The order of the stateless components after the stores has not been shown to matter.
6. Query a pod that is logging now; older records were deleted on purpose.

### Cause 3: the Kafka pod is Pending because its node has DiskPressure

```bash
kubectl describe node <node> | grep -E 'DiskPressure|MemoryPressure|Ready'
kubectl -n cpaas-system describe pod cpaas-kafka-0 | sed -n '/Events:/,$p'
```

Free or extend the filesystem that `df` shows full. When `DiskPressure` is `False` and the node is `Ready`:

> **Warning:** Deleting the Kafka pod interrupts produce and consume until the StatefulSet recreates it. Precondition: the node condition that kept it `Pending` is gone. Rollback: none needed; the StatefulSet recreates the pod.

```bash
kubectl -n cpaas-system delete pod cpaas-kafka-0
```

Delete Elasticsearch pods the same way only if they are also stuck on that condition. Do not clear data directories for a `Pending` pod. If the node is `NotReady`, repair the node; the pods become Ready once it is.

### Cause 4: Kafka data writes fail on a Ceph-backed volume

```bash
kubectl -n cpaas-system get pvc | grep -i kafka
kubectl -n cpaas-system logs cpaas-kafka-0 --tail=80
kubectl -n cpaas-system exec cpaas-kafka-0 -- df -h
```

A hostPath or node partition such as `/cpaas/data/kafka0` is not this procedure; grow that filesystem on the node instead.

> **Warning:** A PVC expansion generally cannot be shrunk afterwards; topic data is not deleted by it. Precondition: only when the broker log shows write failures and the Kafka PVC is Ceph-backed. Pick `<new-size>` larger than the current capacity. Rollback: none (no shrink). If the StorageClass does not allow expansion, expand the volume from the storage side, and restart the broker pod only if it does not see the new space.

```bash
kubectl -n cpaas-system patch pvc <kafka-pvc> --type merge \
  -p '{"spec":{"resources":{"requests":{"storage":"<new-size>"}}}}'
```

When the PVC and `cpaas-kafka` pods are healthy, query a pod that is logging now. If the `logcenter` ModuleInfo declares a Kafka storage size (`spec.config.components.kafka.storageSize`), set it to the same value.

### Cause 5: cpaas-kafka runs out of JVM heap or direct buffer memory

1. Confirm the error and read the current settings:

   ```bash
   kubectl -n cpaas-system logs cpaas-kafka-0 --tail=200 | grep -E 'OutOfMemoryError|Direct buffer memory'
   kubectl -n cpaas-system get sts cpaas-kafka -o yaml | grep -E -A2 'KAFKA_HEAP_OPTS|resources:'
   kubectl -n cpaas-system exec cpaas-kafka-0 -- ps -ef | grep '[j]ava' | grep -o -- '-Xm[sx][^ ]*'
   ```

2. Raise the Kafka resources through the platform chart override on the global cluster, so a reconcile does not revert them. The platform applies the change in about 5 to 10 minutes.

   > **Warning:** Editing `prdb base` changes platform-level chart overrides on the global cluster, and the new Kafka resources roll the `cpaas-kafka` pods; produce and consume pause on each broker while it restarts. Precondition: only when the broker log shows the `OutOfMemoryError` lines above, you saved the object, and the nodes have the memory for the new limit. Rollback: `kubectl apply -f /tmp/prdb-base.before.yaml`.

   ```bash
   kubectl get prdb base -o yaml > /tmp/prdb-base.before.yaml
   kubectl edit prdb base
   ```

   One working override (keep any keys already under `valuesOverride`):

   ```yaml
   spec:
     valuesOverride:
       ait/chart-kafka-zookeeper:
         cpaasKafka:
           resources:
             requests:
               cpu: 200m
               memory: 256Mi
             limits:
               cpu: "2"
               memory: 4Gi
         kafka:
           jvm_size: -Xmx1g -Xms512m
   ```

3. If the OOM continues, raise the broker heap through the same override path. Keep the heap well below the container memory limit, because direct buffers and the page cache live outside the heap.
4. Confirm that the running broker JVM uses the new heap: the `-Xmx` of the Java process that loads `kafka_server_jaas.conf` must match. If it stays at `-Xmx1G` while the environment shows the new value, the start script overrides it; follow the heap cause in the retention and heap article linked above.
5. Watch `sum(kafka_consumergroup_lag{})` until it trends down, and watch `lanaya` and `apollo` for OOM restarts while the `nevermore` backlog drains.

## Diagnostic Steps

1. Broker state and the last fatal log:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep -E 'kafka|zookeeper|lanaya|razor'
   kubectl -n cpaas-system logs -p cpaas-kafka-0 --tail=50
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | Leader election fails, metadata corrupt | 1 |
   | Exit code `137` in a tight loop, scale-out does not help | 2 |
   | Pod `Pending`, node `DiskPressure` or `NotReady` | 3 |
   | Write failures in the broker log, Ceph-backed Kafka PVC | 4 |
   | `OutOfMemoryError: Java heap space` or `Direct buffer memory` | 5 |

3. Distinguish the two kinds of exit 137: `Reason: OOMKilled` in `Last State` is memory; a `Liveness probe failed` event with `Reason: Error` is the probe.
4. After any wipe, check a pod that is logging right now, not a historical time range.
