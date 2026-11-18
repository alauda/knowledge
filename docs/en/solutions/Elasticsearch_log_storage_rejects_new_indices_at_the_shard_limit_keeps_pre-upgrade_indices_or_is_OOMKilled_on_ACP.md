---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.14.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Elasticsearch log storage rejects new indices at the shard limit, keeps pre-upgrade indices, or is OOMKilled on ACP

## Issue

One of these is seen on the platform log store (`Alauda Container Platform Log Storage for Elasticsearch`, StatefulSet `cpaas-elasticsearch` in `cpaas-system`):

- The day after an upgrade, `lanaya` and other containers keep restarting and the console no longer shows events. Creating an index returns `400`:

  ```text
  "illegal_argument_exception","reason":"Validation Failed: 1: this action would add [2] total shards, but this cluster currently has [6446]/[5000] maximum shards open;"
  ```

- After an upgrade, Elasticsearch still holds old indices that were not refreshed to 7.x.
- Deploying the Elasticsearch log storage plugin on a business cluster fails, and the Elasticsearch container is `OOMKilled` again and again from the first start.

High CPU or memory with too many shards, master memory, heap OOM, and small-scale role contention are in [Elasticsearch log storage high CPU or memory: too many shards, master memory, heap OOM, or small-scale layout on ACP](Elasticsearch_log_storage_high_CPU_or_memory_too_many_shards_master_memory_heap_OOM_or_small-scale_layout_on_ACP.md).

## Root Cause

### Cause 1: the cluster is at its maximum number of open shards, so no new index can be created

Elasticsearch limits the open shards of a cluster to `cluster.max_shards_per_node` (community default 1000) times the number of data nodes. At 6446 open shards against a limit of 5000, every new index is rejected, including the new day's event index, so events disappear from the console and `lanaya` restarts. Raising the cap does not improve performance; deleting historical and unused indices freed capacity, after which events were displayed again and `lanaya` returned to normal.

The same upgrade changed the Elasticsearch workload to a StatefulSet. A resource patch (`rpch`) that had held the earlier resource limits no longer applied, so those limits had to be set again on the StatefulSet.

### Cause 2: indices created before the upgrade remain on the older version

Elasticsearch does not rewrite an existing index to the new version during an upgrade. The indices in question were created before the upgrade, and the log retention in use was no more than 3 days, so they were outside the retention the cluster keeps. Deleting them returned the service to normal.

### Cause 3: the memory in the plugin form was entered with the wrong unit

The container got far less memory than intended because the log node resources were entered as request `2` cores / `4Mi` and limit `8` cores / `16Mi`, where `Gi` was meant. The container is killed for memory from its first start. After the unit was corrected, the deployment completed. A log delay that appeared afterwards on that cluster was a separate resource bottleneck in `lanaya` and Elasticsearch; the final values there were 12 CPU / 16G for Elasticsearch and 3 CPU / 4G for `lanaya`.

## Resolution

Set the connection variables on a node of the cluster that runs Elasticsearch:

```bash
ES_SVC=$(kubectl -n cpaas-system get svc cpaas-elasticsearch -o jsonpath='{.spec.clusterIP}')
ES_USER=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.username}' | base64 -d)
ES_PASS=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.password}' | base64 -d)
```

### Cause 1: the cluster is at its maximum number of open shards, so no new index can be created

1. Read the shard count, the limit, and the oldest indices:

   ```bash
   curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cluster/health?filter_path=active_shards,unassigned_shards,number_of_data_nodes"
   curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cluster/settings?include_defaults=true&filter_path=**.max_shards_per_node"
   curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cat/indices?v&h=index,pri,rep,creation.date.string,store.size&s=creation.date" | head -50
   ```

2. To confirm that index creation is rejected, create a throwaway index. A `400` with `maximum shards open` confirms this cause; if the request succeeds, delete the test index right away.

   ```bash
   curl -s -u "$ES_USER:$ES_PASS" -X PUT "http://$ES_SVC:9200/test_index_0"
   curl -s -u "$ES_USER:$ES_PASS" -X DELETE "http://$ES_SVC:9200/test_index_0"
   ```

3. Delete historical or unused indices by name.

   > **Warning:** Deleting indices removes those logs, events, or audit records permanently. Precondition: the indices are older than the retention you keep, or belong to index families nobody queries, and the owner agreed. Rollback: none without a snapshot.

   ```bash
   curl -s -u "$ES_USER:$ES_PASS" -X DELETE "http://$ES_SVC:9200/<old-index-1>,<old-index-2>"
   ```

   Delete until the open-shard count is well below the limit, then check that the new day's `event-*` index exists and `lanaya` stops restarting. Shorten the retention afterwards, or the count climbs back.

4. If the earlier resource limits must be restored after the upgrade, set them on the StatefulSet.

   > **Warning:** Changing the StatefulSet resources rolls the Elasticsearch pods. Precondition: you saved the StatefulSet YAML and the nodes have the capacity. Rollback: `kubectl apply -f /tmp/cpaas-elasticsearch-sts.before.yaml`.

   ```bash
   kubectl -n cpaas-system get sts cpaas-elasticsearch -o yaml > /tmp/cpaas-elasticsearch-sts.before.yaml
   kubectl -n cpaas-system set resources sts/cpaas-elasticsearch -c cpaas-elasticsearch --limits=cpu=<cpu>,memory=<memory>
   ```

   If the limits snap back after a plugin update or reconcile, set the same values in the plugin form or in the `logcenter` ModuleInfo (`spec.config.components.elasticsearch.resources`).

### Cause 2: indices created before the upgrade remain on the older version

List indices with the version they were created with and their creation date:

```bash
curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_all/_settings/index.version.created" \
  | jq -r 'to_entries[] | "\(.key) \(.value.settings.index.version.created)"' | sort -k2
curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cat/indices?v&h=index,creation.date.string,store.size&s=creation.date"
```

> **Warning:** Deleting the old indices removes those logs permanently. Precondition: each name is an index created before the upgrade and its dates are outside the current retention. Rollback: none.

```bash
curl -s -u "$ES_USER:$ES_PASS" -X DELETE "http://$ES_SVC:9200/<old-index-1>,<old-index-2>"
```

### Cause 3: the memory in the plugin form was entered with the wrong unit

Compare the memory limit on the workload with what you meant to enter:

```bash
kubectl -n cpaas-system get pods | grep cpaas-elasticsearch
kubectl -n cpaas-system get sts cpaas-elasticsearch -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" "}{.resources.limits.memory}{"\n"}{end}'
```

A value in `Mi` where `Gi` was meant confirms it. Update the plugin and enter the memory with the correct unit; the deployment completes once the containers get the intended memory. If logs are delayed afterwards, check `lanaya` and Elasticsearch resources separately.

## Diagnostic Steps

1. Index creation fails or new daily indices are missing: compare `active_shards` with `max_shards_per_node` times `number_of_data_nodes`. At or above the limit is Cause 1.
2. Old indices after an upgrade: an `index.version.created` from the previous major version on indices outside the retention is Cause 2.
3. An Elasticsearch container that is `OOMKilled` from its first start, with a memory limit in `Mi`, is Cause 3. A container with a correct limit that runs out of heap later is the heap OOM in the high CPU or memory article linked above.
