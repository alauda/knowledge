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

# Elasticsearch log storage Pending or every cluster loses logs after the log disk fills on ACP

## Issue

The Elasticsearch log storage (Alauda Container Platform Log Storage for Elasticsearch, `cpaas-elasticsearch` in `cpaas-system`) has filled its disk, and one of the following follows:

- Event queries return no data, and an Elasticsearch pod is `Pending`. Only one of three pods may be `Running`.
- Log queries fail for every business cluster at once, because those clusters store their logs on the global cluster.
- Right after the disk was freed, Elasticsearch CPU is at its limit, and Kafka lag falls only slowly.

When the pods run but indices are `red` or `yellow` with unassigned shards, see [Elasticsearch log indices red or yellow with unassigned shards on ACP](./Elasticsearch_log_indices_red_or_yellow_with_unassigned_shards_on_ACP.md).

A global-cluster node that hosts Elasticsearch log storage can be powered off for maintenance. While it is down, only log query is affected. Drain it first (`kubectl cordon <node>` and `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`), then shut it down. After it is back, run `kubectl uncordon <node>` and wait for the cluster to return to `green`.

## Root Cause

### Cause 1: /cpaas is not a separate disk, so a full log store fills / and the Elasticsearch pod is evicted or Pending

Event queries return no data, and the Elasticsearch pod is `Pending`. Its events read:

```text
FailedScheduling: 0/23 nodes are available: 2 node(s) had untolerated taint {node.kubernetes.io/disk-pressure: }, 21 node(s) didn't match PersistentVolume's node affinity. preemption: 0/23 nodes are available: 23 Preemption is not helpful for scheduling.
```

The pod's local PV pins it to the tainted node, so no other node can take it. `lsblk` on the storage node shows the root logical volume on the first disk and a second large disk with no mount point. No dedicated disk was mounted on `/cpaas`, so Elasticsearch data was written to the root filesystem, which filled and triggered eviction. Cleaning the Elasticsearch data brings `/` back below the eviction threshold. The `DiskPressure` taint is then removed, and the pod schedules again.

On a small global cluster where Elasticsearch runs on the three control-plane nodes, the same full disk shows as `FailedScheduling: 0/3 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/disk-pressure: }, 2 node(s) had volume node affinity conflict.` Log query and audit show no recent data. Cleaning the node directory restores Elasticsearch.

### Cause 2: The global log storage is full and every business cluster that stores logs there has no data

The region or business clusters use the global cluster as their log storage. `/cpaas` on several global storage nodes is at 100%: `df -h /cpaas` shows almost nothing available, and `du` shows `/cpaas/data/elasticsearch` and `/cpaas/data/kafka0` as the large directories. Every Elasticsearch component on the global cluster has failed, so log queries fail for every business cluster at once.

There are two immediate choices: expand `/cpaas` and recover, or clear all log data and lose the history. The lasting fix is log offloading. Deploy log storage on each business cluster and repoint that cluster's collector to it. After the business clusters store their own logs, the global storage can be repaired without affecting them.

### Cause 3: Elasticsearch CPU is high right after a full disk was freed

Elasticsearch and `razor` restarted recently, and Elasticsearch CPU is at its limit (for example one pod at 5.78 cores, 96.4% of the limit). Monitoring shows Elasticsearch storage at 99% to 100% until a moment when it drops to about 50%. `alauda_log` lag on some partitions is very large and starts to fall slowly from that moment.

The disk had been full. Elasticsearch stayed up but could not write, and Kafka backed up. A shorter log retention then deleted old indices and freed the disk, so Elasticsearch began indexing the whole backlog at once. Raising the Elasticsearch CPU limit (to 6 cores) lets it work through the backlog, after which CPU returns to normal. Restarts of unrelated components in the same listing, such as `courier`, are not part of this cause.

## Resolution

### Cause 1: /cpaas is not a separate disk, so a full log store fills / and the Elasticsearch pod is evicted or Pending

1. Confirm the signature:

   ```bash
   kubectl -n cpaas-system describe pod <pending-es-pod> | sed -n '/Events:/,$p'
   kubectl describe node <node> | grep -E 'Taints|DiskPressure'
   kubectl -n cpaas-system get pods -o wide | grep elasticsearch
   ```

   On the storage node:

   ```bash
   lsblk
   findmnt /cpaas || echo "/cpaas is not a separate mount"
   df -hT / /cpaas
   ```

