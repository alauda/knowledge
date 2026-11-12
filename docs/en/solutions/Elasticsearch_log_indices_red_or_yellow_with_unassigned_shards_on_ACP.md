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

# Elasticsearch log indices red or yellow with unassigned shards on ACP

## Issue

Platform logs or events cannot be viewed, or the newest log is hours old. Typical reports:

- "System logs cannot be viewed. The newest log is from last night."
- "The event query returns no data."
- "The ES cluster state alarm fired and we cannot find why."
- "A newly deployed ES alerts with status 2."
- "The log ES is down. How do we recover it?"

On the Elasticsearch log storage (Alauda Container Platform Log Storage for Elasticsearch, `cpaas-elasticsearch` in `cpaas-system`), `_cluster/health` or `_cat/indices` shows `red` or `yellow` indices and unassigned shards. `lanaya` may report that there is no space to allocate primary shards, and Kafka backs up behind it.

`lanaya` consumes the log topics in order. It takes the next message only after the current one is persisted. A single index that cannot accept writes therefore stalls the whole consumer, and Kafka lag grows from that moment.

The built-in alert rule for this state is `ES 集群的状态 > 0 且持续 5 分钟` ("ES cluster status above 0 for 5 minutes", severity critical) in the `cpaas-log-rules` policy. Status 1 is `yellow` and status 2 is `red`.

When an Elasticsearch pod is `Pending`, every business cluster loses logs at once, or CPU is high right after the disk was freed, see [Elasticsearch log storage Pending or every cluster loses logs after the log disk fills on ACP](./Elasticsearch_log_storage_Pending_or_every_cluster_loses_logs_after_the_log_disk_fills_on_ACP.md).

## Root Cause

### Cause 1: lanaya reports no space to allocate primary shards, and the current index is red

The data path (`/cpaas`) is above about 80% or full. The current day's index cannot allocate its primary shard, so it is `red`. `lanaya` cannot persist the batch it holds and logs bulk failures such as:

```text
"type":"unavailable_shards_exception","reason":"[event-<date>][0] primary shard is not active Timeout: [1m], request: [BulkShardRequest [[event-<date>][0]] containing [2] requests]"
elasticsearch/elasticsearch.go:166] Database bulk error {"bulkSize": 100, ... "error": "bulk response error"}
```

`_cluster/allocation/explain` for the unassigned primary returns `"reason" : "ALLOCATION_FAILED"` after 5 attempts. It shows `failed to create shard, failure FileSystemException[... No space left on device]` and `"allocate_explanation" : "cannot allocate because allocation is not permitted to any of the nodes that hold an in-sync shard copy"`. The Kafka dashboard can show the same full disk first: the consume rate drops to 0, and lag on every `alauda_log` partition climbs.

Deleting the largest recent indices frees the disk. Shard allocation then has to be triggered again, with a reroute retry or an Elasticsearch restart, before every index recovers. A single project index of about 200 GB per day is beyond what a small-scale deployment is sized for: [Elasticsearch Scale Switching](./Elasticsearch_Scale_Switching.md) rates small scale at up to 12,000 entries per second and 300 GB of total logs. If the disk fills again the next day, the store is too small for the volume. Expand the disk, reduce the applications' log output, or shorten retention.

### Cause 2: The disk was expanded, and Elasticsearch still reports insufficient space on that node

One data node filled. After its disk was expanded, the cluster still reports insufficient disk on that node, and shard allocation stays failed. Elasticsearch stops retrying a shard after repeated allocation failures (`max_retries`), so the shards wait even though space now exists. `POST _cluster/reroute?retry_failed=true` reallocates them. The cluster turns `green` and the Kafka backlog drains.

### Cause 3: A single-node Elasticsearch has indices with replicas

The state alarm fires, the pods are `Running`, and the node disks are fine. `_cluster/health` on the single-node Elasticsearch returns `"status" : "yellow"`, `"number_of_nodes" : 1`, many `unassigned_shards`, and `"unassigned_primary_shards" : 0`. `_cat/indices` lists indices such as `audit-*` and `event-*` as `yellow` with `pri 1 rep 1`.

`GET _cluster/allocation/explain` shows replica shards with reason `INDEX_CREATED`, `"can_allocate":"no"`, and the `same_shard` decider answering `a copy of this shard is already allocated to this node`. A single node cannot host a replica of its own primary, so those indices stay `yellow` forever. Setting `number_of_replicas` to 0 on all indices lets health turn `green` gradually. For high availability, run at least three Elasticsearch nodes instead.

### Cause 4: An earlier cleanup left historical indices behind

On a multi-node Elasticsearch with the same alarm, abnormal indices are present. Deleting only the visibly abnormal ones does not make the cluster `green`. An earlier cleanup of historical indices was incomplete, and older indices are still there. A complete cleanup of everything outside the retention window recovers the cluster.

### Cause 5: Every index turns red after a reinstall following an Elasticsearch major version upgrade

