---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Elasticsearch log index replica count reverts after editing the index template on ACP

## Issue

The replica count of the platform log indices needs to change, for example to give each shard a copy or to remove replicas on a single-node cluster. The indices are the platform log indices in the Elasticsearch log storage (Alauda Container Platform Log Storage for Elasticsearch, `cpaas-elasticsearch` in `cpaas-system`), such as `log-workload-<date>`.

`number_of_replicas` was changed in the index template directly in Elasticsearch, through the `_template` API or a tool such as Kibana. Shortly afterwards the old value is back, and new daily indices keep the old replica count.

## Root Cause

The platform manages the settings of the log index templates through ConfigMap `aiops-logging-config` in namespace `cpaas-system`, on the cluster that runs the log storage. The platform writes the templates from that ConfigMap, so a change made only in the Elasticsearch template is reverted. Changing the replica count is supported, but it has to be made in the ConfigMap.

Each key of the ConfigMap holds one template. The `log.json` key holds the template for `"index_patterns": "log-*"` (`"order": 1`). Its `settings` look like this:

```json
"index.lifecycle.name": "alauda-log",
"number_of_shards": 1,
"number_of_replicas": 1,
"refresh_interval": "10s"
```

The field to change is `"number_of_replicas"` in the `settings` of the key whose `index_patterns` matches the indices you want to change.

## Resolution

1. On the cluster that runs the Elasticsearch log storage, find the ConfigMap and save a copy:

   ```bash
   kubectl get cm -A | grep aiops
   kubectl -n cpaas-system get cm aiops-logging-config -o yaml > /tmp/aiops-logging-config.before.yaml
   ```

   The listing shows three ConfigMaps in `cpaas-system`: `aiops-logging-config`, `aiops-monitor-config` and `aiops-nf-migrate-config`. Only `aiops-logging-config` holds the log index templates.

2. Edit `"number_of_replicas"` in the `settings` of the key whose `index_patterns` matches the indices (`log.json` for `log-*`). Change only `number_of_replicas`, and keep the other settings of the key as they are.

   > **Warning:** The replica count decides how many copies of each shard exist. With `0`, every shard has a single copy, so losing one data node loses that node's data. A higher value needs proportionally more disk on the data nodes and starts replica recovery traffic for each new index. A replica can never be placed on the node that holds its primary, so a single-node Elasticsearch stays `yellow` with any value above `0`. Precondition: the number of data nodes is larger than the new replica count, there is disk for the extra copies, and the backup from step 1 is saved. Rollback: `kubectl apply -f /tmp/aiops-logging-config.before.yaml`.

   ```bash
   kubectl -n cpaas-system edit cm aiops-logging-config
   ```

3. Check that the template now has the new value and that the value is not reverted:

   ```bash
   ES_USER=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.username}' | base64 -d)
   ES_PASS=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.password}' | base64 -d)
   kubectl -n cpaas-system exec cpaas-elasticsearch-0 -c cpaas-elasticsearch -- \
     curl -sS -u "${ES_USER}:${ES_PASS}" 'http://cpaas-elasticsearch:9200/_template?pretty' \
     | grep -n -E '"log-\*"|number_of_replicas'
   ```

4. A template applies only to indices created after the change, so the new count shows from the next daily index onward. `number_of_replicas` is a dynamic Elasticsearch index setting. Indices that already exist keep their count unless you change it on them with the `_settings` API:

   ```bash
   kubectl -n cpaas-system exec cpaas-elasticsearch-0 -c cpaas-elasticsearch -- \
     curl -sS -u "${ES_USER}:${ES_PASS}" -X PUT -H 'Content-Type: application/json' \
     'http://cpaas-elasticsearch:9200/<index>/_settings' -d '{"index":{"number_of_replicas":<n>}}'
   ```

## Diagnostic Steps

1. Read the replica count the indices actually have (with `ES_USER` and `ES_PASS` loaded as in Resolution step 3):

   ```bash
   kubectl -n cpaas-system exec cpaas-elasticsearch-0 -c cpaas-elasticsearch -- \
     curl -sS -u "${ES_USER}:${ES_PASS}" 'http://cpaas-elasticsearch:9200/_cat/indices/log-*?v&h=index,health,pri,rep&s=index' | tail -5
   ```

2. Compare it with `number_of_replicas` in `aiops-logging-config`:

   ```bash
   kubectl -n cpaas-system get cm aiops-logging-config -o jsonpath='{.data.log\.json}' | grep -n -E 'index_patterns|number_of_replicas|number_of_shards'
   ```

   If the template value matches the ConfigMap and not the value you set in Elasticsearch, the platform has restored the ConfigMap value. Change the ConfigMap as described above.

## Related Information

- [Elasticsearch log indices red or yellow with unassigned shards on ACP](./Elasticsearch_log_indices_red_or_yellow_with_unassigned_shards_on_ACP.md), for a single-node Elasticsearch that stays `yellow` because its indices have replicas.
- [Log Kafka lag from Elasticsearch write hot spots, breaker trips, IK analyzer errors, or too few partitions on ACP](./Log_Kafka_lag_from_Elasticsearch_write_hot_spots_breaker_trips_IK_analyzer_errors_or_too_few_partitions_on_ACP.md), for `number_of_shards` in the same `log.json` settings.