2. Free the space.

   > **Warning:** Cleaning the Elasticsearch data removes the stored logs on that node. Precondition: only when this cause is confirmed, the disk-pressure taint blocks the pod, and the stored history on that node is not needed. Rollback: none.

   Record the replica count and scale the Elasticsearch StatefulSet to 0. Empty the Elasticsearch data directory on the node (`/cpaas/data/elasticsearch`), then scale back:

   ```bash
   kubectl -n cpaas-system get sts cpaas-elasticsearch
   kubectl -n cpaas-system scale sts cpaas-elasticsearch --replicas=0
   ```

   On the node:

   ```bash
   cd /cpaas/data/elasticsearch && rm -rf ./*
   ```

   ```bash
   kubectl -n cpaas-system scale sts cpaas-elasticsearch --replicas=<previous>
   ```

3. When `DiskPressure` clears, the taint is removed and the pod schedules.

4. Give `/cpaas` its own disk before the store fills `/` again. Mounting a new disk on a directory that already holds files hides those files and does not free their space on `/`. Move or delete them before you mount.

### Cause 2: The global log storage is full and every business cluster that stores logs there has no data

1. Confirm that the business clusters store their logs on the global cluster, and that the global storage nodes are full:

   ```bash
   df -h /cpaas
   du -sh /cpaas/data/*
   kubectl -n cpaas-system get pods | grep -E 'elasticsearch|kafka|zookeeper'
   ```

2. Offload each business cluster:
   1. Prepare 3 to 5 log storage nodes in the business cluster.
   2. Mount a separate disk for the Elasticsearch data directory on each of them.
   3. Deploy the Elasticsearch log storage plugin on the business cluster from the cluster plugins.
   4. Change the storage cluster setting of that cluster's log collection plugin to the new storage.

   > **Warning:** Repointing a business cluster's log collector to a new storage leaves its history on the old store, and the new storage starts empty. Precondition: the new storage is deployed and healthy. Rollback: set the collector's storage cluster back to global.

3. After every business cluster stores its own logs, repair the global storage. Either expand `/cpaas`, or clear its log data with the scale-to-0 and directory cleanup shown in Cause 1.

### Cause 3: Elasticsearch CPU is high right after a full disk was freed

1. Check whether the storage graph dropped sharply and whether retention was just shortened. If both are true, the CPU is the backlog being indexed.

   ```bash
   kubectl -n cpaas-system get pod | grep -E 'cpaas-kafka|cpaas-zookeeper|cpaas-elasticsearch|lanaya|razor'
   kubectl -n cpaas-system top pod | grep cpaas-elasticsearch
   ```

   Recent restarts of the Elasticsearch and `razor` pods, a storage graph that dropped from about 100%, and lag that starts falling at the same moment match this cause.

2. Raise the CPU limit.

   > **Warning:** Raising the Elasticsearch CPU limit on the log storage plugin rolls every Elasticsearch pod, and ingestion pauses on each pod while it restarts. Precondition: only when the storage graph shows the disk was just freed, lag is falling, and CPU is at its limit. Rollback: set the previous CPU limit back on the plugin.

   Raise the Elasticsearch CPU on the log storage plugin (6 cores was enough here). Watch the lag fall. CPU returns to normal (below about one core per pod) once the backlog is indexed.

## Diagnostic Steps

1. Read the pod state and the disk:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep -E 'elasticsearch|kafka|lanaya'
   df -hT / /cpaas
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | `/cpaas` is not a separate mount, or a `Pending` Elasticsearch pod on a node with the `disk-pressure` taint | Cause 1 |
   | Every business cluster failing at once, with its collector pointed at the global log storage | Cause 2 |
   | High Elasticsearch CPU right after the storage graph dropped from a full disk | Cause 3 |

## Related Information

- Related articles: [Elasticsearch log indices red or yellow with unassigned shards on ACP](./Elasticsearch_log_indices_red_or_yellow_with_unassigned_shards_on_ACP.md) covers shards that stay unassigned after space was freed, single-node replicas, and indices that stay red.
- [Logs, audit and events stop while the log Kafka is degraded on ACP](./Logs_audit_and_events_stop_while_the_log_Kafka_is_degraded_on_ACP.md)