Elasticsearch was reinstalled after its disk filled, and application logs still do not appear. All indices are `red`. The suspected reason, which has not been confirmed, is that `nevermore` uploaded cache from before the platform upgrade that is not compatible with the new index version (Elasticsearch moved from v7 to v8). Cleaning the Elasticsearch data again fixes it. Afterwards every index holds the current day's logs and is `green`, apart from a few pipeline indices.

### Cause 6: The cluster is red with one unassigned primary shard in a single daily index, and the disk has room

Disk usage on the Elasticsearch nodes is fine. `_cluster/health` returns `red` with `unassigned_shards` at 1. `_cat/shards` shows primary shard `0` of one daily project index (named like `log-project-<project>-<YYYYMMDD>`) as `UNASSIGNED`, while every other primary is `STARTED`. One unassigned primary is enough to make the whole cluster `red`. Why that shard could not be assigned is not known. Deleting that one index brings the cluster back to `green` with 0 unassigned shards. The log data in that index is lost.

## Resolution

Load the credentials and a helper for the API calls below:

```bash
ES_USER=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.username}' | base64 -d)
ES_PASS=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.password}' | base64 -d)
es() { kubectl -n cpaas-system exec cpaas-elasticsearch-0 -c cpaas-elasticsearch -- \
  curl -sS -u "${ES_USER}:${ES_PASS}" "$@"; }
```

### Cause 1: lanaya reports no space to allocate primary shards, and the current index is red

1. Confirm the signature:

   ```bash
   df -hT /cpaas
   es 'http://cpaas-elasticsearch:9200/_cat/indices?v&health=red'
   es 'http://cpaas-elasticsearch:9200/_cat/indices?v&h=index,health,store.size&s=store.size:desc' | head -15
   es 'http://cpaas-elasticsearch:9200/_cluster/allocation/explain?pretty' | grep -E 'reason|No space|explanation'
   kubectl -n cpaas-system logs deploy/lanaya --tail=100 | grep -iE 'disk|space|shard|unavailable_shards'
   ```

   Run `df` on the Elasticsearch nodes.

2. Free space by deleting the largest historical indices.

   > **Warning:** Deleting an index permanently removes every log in it. Precondition: only indices you have chosen by exact name from the size listing, outside the period that must be kept. Never use wildcards. Rollback: none without a snapshot.

   ```bash
   es -X DELETE 'http://cpaas-elasticsearch:9200/<index-name>'
   ```

3. Let the red index allocate. Try the reroute retry in Cause 2 first. A restart of the Elasticsearch pods also triggers allocation:

   > **Warning:** Restarting the Elasticsearch pods one at a time degrades log search and ingestion while each pod is down. Precondition: only when this cause is confirmed and `df` now shows free space below the watermark. Rollback: none needed; the StatefulSet recreates the pods.

   ```bash
   for p in $(kubectl -n cpaas-system get pod -l service_name=cpaas-elasticsearch -o name); do
     kubectl -n cpaas-system delete "$p"; sleep 15
     kubectl -n cpaas-system wait --for=condition=Ready "$p" --timeout=15m
   done
   ```

4. If the disk refills within a day, expand `/cpaas`, shorten the retention in the log storage settings, or reduce the applications' log output.

### Cause 2: The disk was expanded, and Elasticsearch still reports insufficient space on that node

1. Confirm the signature:

   ```bash
   es 'http://cpaas-elasticsearch:9200/_cat/allocation?v'
   es 'http://cpaas-elasticsearch:9200/_cluster/allocation/explain?pretty' | head -40
   ```

   `max_retries`, or a stale disk message for a node that now has room, matches this cause.

2. Retry the failed allocations.

   > **Warning:** A reroute retry starts moving and recovering shards at once, which adds disk and network load. Precondition: only when the node's disk was already expanded or cleaned and `df` confirms the free space. Rollback: none; recoveries that started run to completion.

   ```bash
   es -X POST 'http://cpaas-elasticsearch:9200/_cluster/reroute?retry_failed=true'
   es 'http://cpaas-elasticsearch:9200/_cluster/health?pretty'
   ```

3. Watch the Kafka lag fall afterwards.

### Cause 3: A single-node Elasticsearch has indices with replicas

1. Confirm the signature:

   ```bash
   es 'http://cpaas-elasticsearch:9200/_cat/nodes?v'
   es 'http://cpaas-elasticsearch:9200/_cluster/allocation/explain?pretty' | grep -E 'index|primary|explanation' | head
   ```

2. Set the replicas to 0.

   > **Warning:** With `number_of_replicas` at 0, every shard exists once. If more data nodes join later, the indices have no copy until the value is raised again. Precondition: only when the cluster really has one data node and the unassigned shards are replicas. Rollback: set `number_of_replicas` back to 1 after a second data node joins.

   ```bash
   es -X PUT -H 'Content-Type: application/json' \
     'http://cpaas-elasticsearch:9200/*/_settings' \
     -d '{"index":{"number_of_replicas":0}}'
   ```

