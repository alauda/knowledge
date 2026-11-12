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

# /cpaas/data full with ZooKeeper down or Elasticsearch on the root disk on ACP

## Issue

The log storage on Alauda Container Platform is abnormal because `/cpaas` is full, or Elasticsearch fills a disk it shares with the system. Typical reports:

- Logs cannot be viewed in the ACP console, although `kubectl logs` still shows them; the log storage plugin of the global cluster is abnormal, and `df` shows `/cpaas` at 100% on its storage node.
- The log components are abnormal, and Kafka and ZooKeeper do not start.
- A production pod (for example Redis) cannot be scheduled and the event mentions `disk-pressure`.
- Many pods, including `nevermore`, keep restarting, and `/` is above 85%.
- Local disk on the global masters is high because Elasticsearch and MinIO both store data there.

Logging components on ACP 4.x are in `cpaas-system` (StatefulSet `cpaas-elasticsearch`, DaemonSet `nevermore`). Audit indices or leftover Elasticsearch data filling `/cpaas`, and index deletes that free nothing, are covered in [/cpaas filled by Elasticsearch audit indices or leftover Elasticsearch data on ACP](./cpaas_filled_by_Elasticsearch_audit_indices_or_leftover_Elasticsearch_data_on_ACP.md), together with how to read the Elasticsearch credentials.

## Root Cause

### Cause 1: the log storage plugin is abnormal and /cpaas is at 100%, so the console shows no logs

The console log query reads from the log storage, while `kubectl logs` reads from the kubelet on the node. When `/cpaas` on the log storage node is full, the log storage plugin of the global cluster becomes abnormal and log query returns nothing, while `kubectl logs` keeps working. No ZooKeeper error is needed for this shape. Once the disk is expanded, the logging components return to normal without further action, and the backlog queued while the disk was full is consumed before log query catches up.

### Cause 2: /cpaas/data is 100%, ZooKeeper does not start, and the Elasticsearch API returns 503

The directory used by Elasticsearch is full, the API returns 503, and ZooKeeper, which shares the same filesystem (for example `/cpaas/data`), fails to start. The ZooKeeper side looks like this, for example on a log storage node whose `/cpaas` (`/dev/mapper/cpaas_vg-cpaas_lv`, 500G) has a few hundred KB left:

```text
chmod: changing permissions of '/opt/kafka/libs/...': Read-only file system
bash: /opt/kafka/bin/init.sh: No such file or directory
ERROR Invalid config, exiting abnormally
org.apache.zookeeper.server.quorum.QuorumPeerConfig$ConfigException: Error processing /opt/kafka/config/zoo.cfg
Caused by: java.lang.IllegalArgumentException: serverid null is not a number
ERROR Exiting JVM with code 2
```

Kafka then connects to `cpaas-zookeeper:2181`, loses the channel (`EndOfStreamException: channel for sessionid 0x0 is lost`), and exits with `kafka.zookeeper.ZooKeeperClientTimeoutException: Timed out waiting for connection while in state: CONNECTING`, so Kafka crash-loops behind ZooKeeper. The same full volume can sit behind the local PVs `elasticsearch-log-node-pv-*`, `elasticsearch-log-master-pv-*`, and `zookeeper-pv-*` on several log nodes at once.

A full filesystem by itself returns `No space left on device`. `Read-only file system` can also mean the mount has gone read-only; check `findmnt -o TARGET,OPTIONS -T /cpaas/data`. If it is `ro`, freeing space does not help until the node filesystem is repaired.

ZooKeeper snapshots and transaction logs live inside its data directory (`version-2`); its runtime logs are a separate tree. The data directory, and `myid` in it, are not disposable.

### Cause 3: FailedScheduling lists node.kubernetes.io/disk-pressure because Elasticsearch shares the root disk

`/cpaas` has no disk of its own, so Elasticsearch data fills the root filesystem, and the kubelet taints the node with `node.kubernetes.io/disk-pressure`. The scheduling event lists that taint, often next to a control-plane taint or a volume node-affinity conflict:

```text
FailedScheduling: 0/13 nodes are available: 2 node(s) didn't match Pod's node affinity/selector, 3 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 3 node(s) had untolerated taint {node.kubernetes.io/disk-pressure: }, 5 node(s) had volume node affinity conflict.
```

The same root cause shows up as `nevermore` and other pods restarting while `/` is above 85%.

### Cause 4: the global masters hold both Elasticsearch and MinIO

Both components store data on the local disk of the global masters. There is no procedure to move Elasticsearch onto other global nodes; that relocation is a feature request. What can be done now is index cleanup or a larger disk.

## Resolution

Start with `df` and `du`, so that you do not delete Elasticsearch data to fix a log collector cache, or the reverse:

```bash
df -hT /cpaas /var /var/cpaas
du -x -d 1 -h /cpaas /var/cpaas 2>/dev/null
```

### Cause 1: the log storage plugin is abnormal and /cpaas is at 100%, so the console shows no logs

Expanding the disk is the fix. Deleting historical indices (Cause 1 of the audit-indices article linked in the Issue) is the alternative when expansion is not possible.

1. Find what backs `/cpaas` on the log storage node:

```bash
findmnt -T /cpaas -o TARGET,SOURCE,FSTYPE
lsblk
vgs; lvs
```

