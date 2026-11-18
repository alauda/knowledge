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

# Elasticsearch log storage high CPU or memory: too many shards, master memory, heap OOM, or small-scale layout on ACP

## Issue

The platform log store on Elasticsearch alarms or degrades while its pods stay `Running`:

- Inspection of the global cluster reports "Elasticsearch cluster status > 0", "Es cpu utilization > 90" (CPU of the containers under `cpaas-elasticsearch` above 90% for 1 minute), and "Kafka consumer lag growth rate > 0" together, while all `cpaas-elasticsearch-*`, `cpaas-kafka-*`, `lanaya-*`, and `razor-*` pods are `1/1 Running`.
- One `cpaas-elasticsearch-master` pod stays above 90% memory for days while the other two masters are around 50% and 70%, with no errors in its log.
- Data-node memory was raised, but CPU on the master pod stays high.
- A data pod restarts with `java.lang.OutOfMemoryError: Java heap space`, or `_cat/indices` returns `circuit_breaking_exception` (parent breaker) while the cluster is yellow with many unassigned shards.
- Elasticsearch pods are above 80% of their resources, a write queue builds, and Kafka lag keeps rising, although another cluster with more daily logs is fine.

Elasticsearch runs in `cpaas-system` as StatefulSet `cpaas-elasticsearch` (data nodes) and, in the large-scale layout only, `cpaas-elasticsearch-master` (dedicated masters that manage cluster metadata and shard allocation and hold no shards). The plugin `Alauda Container Platform Log Storage for Elasticsearch` keeps its settings in the `logcenter` ModuleInfo on the global cluster: `spec.config.components.elasticsearch.resources` (data nodes), `masterResources` (masters), and `type`, which is `single`, `normal` (small scale: every pod is both master and data), or `big` (large scale: dedicated master and data pods).

Index creation rejected at the shard limit, pre-upgrade indices, and an OOM from the first start are in [Elasticsearch log storage rejects new indices at the shard limit, keeps pre-upgrade indices, or is OOMKilled on ACP](Elasticsearch_log_storage_rejects_new_indices_at_the_shard_limit_keeps_pre-upgrade_indices_or_is_OOMKilled_on_ACP.md).

## Root Cause

### Cause 1: more than 2,000 shards on 2 CPU / 4Gi data nodes saturate CPU and leave shards unassigned

The data pods run at about 89% to 97% CPU, the cluster status row is above 0, and `_cat/shards` lists `UNASSIGNED` shards across `event-*`, `audit-*`, `meter-detail-*`, and `log-workload-*`. More than 2,000 shards on data nodes sized 2 CPU / 4Gi is more than the nodes can serve, so CPU saturates and shards cannot be allocated. The Kafka lag alarm is the downstream effect.

### Cause 2: one dedicated master stays above 90% memory with about 2,000 shards and 180-day audit retention

Memory is uneven across the dedicated masters while data-node usage is even. The cluster state that the elected master holds grows with the number of indices and shards; with about 2,000 shards and audit indices kept for 180 days, the master's memory stays high. Deleting half of the audit indices was the relief applied; watch the result before deleting more.

### Cause 3: master CPU stays high because the elected master runs out of JVM heap

CPU on a master pod stays high after data-node memory was raised, and health is not green. The single elected master does all shard management and metadata work, and its JVM heap is exhausted; the CPU is the JVM fighting for heap, not query load. Giving the master a larger heap (Java options on the master configuration) ended the OOM and the cluster recovered.

### Cause 4: a data node heap far below its memory limit, or a parent circuit breaker trip

A data pod logs `java.lang.OutOfMemoryError: Java heap space` and restarts. The heap of the running process can be far smaller than the container allows (one node with a `12c24g` limit ran with `-Xmx1g`). Setting `ES_JAVA_OPTS` to `-Xms12g -Xmx12g`, about half the memory limit, stopped the crash. The pod spec is not proof of the heap in use; read the running process.

`circuit_breaking_exception` from the parent breaker, with the cluster yellow, initializing shards, and many unassigned shards, is the same memory pressure. Raising the Elasticsearch limit to 8 CPU / 16Gi and retrying the failed allocations recovered that cluster.

### Cause 5: the small-scale layout, where every pod is both master and data, saturates under load

