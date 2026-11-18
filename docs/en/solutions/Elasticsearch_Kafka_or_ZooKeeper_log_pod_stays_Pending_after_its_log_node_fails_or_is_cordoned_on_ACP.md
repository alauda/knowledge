---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Elasticsearch, Kafka, or ZooKeeper log pod stays Pending after its log node fails or is cordoned on ACP

## Issue

The log storage plugin `Alauda Container Platform Log Storage for Elasticsearch` uses local storage, and a log pod does not move:

- A node that hosts Elasticsearch, Kafka, and ZooKeeper failed and was taken offline. `cpaas-elasticsearch-0`, `cpaas-kafka-1`, and `cpaas-zookeeper-2` (for example) are `Pending` with no node assigned, or stay `Terminating`, while the other two replicas of each are `Running`. The question is how to move them to another node.
- Replacing the failed node with another node in the plugin's log node list does not take effect: the plugin shows `安装失败` (installation failed), and the Kafka node list cannot be changed.
- A node that hosts Elasticsearch must be shut down for maintenance.
- After a resource change, a scale to 0 and back, or a PVC resize, an Elasticsearch, Kafka, or ZooKeeper pod stays `Pending` on a log node that was made unschedulable.
- A new cluster should reserve 3 nodes for logging only, and the question is which access mode the local log disks should use.

## Root Cause

### Cause 1: log pods are pinned to their node by local persistent volumes

With LocalVolume storage the plugin creates local PVs whose node affinity names one node, and the data sits under `/cpaas/data` on that node. Each Elasticsearch, Kafka, and ZooKeeper pod therefore belongs to its node: when the node fails, the pod does not move to another node, it waits for its node to return. Local volumes are single-node read-write (ReadWriteOnce), which is the correct mode for local disks; block storage such as TopoLVM or Ceph RBD also gives single-node access.

With three replicas, log collection continues on the two remaining replicas. In one case, Kafka production and consumption stayed matched (both dropped from about 800 to about 550 messages per minute) and the Elasticsearch write queue stayed near zero, so the cluster ran on two nodes until the failed node was repaired and rejoined; the Elasticsearch pod then returned to `Running` on it. Elasticsearch was `red` afterwards with unassigned shards (8 shards, 98.5% active), and deleting expired historical indices returned it to normal.

During a planned outage of a data node in a large-scale layout, Elasticsearch allocates the replicas of that node's shards elsewhere and writes nothing new to it; when the node returns, shards are allocated back. For a data node down about 6 hours on a lightly loaded cluster, the impact on logging and on the global cluster was small.

### Cause 2: a recreated log pod stays Pending on a cordoned log node

A cordoned node accepts no new pods; pods that keep running there were scheduled before the cordon. Cordoning the log nodes after Elasticsearch is deployed is the way to keep them for logging only. If a log pod is then deleted or recreated (a resource change, a scale to 0 and back, a PVC resize), its local PV ties it to the cordoned node, so it stays `Pending` until the node is uncordoned. This is the expected side effect of that setup.

## Resolution

### Cause 1: log pods are pinned to their node by local persistent volumes

