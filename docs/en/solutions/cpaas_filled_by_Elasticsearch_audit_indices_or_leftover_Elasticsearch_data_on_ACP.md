---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# /cpaas filled by Elasticsearch audit indices or leftover Elasticsearch data on ACP

## Issue

A node alarm on Alauda Container Platform names `/cpaas`, or `df` shows `/cpaas` near or at 100%, and the bytes are Elasticsearch data. Typical reports:

- Node disk usage is above 85%, and the question is which data it is.
- Application-log retention in the log center was shortened, and the disk did not shrink.
- Elasticsearch log search fails, `curl` against the Elasticsearch API returns 503, or a delete of old indices returns success and the disk does not move.
- `/cpaas/data/elasticsearch` is very large although the cluster now uses an external Elasticsearch.

Do not treat every directory under `/cpaas` as disposable log cache: ZooKeeper data can live on the same filesystem. When `/cpaas/data` is full and ZooKeeper does not start, when the console shows no logs while `kubectl logs` works, or when Elasticsearch shares the root disk, see [/cpaas/data full with ZooKeeper down or Elasticsearch on the root disk on ACP](./cpaas_data_full_with_ZooKeeper_down_or_Elasticsearch_on_the_root_disk_on_ACP.md).

Logging components on ACP 4.x are in `cpaas-system`: StatefulSet `cpaas-elasticsearch` and DaemonSet `nevermore`. On older versions the log workloads can be Deployments; check with `kubectl -n cpaas-system get deploy,sts | grep elastic` and use `deploy/` in the scale commands below if that is what the output shows. From inside the Elasticsearch pod the API is `http://cpaas-elasticsearch:9200`; a port-forward to `127.0.0.1:9200` is refused even when Elasticsearch is healthy. Basic-auth credentials are in Secret `elasticsearch-basic-auth` in `cpaas-system`; if that Secret does not exist, read the credentials the pod actually mounts (for example keys `ES_USER` and `ES_PASSWORD` of Secret `acp-config-secret`).

## Root Cause

### Cause 1: audit indices fill /cpaas after only application-log retention was shortened

`_cat/indices` shows that the large indices are audit logs. Audit retention is a separate setting from application-log retention, and indices already written are not removed the moment a setting changes. Deleting those indices frees the space.

If the audit growth started after an upgrade and the audit documents are dominated by Kube-OVN node `setCondition` updates, the source is an audit flood that is fixed in ACP 4.2.5; the retention and delete steps here are the relief until that upgrade. Workload indices are named like `log-workload-YYYYMMDD` on the 4.x stack, so use the size list rather than assuming a prefix.

### Cause 2: deleting historical indices has no effect because the Elasticsearch data node already failed

`/cpaas` on an Elasticsearch data node is full and the cluster is already in a failed state, so the index API is not a usable cleanup tool. Elasticsearch also sets `index.blocks.read_only_allow_delete` on indices when a node crosses the flood-stage disk watermark (95% by default). That block stops writes but still allows deletes; a delete that frees nothing here is the failed cluster, not the block. The block has to be cleared after the disk has free space so that ingest resumes.

There are two recoveries: expand the disk, wait until health is not red, clear the block, and delete indices; or stop Elasticsearch and delete its data directories on all Elasticsearch data nodes, which drops every indexed log on those nodes. The second path also restores the platform when `/cpaas` doubles as the registry storage path on a global master and a package push fails because the disk is full of Elasticsearch data (with the API returning `master_not_discovered_exception` and status 503). The ZooKeeper data directory is never part of this cleanup.

### Cause 3: leftover Elasticsearch data that the running process does not use

`du` under `/cpaas` finds a large Elasticsearch tree that no running Elasticsearch process uses, for example data left after a move or an upgrade. Removing the leftover tree frees the space while the running Elasticsearch stays healthy. This is different from deleting the live data directory in Cause 2.