With `type: normal`, every pod serves reads and writes, holds data, and holds the cluster metadata. The two roles compete for CPU and memory, which leads to GC pauses and heartbeat timeouts. This shows up as pods above 80% of their resources with a moderate daily volume (1,111 indices on a 3 x 16G small-scale cluster), or as a write queue and rising Kafka lag on a small-scale cluster that receives the logs of more than ten business clusters (Elasticsearch at 8 CPU / 16G and 60% to 70% used, Kafka at 2 CPU / 4G, production steady while consumption comes only in bursts). Moving to the large-scale layout with dedicated masters (3 masters with 3 or 5 data pods) resolved both. After the switch, master and data roles are no longer combined in one pod; a master pod and a data pod may still run on the same host, and the switch does not affect business workloads.

## Resolution

Set the connection variables on a node of the cluster that runs Elasticsearch:

```bash
ES_SVC=$(kubectl -n cpaas-system get svc cpaas-elasticsearch -o jsonpath='{.spec.clusterIP}')
ES_USER=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.username}' | base64 -d)
ES_PASS=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.password}' | base64 -d)
curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/"
```

The shell then holds the password; do not share the transcript. Find the ModuleInfo with `kubectl get moduleinfo -A | grep logcenter | grep <cluster-name>` and save it before any change: `kubectl get moduleinfo <moduleinfo-name> -o yaml > /tmp/logcenter-minfo.before.yaml`.

### Cause 1: more than 2,000 shards on 2 CPU / 4Gi data nodes saturate CPU and leave shards unassigned

Only when `active_shards` is above about 2,000, `UNASSIGNED` shards exist, and the data pods are limited to 2 CPU / 4Gi. Raising them to 4 CPU / 8Gi cleared the alarms and let reallocation start.

> **Warning:** Changing the Elasticsearch resources rolls the `cpaas-elasticsearch` pods one by one; log search degrades and Kafka lag grows until they are Ready. Precondition: the signature above is confirmed and each data node has 4 CPU and 8Gi free. Rollback: `kubectl apply -f /tmp/logcenter-minfo.before.yaml`, or set 2 CPU / 4Gi again in the plugin form.

Update the plugin in the console, or:

```bash
kubectl edit moduleinfo <moduleinfo-name>
```

Set `spec.config.components.elasticsearch.resources.limits` to `cpu: "4"` and `memory: 8Gi`, then watch the unassigned count fall:

```bash
curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cluster/health?pretty"
```

### Cause 2: one dedicated master stays above 90% memory with about 2,000 shards and 180-day audit retention

Only when the high memory is on a master pod, the shard count is around 2,000, and audit indices cover a long retention. List them oldest first:

```bash
curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cat/indices/audit-*?v&h=index,pri,rep,store.size&s=index"
```

> **Warning:** Deleting an index is irreversible; the audit records in it are gone, including for compliance review. Precondition: the owner approved the date range, any required audit export was taken, and the names come from the listing above. Rollback: none without a snapshot.

```bash
curl -s -u "$ES_USER:$ES_PASS" -X DELETE "http://$ES_SVC:9200/<audit-index-1>,<audit-index-2>"
```

Then shorten the audit retention in the log storage settings; otherwise new daily indices bring the shard count back. Watch master memory afterwards.

### Cause 3: master CPU stays high because the elected master runs out of JVM heap

Confirm heap exhaustion on the elected master:

```bash
curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cat/master?v"
curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cat/nodes?v&h=name,node.role,master,heap.percent,heap.max,cpu"
kubectl -n cpaas-system logs <es-master-pod> --tail=500 | grep -iE 'OutOfMemoryError|java heap'
kubectl -n cpaas-system get sts cpaas-elasticsearch-master -o yaml | grep -n -iE 'java|Xmx|Xms'
```

Give the masters a larger heap through their Java options, sized from the master memory limit (`masterResources`); raise that limit too if the heap would not fit in about half of it.

> **Warning:** Changing the master Java options or `masterResources` restarts the master pods one at a time; while the elected master restarts, index creation and shard allocation pause. Precondition: you saved the ModuleInfo and the master StatefulSet YAML, and the nodes have the extra memory. Rollback: apply the saved objects.

Afterwards `_cat/nodes` shows a larger `heap.max` on the masters, and master CPU drops once health is green.

### Cause 4: a data node heap far below its memory limit, or a parent circuit breaker trip

1. Read the heap of the running process and the memory limit:

   ```bash
   kubectl -n cpaas-system exec cpaas-elasticsearch-0 -c cpaas-elasticsearch -- ps -ef | grep -o -- '-Xm[sx][^ ]*'
   kubectl -n cpaas-system get sts cpaas-elasticsearch -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" "}{.resources.limits}{"\n"}{end}'
   ```

