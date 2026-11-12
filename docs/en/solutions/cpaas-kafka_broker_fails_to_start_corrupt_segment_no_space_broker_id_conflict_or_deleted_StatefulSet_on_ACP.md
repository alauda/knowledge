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

# cpaas-kafka broker fails to start: corrupt segment, no space, broker id conflict, or deleted StatefulSet on ACP

## Issue

A broker of the log storage Kafka does not start, or the Kafka is missing altogether. Typical reports:

- "The ES log component keeps showing Installing (`正在安装`)."
- "Kafka for logging filled its PVC and still fails after the PVC was expanded."
- "Kafka cannot write to its data disk: `No space left on device`."
- "One Kafka pod crashes while Elasticsearch log storage is being deployed."
- "Kafka cannot start again after a reinstall: broker id conflict."
- "The `cpaas-kafka` StatefulSet was deleted."

The broker is the log storage Kafka in `cpaas-system` (StatefulSet `cpaas-kafka`, pods `cpaas-kafka-0..2`, with `cpaas-zookeeper`), not a Data Services Kafka. Its data is on node-local storage, typically `/cpaas/data/kafka0` (seen inside the pod as `/kafka0`), plus `/cpaas/data/kafka` and `/cpaas/data/zookeeper`.

When the brokers run but logs, audit and events stop, see [Logs, audit and events stop while the log Kafka is degraded on ACP](./Logs_audit_and_events_stop_while_the_log_Kafka_is_degraded_on_ACP.md).

## Root Cause

### Cause 1: No space left on device under /kafka0, and expanding the PVC does not help

```text
ERROR Error while loading log dir /kafka0 (org.apache.kafka.storage.internals.log.LogDirFailureChannel)
java.nio.file.FileSystemException: /kafka0/ALAUDA_EVENT_TOPIC-2/00000000000000000007.snapshot: No space left on device
```

Kafka filled its volume and crashed. What fixes it depends on what backs the PV:

- **Node-local PV** (`spec.local` or `spec.hostPath`). By default, `cpaas-kafka` uses PVs backed by the node's local storage, so the real capacity is the node's local filesystem. Expanding the PVC (for example from 30Gi to 60Gi) changes the number but not the space, and the pod still cannot create files in `/kafka0`. Patching `volumeClaimTemplates` is rejected, because that StatefulSet field is immutable. Extending the logical volume behind the path on the node fixes Kafka.
- **PV from a StorageClass that supports expansion.** Expanding the PVC adds real space, and Kafka recovers.

After space is added, ZooKeeper may log `ERROR Unsuccessful handshake with session 0x0 (org.apache.zookeeper.server.NettyServerCnxnFactory)`. This message is known, and it can be ignored while ZooKeeper is `Running`.

### Cause 2: Kafka exits at startup with a fault in an unsafe memory access operation in LogSegment.recover

The previous log of the broker ends with:

```text
ERROR Exiting Kafka due to fatal exception during startup. (kafka.Kafka$)
java.lang.InternalError: a fault occurred in an unsafe memory access operation
    at org.apache.kafka.storage.internals.log.LogSegment.recover(LogSegment.java:498)
    at kafka.log.LogLoader.recoverSegment(LogLoader.scala:371)
```

Kafka cannot read its on-disk segments while it recovers them at startup, so the broker never starts. The pod is `CrashLoopBackOff` with thousands of restarts, while the other brokers, Elasticsearch and `lanaya` are `Running`. `kubectl get ars -A` shows every chart `Synced`/`Ready` except `logcenter`, which is `Synced` with health `WaitReady`. That keeps the Elasticsearch log component in Installing. The fix is to stop Kafka and ZooKeeper, clear the contents of their data directories on all three log nodes, and scale both back to 3 replicas.

### Cause 3: One Kafka pod crashes at startup with a broker id conflict