After a switch to an external Elasticsearch, `/cpaas/data/elasticsearch` on a global node can still hold the old indices. For example, `du -sh *` shows `nodes` at 114G; under `nodes/0`, `indices` is 114G, `node.lock` 0, and `_state` 64K, and all index directories are dated long before the switch.

## Resolution

Start with `df` and `du`, so that you do not delete Elasticsearch data to fix a log collector cache, or the reverse:

```bash
df -hT /cpaas /var /var/cpaas
du -x -d 1 -h /cpaas /var/cpaas 2>/dev/null
```

A full `/var` with a small `/cpaas` is the log collector cache (`/var/cpaas`, `diskqueue` `seg` files), not an Elasticsearch index problem.

### Cause 1: audit indices fill /cpaas after only application-log retention was shortened

1. Shorten the audit retention in the log center. Changing only the application-log retention leaves these indices.
2. List indices by size. The commands put the password on the command line of the admin host; do not share the shell transcript.

```bash
ES_USER=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth \
  -o jsonpath='{.data.username}' | base64 -d)
ES_PASS=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth \
  -o jsonpath='{.data.password}' | base64 -d)
kubectl -n cpaas-system exec cpaas-elasticsearch-0 -c cpaas-elasticsearch -- \
  curl -sS -u "${ES_USER}:${ES_PASS}" \
  'http://cpaas-elasticsearch:9200/_cat/indices?v&h=index,docs.count,store.size&s=store.size:desc'
```

> **Warning:** `DELETE /<index-name>` removes that index and its documents permanently. Precondition: `_cat/indices` shows the name is an expired audit or log index, the cluster health API answers, and audit retention has been shortened. Rollback: none without a snapshot stored outside this disk. Do not use a wildcard delete.

3. Delete the expired indices one by one:

```bash
kubectl -n cpaas-system exec cpaas-elasticsearch-0 -c cpaas-elasticsearch -- \
  curl -sS -u "${ES_USER}:${ES_PASS}" -X DELETE \
  "http://cpaas-elasticsearch:9200/<index-name>"
```

4. Watch `df -h /cpaas` after each batch. Each node removes the shard files after it applies the delete, so usage can lag the HTTP 200 briefly.

### Cause 2: deleting historical indices has no effect because the Elasticsearch data node already failed

Prefer expansion:

1. Grow the disk or filesystem that holds `/cpaas`.
2. Wait until the Elasticsearch pods are Ready and `_cluster/health` is not red.
3. Clear the read-only block, then delete indices as in Cause 1.

> **Warning:** Clearing `index.blocks.read_only_allow_delete` lets Elasticsearch write again; if the disk is still above the flood-stage watermark, the block returns, and writes can fill the last free blocks. Precondition: `df` shows free space on the data node. Rollback: Elasticsearch re-applies the block if the watermark is still crossed; you can also set it back to `true`.

```bash
kubectl -n cpaas-system exec cpaas-elasticsearch-0 -c cpaas-elasticsearch -- \
  curl -sS -u "${ES_USER}:${ES_PASS}" -X PUT \
  -H 'Content-Type: application/json' \
  'http://cpaas-elasticsearch:9200/_all/_settings' \
  -d '{"index.blocks.read_only_allow_delete": null}'
```

If the disk cannot be expanded and the API is dead, stop Elasticsearch and remove its data directories on every Elasticsearch data node. That is a full log-history wipe.

> **Warning:** Stopping `cpaas-elasticsearch` and deleting its data directories destroys every log index on those nodes. Precondition: expansion is impossible, index deletes already failed, the Elasticsearch data directory was identified from the pod volume mounts, it is not the ZooKeeper data directory, and the loss of log history is accepted. Rollback: none without an external snapshot.

```bash
kubectl -n cpaas-system get sts,pod | grep -i elastic
kubectl -n cpaas-system scale sts/cpaas-elasticsearch --replicas=0
```