1. Confirm that the pods wait for their node:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep -E 'cpaas-elasticsearch|cpaas-kafka|cpaas-zookeeper'
   kubectl get pv -o custom-columns=NAME:.metadata.name,CLAIM:.spec.claimRef.name,NODE:.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0] | grep -iE 'elasticsearch|kafka|zookeeper'
   ```

2. Bring the failed node back; the pods follow the node, not the scheduler. Do not replace the node in the plugin's log node list to move the pods: that does not take effect and leaves the plugin in a failed state.
3. While the node is down, check that the remaining replicas keep up: on the Kafka monitoring dashboard, production and consumption rates should match and the Elasticsearch write queue should stay near zero, and log queries should stay current.
4. After the node is `Ready` and the pods are `Running`, check Elasticsearch health:

   ```bash
   ES_SVC=$(kubectl -n cpaas-system get svc cpaas-elasticsearch -o jsonpath='{.spec.clusterIP}')
   ES_USER=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.username}' | base64 -d)
   ES_PASS=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.password}' | base64 -d)
   curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cluster/health?pretty"
   curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cat/shards?v" | grep UNASSIGNED
   ```

   If it is `red` and the unassigned shards belong to expired historical indices, delete those indices by name, as described in [Elasticsearch log indices red or yellow with unassigned shards on ACP](Elasticsearch_log_indices_red_or_yellow_with_unassigned_shards_on_ACP.md).

5. For a planned shutdown of a node that also hosts Kafka and ZooKeeper, or whose Elasticsearch role is not known, stop the logging components first and do not drain; see [Shutting down or rebooting ACP nodes for maintenance](Shutting_down_or_rebooting_ACP_nodes_for_maintenance.md). The cordon and drain below applies only to a confirmed Elasticsearch data node in a large-scale layout with enough remaining data nodes:

   ```bash
   curl -s -u "$ES_USER:$ES_PASS" "http://$ES_SVC:9200/_cluster/health?pretty"
   kubectl cordon <es-node>
   ```

   > **Warning:** Draining evicts every pod on the node; the Elasticsearch data pod on it stays `Pending` until the node returns, and the cluster runs with one data node fewer (yellow while replicas are reallocated). Precondition: the cluster is green, the layout is large scale with enough remaining data nodes, and the maintenance window is agreed. Rollback: `kubectl uncordon <es-node>` after the node is back; Elasticsearch allocates shards back.

   ```bash
   kubectl drain <es-node> --ignore-daemonsets --delete-emptydir-data
   ```

   Power off, do the maintenance, start the node, run `kubectl uncordon <es-node>`, and wait for health to return to green.

### Cause 2: a recreated log pod stays Pending on a cordoned log node

To reserve nodes for logging, deploy Elasticsearch on them first and then cordon them:

```bash
kubectl -n cpaas-system get pods -o wide | grep -E 'cpaas-elasticsearch|cpaas-kafka|cpaas-zookeeper'
kubectl cordon <log-node-1> <log-node-2> <log-node-3>
```

Any later step that recreates a log pod on those nodes needs an uncordon first and a cordon afterwards.

> **Warning:** While the log nodes are uncordoned, the scheduler can place other workloads on them. Precondition: the change that recreates the log pods is ready to run right away. Rollback: cordon the nodes again as soon as the log pods are `Running`; pods that landed there in the meantime must be moved by their owners.

```bash
kubectl uncordon <log-node-1> <log-node-2> <log-node-3>
# run the change that recreates the log pods, then wait until each is Running on its node
kubectl -n cpaas-system get pods -o wide | grep -E 'cpaas-elasticsearch|cpaas-kafka|cpaas-zookeeper'
kubectl cordon <log-node-1> <log-node-2> <log-node-3>
```

## Diagnostic Steps

1. A `Pending` log pod after its node went down, with its PV bound to that node, is Cause 1.
2. A `Pending` log pod whose PV node is `Ready` but `SchedulingDisabled` is Cause 2:

   ```bash
   kubectl get nodes | grep SchedulingDisabled
   kubectl -n cpaas-system describe pod <pending-pod> | sed -n '/Events/,$p'
   ```

3. The access mode of the existing log volumes:

   ```bash
   kubectl get pvc -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,MODES:.spec.accessModes,SC:.spec.storageClassName | grep -E 'elasticsearch|kafka|zookeeper'
   ```

4. A log pod that is `Pending` because of `node.kubernetes.io/disk-pressure`, not a down or cordoned node, is a full disk; see [Elasticsearch log storage Pending or every cluster loses logs after the log disk fills on ACP](Elasticsearch_log_storage_Pending_or_every_cluster_loses_logs_after_the_log_disk_fills_on_ACP.md).