One `cpaas-kafka` pod crash-loops while its peers run, and its broker id is the same as another broker's, or conflicts with data left from an earlier installation. Upstream Kafka reports these states with messages such as `InconsistentBrokerIdException: Configured broker.id ... doesn't match stored broker.id ... in meta.properties`, or with a broker that cannot register because its id is already registered in ZooKeeper. Two variants exist:

- While Elasticsearch was being deployed as the log storage, one Kafka node failed to start because its broker id duplicated the id of another Kafka node. Giving each Kafka node a different broker id and restarting Kafka fixed it.
- After the log storage was reinstalled, Kafka could not start because of a broker id conflict. The data of the previous installation had not been cleaned before the reinstall. Clearing the `zookeeper`, `kafka` and `kafka0` directories under `/cpaas/data` on the three Kafka nodes fixes it.

### Cause 4: The cpaas-kafka StatefulSet was deleted

The log storage Kafka StatefulSet is gone. A resource patch (`rpch`) for Kafka may exist that only adds configuration, and it can be left alone. Kafka can be recreated from the StatefulSet YAML of a healthy environment with the same platform and plugin version. After that, stop `lanaya`, Kafka and ZooKeeper, clean their directories, and start them in the order ZooKeeper, Kafka, `lanaya`. Log queries then work again.

## Resolution

### Cause 1: No space left on device under /kafka0, and expanding the PVC does not help

1. Find the PV behind the broker and what backs it:

   ```bash
   kubectl get pod -A | grep -E 'zook|kafka'
   kubectl -n cpaas-system get pvc | grep kafka
   kubectl get pv <kafka-pv> -o jsonpath='{.spec.local.path}{.spec.hostPath.path}{"\n"}{.spec.nodeAffinity}{"\n"}{.spec.storageClassName}{"\n"}'
   ```

2. If the PV has a `local` or `hostPath` path, find the filesystem behind that path on the node the PV is pinned to:

   ```bash
   df -hT <pv-path>
   lvs
   vgs
   ```

3. Add space.
   - For a node-local PV, extend the logical volume.

     > **Warning:** Extending a logical volume and its filesystem changes the node's disk layout. An online extension is normally safe, but a wrong logical volume or volume group name can consume space that another workload needs. Precondition: only when the Kafka log shows `No space left on device` under `/kafka0`, `df` on the node shows the logical volume behind the PV path full, and the volume group has free extents (`vgs`). Rollback: shrinking is not supported online for XFS and is risky for ext4, so treat the extension as permanent.

     ```bash
     lvextend -r -L +<size> /dev/<vg>/<lv>
     df -hT <pv-path>
     ```

     `-r` grows the filesystem together with the logical volume.
   - For a PV from an expandable StorageClass, expand the PVC instead:

     ```bash
     kubectl -n cpaas-system patch pvc <kafka-pvc> -p '{"spec":{"resources":{"requests":{"storage":"<new-size>"}}}}'
     ```

4. Restart the broker and check a current log query:

   ```bash
   kubectl -n cpaas-system delete pod <kafka-pod>
   ```

   A ZooKeeper `Unsuccessful handshake with session 0x0` line after recovery needs no action.

### Cause 2: Kafka exits at startup with a fault in an unsafe memory access operation in LogSegment.recover

1. Confirm the signature:

   ```bash
   kubectl get po -A | grep -E 'kafka|lanaya|elastic'
   kubectl get ars -A
   kubectl -n cpaas-system logs -p cpaas-kafka-0 | grep -B2 -A6 'unsafe memory access'
   ```

2. Stop Kafka and ZooKeeper:

   ```bash
   kubectl -n cpaas-system scale sts cpaas-kafka cpaas-zookeeper --replicas=0
   ```

3. Empty their data directories.

   > **Warning:** Clearing the Kafka and ZooKeeper data directories deletes every unconsumed log, audit and event record, and the ZooKeeper state of the log cluster. Precondition: only when the previous Kafka log shows the `LogSegment.recover` fault above and both StatefulSets are at 0 replicas. Rollback: none.

   On each of the three log nodes, empty the directories but keep them. The `cd ... &&` form stops before `rm` if a directory is missing:

   ```bash
   cd /cpaas/data/kafka && rm -rf ./*
   cd /cpaas/data/kafka0 && rm -rf ./*
   cd /cpaas/data/zookeeper && rm -rf ./*
   ```

4. Start both again and watch:

   ```bash
   kubectl -n cpaas-system scale sts cpaas-kafka cpaas-zookeeper --replicas=3
   kubectl -n cpaas-system get po -w | grep -E 'kafka|zookeeper'
   ```

### Cause 3: One Kafka pod crashes at startup with a broker id conflict

1. Find the Kafka nodes. In the console, open Marketplace, Cluster Plugins, select the cluster, and open the log storage plugin. Its details list the three Kafka nodes.

2. Compare the broker ids. The stored id is the `broker.id` line of `meta.properties` in the data directory (`/kafka0` inside the pod, `/cpaas/data/kafka0` on the node):

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep -E 'cpaas-kafka|cpaas-zookeeper'
   kubectl -n cpaas-system logs -p <crashing-kafka-pod> | grep -i -E 'broker.?id' | tail -20
   for p in cpaas-kafka-0 cpaas-kafka-1 cpaas-kafka-2; do
     echo "== $p"; kubectl -n cpaas-system exec "$p" -- cat /kafka0/meta.properties 2>/dev/null
   done
   ```

   A crashing pod cannot be opened with `exec`. Read its file on the node with `cat /cpaas/data/kafka0/meta.properties`.

3. When two live brokers have the same id and the data on each node belongs to the current installation, make the ids distinct and restart Kafka. Compare with a healthy installation of the same version before you edit anything.

4. When the log storage was reinstalled on nodes that still hold the previous installation's data, clear that data. First stop both StatefulSets:

   ```bash
   kubectl -n cpaas-system scale sts cpaas-kafka cpaas-zookeeper --replicas=0
   kubectl -n cpaas-system get pods | grep -E 'cpaas-kafka|cpaas-zookeeper'
   ```

   > **Warning:** Emptying `/cpaas/data/zookeeper`, `/cpaas/data/kafka` and `/cpaas/data/kafka0` deletes every record still in Kafka and the ZooKeeper state of the log cluster. Unconsumed logs, audit records and events are lost. Elasticsearch indices are not touched. Precondition: only when the broker id conflict appeared after a reinstall, the data under these directories is left from the previous installation, and both StatefulSets are at 0 replicas. Rollback: none.

   On each of the three Kafka nodes, delete the contents and keep the directories:

   ```bash
   cd /cpaas/data/zookeeper && rm -rf ./*
   cd /cpaas/data/kafka && rm -rf ./*
   cd /cpaas/data/kafka0 && rm -rf ./*
   ```

   Then start both again and watch until every pod is `Running`:

   ```bash
   kubectl -n cpaas-system scale sts cpaas-kafka cpaas-zookeeper --replicas=3
   kubectl -n cpaas-system get pods -w | grep -E 'cpaas-kafka|cpaas-zookeeper'
   ```

### Cause 4: The cpaas-kafka StatefulSet was deleted

1. Confirm that the StatefulSet is missing, and list the resource patches:

   ```bash
   kubectl -n cpaas-system get sts | grep -E 'kafka|zookeeper'
   kubectl get rpch -A
   ```

2. On a healthy environment with the same platform and plugin version, export the StatefulSet:

   ```bash
   kubectl -n cpaas-system get sts cpaas-kafka -o yaml > /tmp/cpaas-kafka.sts.yaml
   ```

   Remove `metadata.uid`, `metadata.resourceVersion`, `metadata.creationTimestamp`, `metadata.managedFields` and `status`. Replace node names, addresses and storage values that belong to the other environment.

3. Apply it on the affected cluster:

   ```bash
   kubectl -n cpaas-system apply -f /tmp/cpaas-kafka.sts.yaml
   ```

4. Clean and restart the pipeline in order.

   > **Warning:** Cleaning the Kafka and ZooKeeper directories drops every record that was in Kafka. Precondition: Kafka was recreated from the exported YAML, and `lanaya`, Kafka and ZooKeeper are stopped. Rollback: none.

   Stop `lanaya`, Kafka and ZooKeeper, and empty the Kafka and ZooKeeper data directories as in Cause 2. Start ZooKeeper, then Kafka, then `lanaya`, and wait for each to be Ready before the next. Keep watching the Kafka pods afterwards, and run a log query.

## Diagnostic Steps

1. Read the broker state and the last fatal line:

   ```bash
   kubectl -n cpaas-system get sts | grep -E 'kafka|zookeeper'
   kubectl -n cpaas-system get pods -o wide | grep -E 'kafka|zookeeper'
   kubectl -n cpaas-system logs -p cpaas-kafka-0 | tail -30
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | `No space left on device` under `/kafka0` | Cause 1, check what backs the PV and not only the PVC size |
   | `unsafe memory access` in `LogSegment.recover` | Cause 2 |
   | One broker crash-looping with "broker id" in its previous log, two brokers with the same `broker.id` in `meta.properties`, or a conflict right after a reinstall | Cause 3 |
   | No `cpaas-kafka` StatefulSet | Cause 4 |

3. A Kafka in KRaft mode (broker and controller pods, data under `/var/lib/kafka/data`, `No space left on device` on `__cluster_metadata`) is not this log storage Kafka. Check its disk the same way: find the PV behind the data directory, and add space to the volume that actually backs it.

## Related Information

- Related articles: [Logs, audit and events stop while the log Kafka is degraded on ACP](./Logs_audit_and_events_stop_while_the_log_Kafka_is_degraded_on_ACP.md) covers a large `kafka0` backlog, one broker down with `min.insync.replicas=2`, and logs that stay missing after a disk cleanup.
- [Kafka Scale Switching](./Kafka_Scale_Switching.md)