If a `cpaas-elasticsearch-master` StatefulSet exists and its pods mount the directory you are about to delete, scale it to 0 as well, or it can recreate files while you delete them. If it does not exist, the data nodes are all the Elasticsearch nodes. Then, on each data node, after the pods are gone and `lsof` shows no Elasticsearch process in the directory:

```bash
lsof +D <es-data-dir> | head
rm -rf <es-data-dir>
```

Scale the StatefulSets back to their previous replica counts. If the pods do not form a cluster afterwards, contact support for the Elasticsearch cluster recovery procedure rather than deleting more directories.

### Cause 3: leftover Elasticsearch data that the running process does not use

1. Compare the `du` output with the live pod mounts. Only a directory that no Elasticsearch process has open is leftover:

```bash
kubectl -n cpaas-system get pod -o name | grep -i elastic
kubectl -n cpaas-system get pod cpaas-elasticsearch-0 \
  -o jsonpath='{range .spec.containers[*].volumeMounts[*]}{.name}{" "}{.mountPath}{"\n"}{end}'
lsof +D <suspected-old-dir> | head
```

> **Warning:** Removing a live Elasticsearch path corrupts the cluster. Precondition: `lsof` shows no Elasticsearch process in the directory, and the live mount path is a different directory. Rollback: none after deletion; move the tree aside first and delete the copy only after Elasticsearch has stayed healthy across new writes.

```bash
mv <suspected-old-dir> <suspected-old-dir>.aside
```

2. For the leftover after a switch to external Elasticsearch, inspect the tree under `/cpaas/data/elasticsearch`:

```bash
cd /cpaas/data/elasticsearch && du -sh *
du -sh nodes/0/*
ls -l --time-style=+%Y-%m-%d nodes/0/indices | head
kubectl get pod -A -o wide | grep -i elastic
lsof +D /cpaas/data/elasticsearch/nodes/0 | head
```

3. If the history must be kept, copy `nodes/0/indices` to another host or disk first.

> **Warning:** Deleting the contents of `nodes/0/indices` removes the old local indices permanently. Precondition: platform logs go to the external Elasticsearch, no Elasticsearch pod runs on this node and `lsof` prints nothing for the path, the index directories predate the switch, and a backup exists if the history may be needed. Rollback: restore from that backup.

```bash
rm -rf /cpaas/data/elasticsearch/nodes/0/indices/*
df -h /cpaas
```

## Diagnostic Steps

1. Split `/cpaas` from `/var/cpaas` with `df` and `du` as at the start of the Resolution.
2. If the large tree is Elasticsearch data, check health first (set `ES_USER` and `ES_PASS` as in Cause 1):

```bash
kubectl -n cpaas-system get pod,sts | grep -Ei 'elastic|nevermore|zookeeper'
kubectl -n cpaas-system exec cpaas-elasticsearch-0 -c cpaas-elasticsearch -- \
  curl -sS -u "${ES_USER}:${ES_PASS}" 'http://cpaas-elasticsearch:9200/_cluster/health?pretty'
```

3. Health green and the large indices are audit: Cause 1. Health red, 503, or a delete that frees nothing: Cause 2. A large Elasticsearch directory that `lsof` shows no process using: Cause 3.
4. To see which components produce the log volume, list indices by size from a master node through the Service address:

```bash
ES_HOST=$(kubectl get svc -n cpaas-system cpaas-elasticsearch -o jsonpath='{.spec.clusterIP}')
ES_PORT=$(kubectl get svc -n cpaas-system cpaas-elasticsearch -o jsonpath='{.spec.ports[0].port}')
curl -u "$ES_USER:$ES_PASS" "http://$ES_HOST:$ES_PORT/_cat/indices?v&s=store.size:desc" | head -n 20
```

Indices are daily, for example `log-platform-<YYYYMMDD>` or `audit-<YYYYMMDD>`. Within a `log-platform` index, the largest producers are typically platform pods such as `lanaya`, `cpaas-monitor-prometheus-adapter`, `vmselect-cluster-0`, and `speaker`.