3. Health should turn `green` over the next minutes. New daily indices are created from the platform index template, which sets one replica. Recheck the next day, and change the template value as described in [Elasticsearch log index replica count reverts after editing the index template on ACP](./Elasticsearch_log_index_replica_count_reverts_after_editing_the_index_template_on_ACP.md).

### Cause 4: An earlier cleanup left historical indices behind

1. List every index that is not `green` and every index older than the retention window:

   ```bash
   es 'http://cpaas-elasticsearch:9200/_cat/indices?v&s=index' | grep -v green
   ```

2. Delete each old index by exact name, with the command and warning in Cause 1. Repeat until `_cat/indices` holds only indices inside the window.

### Cause 5: Every index turns red after a reinstall following an Elasticsearch major version upgrade

1. Confirm the signature:

   ```bash
   es 'http://cpaas-elasticsearch:9200/_cat/indices?v&h=index,health,docs.count,creation.date.string&s=index'
   ```

   Every index is `red` right after Elasticsearch was reinstalled on the new major version.

2. Clean the data again.

   > **Warning:** Cleaning the Elasticsearch data removes every index, including the red ones. Precondition: only when this cause is confirmed and Elasticsearch holds no history that must be kept. Rollback: none.

   Record the replica count and scale the Elasticsearch StatefulSet to 0:

   ```bash
   kubectl -n cpaas-system get sts cpaas-elasticsearch
   kubectl -n cpaas-system scale sts cpaas-elasticsearch --replicas=0
   ```

   On each Elasticsearch node, empty the Elasticsearch data directory (`/cpaas/data/elasticsearch` by default):

   ```bash
   cd /cpaas/data/elasticsearch && rm -rf ./*
   ```

   Scale the StatefulSet back:

   ```bash
   kubectl -n cpaas-system scale sts cpaas-elasticsearch --replicas=<previous>
   ```

3. Check `_cat/indices` again. The indices should hold the current day's logs and be `green`.

### Cause 6: The cluster is red with one unassigned primary shard in a single daily index, and the disk has room

1. Confirm the signature: the disk has room, exactly one primary is unassigned, and it belongs to one index.

   ```bash
   df -hT /cpaas
   es 'http://cpaas-elasticsearch:9200/_cluster/health?pretty' | grep -E '"status"|unassigned'
   es 'http://cpaas-elasticsearch:9200/_cat/shards?v&h=index,shard,prirep,state,unassigned.reason' | grep UNASSIGNED
   es 'http://cpaas-elasticsearch:9200/_cluster/allocation/explain?pretty' | grep -E '"index"|"shard"|"reason"|explanation'
   ```

   Save the allocation explanation before you act. If it says allocation failed for lack of space on a node that now has room, use Cause 2 instead. If `df` is above the watermark, use Cause 1.

2. Delete that index.

   > **Warning:** Deleting the index permanently removes every log stored in it, which for a daily project index is one day of that project's logs. Precondition: only when the cluster is `red` because of an unassigned primary of this one index, `df` shows free space, the other primaries are `STARTED`, and the owner accepts losing that index. Take the exact name from `_cat/shards`, without wildcards. Rollback: none without a snapshot.

   ```bash
   es -X DELETE 'http://cpaas-elasticsearch:9200/<index-name>'
   es 'http://cpaas-elasticsearch:9200/_cluster/health?pretty' | grep -E '"status"|unassigned'
   ```

   Health should return to `green` with `unassigned_shards` at 0.

## Diagnostic Steps

1. Check disk and health together:

   ```bash
   df -hT / /cpaas
   es 'http://cpaas-elasticsearch:9200/_cluster/health?pretty'
   es 'http://cpaas-elasticsearch:9200/_cluster/allocation/explain?pretty' | head -40
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | A red current index, with `unavailable_shards_exception` in `lanaya` or `No space left on device` in allocation explain, or a consume rate at 0 with `/cpaas` near full | Cause 1 |
   | Space available, and allocation still failed on one node | Cause 2 |
   | One node with unassigned replicas and the `same_shard` decider answering no | Cause 3 |
   | Old indices beyond the retention window still present | Cause 4 |
   | All indices red right after a reinstall on a new major version | Cause 5 |
   | A red cluster with enough disk and a single unassigned primary in one index | Cause 6 |

## Related Information

- Related articles: [Elasticsearch log storage Pending or every cluster loses logs after the log disk fills on ACP](./Elasticsearch_log_storage_Pending_or_every_cluster_loses_logs_after_the_log_disk_fills_on_ACP.md) covers a `Pending` Elasticsearch pod, a full global log storage, and high CPU after the disk was freed.
- [Elasticsearch log index replica count reverts after editing the index template on ACP](./Elasticsearch_log_index_replica_count_reverts_after_editing_the_index_template_on_ACP.md)
- [Elasticsearch Scale Switching](./Elasticsearch_Scale_Switching.md)