> **Warning:** Growing the volume under a mounted `/cpaas` changes the block layer of the live log store; a wrong device or a failed resize can leave the filesystem unmountable. Precondition: `/cpaas` is the full filesystem, it is an LVM logical volume, the virtual disk was already enlarged (or a new disk was added), and the `pvs`/`vgs`/`lvs` output is saved. Rollback: a filesystem grow cannot be undone; restore from backup if the mount fails.

2. Grow the physical volume and the logical volume together with its filesystem:

```bash
pvresize /dev/<disk>
lvextend -r -l +100%FREE /dev/<vg>/<lv>
df -h /cpaas
```

For a new disk, run `vgextend <vg> /dev/<new-disk>` instead of `pvresize`.

3. Watch the logging pods return to Running:

```bash
kubectl -n cpaas-system get pod | grep -Ei 'elastic|kafka|zookeeper|lanaya|nevermore'
```

4. Logs written while the disk was full reach the console only after the queued backlog is consumed. Wait for that before you test log query.

### Cause 2: /cpaas/data is 100%, ZooKeeper does not start, and the Elasticsearch API returns 503

1. Map the full volume to the local PVs it backs before deciding what to clean:

```bash
df -h /cpaas
kubectl get pv | grep -E 'elasticsearch-log|zookeeper'
kubectl -n cpaas-system get pod -o wide | grep -Ei 'zookeeper|zk|kafka'
kubectl -n cpaas-system logs <zookeeper-pod> --tail=50 | grep -E 'serverid|Read-only|Exiting'
```

2. Free space by expanding the disk (as in Cause 1) or by removing Elasticsearch data as described in the audit-indices article, whichever `du` supports. Do not delete the ZooKeeper data directory to make room. Trim old ZooKeeper snapshots only with ZooKeeper's own purge (`zkCleanup.sh` or `autopurge`, which keeps at least the three newest snapshots).
3. After `/cpaas` has free space, recreate the Elasticsearch pods if they are crash-looping on the full disk.

> **Warning:** Deleting the Elasticsearch pod interrupts log search and ingest until it is Ready. Precondition: the disk is no longer 100%. Rollback: none needed; the StatefulSet recreates the pod.

```bash
kubectl -n cpaas-system get pod | grep -Ei 'elastic|zookeeper|kafka'
kubectl -n cpaas-system delete pod cpaas-elasticsearch-0
```

If the API still returns 503 after the disk is free and the pods are Running, contact support for the Elasticsearch cluster recovery procedure. Do not start a full log-cluster rebuild that deletes ZooKeeper data just because ZooKeeper failed on a full disk.

### Cause 3: FailedScheduling lists node.kubernetes.io/disk-pressure because Elasticsearch shares the root disk

1. Confirm that `/cpaas` has no mount of its own:

```bash
findmnt -T /cpaas -o TARGET,SOURCE,FSTYPE
ls /cpaas
du -sh /cpaas/* | grep G
```

The same `SOURCE` as `/` confirms it. `ls /cpaas` on such a node lists `audit`, `data`, `event`, and `log`.

2. If these nodes are not meant to be log storage nodes (they are not monitoring-data storage nodes), uninstall Elasticsearch from them through the plugin path used to install logging, then clear the leftover files once no Elasticsearch process has them open.

> **Warning:** Uninstalling Elasticsearch on these nodes drops the log indices stored there. Precondition: the nodes are not monitoring-data storage nodes, and the log owner accepts the loss. Rollback: reinstall; deleted indices do not return.

```bash
kubectl -n cpaas-system get sts,pod | grep -i elastic
df -hT / /cpaas
kubectl get pod -A -o wide --field-selector spec.nodeName=<node> | grep -v Running
```

3. When Elasticsearch has to stay on these nodes, clean up the log data and mount a separate disk for `/cpaas` (log storage). Before cleaning, find which components produce the log volume (Diagnostic Steps) so the new disk does not fill the same way.

### Cause 4: the global masters hold both Elasticsearch and MinIO

```bash
kubectl get pod -A -o wide | grep -Ei 'elastic|minio'
du -x -d 1 -h /cpaas
```

Clean up indices as described in the audit-indices article, or expand the disk. Moving Elasticsearch to other global nodes has no supported procedure.

## Diagnostic Steps

1. Split `/cpaas` from `/var/cpaas` with `df` and `du`. A full `/var` with a small `/cpaas` is the log collector cache, not an Elasticsearch problem.
2. Console shows no logs, `kubectl logs` works, the global log storage plugin is abnormal, and `/cpaas` is 100% without ZooKeeper errors: Cause 1. Expand first, then wait for the backlog.
3. ZooKeeper `serverid null is not a number` together with `/cpaas` at 100%: Cause 2.
4. `FailedScheduling` with `node.kubernetes.io/disk-pressure` while Elasticsearch shares `/`: Cause 3.
5. Elasticsearch and MinIO together on the global masters: Cause 4.
6. To see which components hold the log volume, list indices by size (credentials as in the audit-indices article):

```bash
ES_HOST=$(kubectl get svc -n cpaas-system cpaas-elasticsearch -o jsonpath='{.spec.clusterIP}')
ES_PORT=$(kubectl get svc -n cpaas-system cpaas-elasticsearch -o jsonpath='{.spec.ports[0].port}')
curl -u "$ES_USER:$ES_PASS" "http://$ES_HOST:$ES_PORT/_cat/indices?v&s=store.size:desc" | head -n 20
```