2. If the heap is far below half the limit, set it to about half.

   > **Warning:** Editing `ES_JAVA_OPTS` rolls Elasticsearch; search and ingest stop on each pod while it restarts. A heap larger than about half the limit, or larger than the node can give, gets the pod `OOMKilled` (exit 137) instead. Precondition: you saved the StatefulSet YAML, and the new `-Xmx` is about half the memory limit (12g on 24Gi, 24g on 48Gi). Rollback: `kubectl apply -f` the saved YAML.

   ```bash
   kubectl -n cpaas-system get sts cpaas-elasticsearch -o yaml > /tmp/cpaas-elasticsearch-sts.before.yaml
   kubectl -n cpaas-system edit sts cpaas-elasticsearch
   ```

   Set `ES_JAVA_OPTS` to `-Xms<half>g -Xmx<half>g`. Do not set the heap through a resource patch (`rpch`) override; one such override started a pod with `-Xmx0m`. If a plugin update reverts the StatefulSet, make the same change where the plugin keeps its Elasticsearch settings.

3. For the parent circuit breaker, raise the data-node limit (8 CPU / 16Gi in the recovered case) the same way as Cause 1, then retry failed allocations.

   > **Warning:** Retrying allocation starts shard copies; on a disk that is over the watermark this fills the node again. Precondition: health is yellow because of allocation, not red, and `df` on the data nodes has room. Rollback: none for copies already started.

   ```bash
   curl -s -u "$ES_USER:$ES_PASS" -X POST "http://$ES_SVC:9200/_cluster/reroute?retry_failed=true"
   ```

### Cause 5: the small-scale layout, where every pod is both master and data, saturates under load

Confirm the layout and the write pressure:

```bash
kubectl get moduleinfo <moduleinfo-name> -o jsonpath='{.spec.config.components.elasticsearch.type}{"\n"}'
curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cat/indices?h=index" | wc -l
curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cat/thread_pool/write?v&h=node_name,active,queue,rejected"
```

Switch to large scale:

- On 3.x consoles, update the Elasticsearch log storage plugin in Cluster Plugins and change the scale to large.
- From 4.0, edit the `logcenter` ModuleInfo as in [Elasticsearch Scale Switching](Elasticsearch_Scale_Switching.md): add data nodes in `spec.config.components.elasticsearch.k8sNodes`, master nodes in `masterK8sNodes` (3 masters with 5 data nodes was the recommendation), set data-node `resources.limits` to at least the large-scale default of 8 CPU / 16Gi, and change `type` from `normal` to `big`. Node lists and limits can also be changed later in the plugin form; `type` is changed only in the ModuleInfo.

> **Warning:** The switch restarts the Elasticsearch components; logs cannot be queried until the new pods are up. Business workloads are not affected and stored logs are kept. Precondition: the new master and data nodes have the resources and `/cpaas` disk for the large-scale layout, you saved the ModuleInfo, and a gap in log search is acceptable. Rollback: no return path from `big` to `normal` is documented; plan the switch as a forward change.

```bash
kubectl edit moduleinfo <moduleinfo-name>
```

Confirm the plugin shows as installed and logs can be queried. While the switch is being planned, raising Kafka from 2 CPU / 4G to 4 CPU / 8G and `lanaya` from 2 to 4 or 6 replicas eased the write queue.

## Diagnostic Steps

1. Health, roles, heap, and shards:

   ```bash
   curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cluster/health?pretty"
   curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cat/nodes?v&h=name,node.role,master,cpu,heap.percent,ram.percent"
   curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cat/shards?v" | grep UNASSIGNED | head -20
   kubectl -n cpaas-system get pods -o wide | grep -E 'elasticsearch|kafka|lanaya|razor'
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | `active_shards` above about 2,000, `UNASSIGNED` shards, data pods at a 2-core limit | 1 |
   | One master with much higher `ram.percent` than the others, long audit retention | 2 |
   | Master at high CPU, elected master `heap.percent` near 100, health not green | 3 |
   | `Java heap space` on a data pod with a small `-Xmx`, or `circuit_breaking_exception` | 4 |
   | Every node shows both master and data roles, cluster saturated | 5 |

3. If plain HTTP to the Service is refused, read the address the platform uses (`kubectl -n cpaas-system get feature log-center -o jsonpath='{.spec.accessInfo.elasticsearch.address}'`) and call it with `curl -k`.
