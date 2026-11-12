---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "2.6"
  - "3.16"
  - "4.1"
  - "4.2"
  - "4.3"
---

# etcd reports database space exceeded, or compaction frees only tens of megabytes on ACP

## Issue

The cluster reports `etcdserver: no space`, `Error from server : etcdserver: mvcc:database space exceeded`, or `etcdserver: mvcc: database space exceeded`. Pods cannot be created or deleted and stay in `Terminated`; `kubectl` writes fail. The platform raises an etcd db size alarm, or an inspection reports the etcd database over its threshold (for example about 800 MB, 1 GB, 1.4 GB, or 1.5 GB). Sometimes compaction has already been run and the file on disk barely shrinks.

On ACP, etcd runs as static Pods `etcd-<node-name>` in `kube-system` (label `component=etcd`). The manifest is `/etc/kubernetes/manifests/etcd.yaml` and the data directory is `/var/lib/etcd`.

Related articles: "etcd quota stays full from a large live key set, Pod bursts, or a database over 2 GB on ACP" covers a database that stays large after compaction.

## Root Cause

### Cause 1: etcdserver: mvcc: database space exceeded

The database file reached the backend quota and etcd raised the `NOSPACE` alarm. `etcdctl alarm list` shows `NOSPACE`, and in `endpoint status -w table` the ERRORS column reads `memberID:<id> alarm:NOSPACE` on every member, even when only one member's file is large (for example 2.2 GB on a follower and 547 MB on the others). While the alarm is set, etcd rejects writes, so object deletes fail as well as creates.

The repair is `etcdctl compact`, then `defrag` on each member, then `alarm disarm`. Compaction drops historical revisions, defrag returns the freed pages to the filesystem, and disarm clears the alarm once the file is under the quota. After this sequence the members can drop to around 400 MB with an empty ERRORS column.

### Cause 2: Compaction frees only tens of megabytes and snap/db stays about 1.4G

An inspection reports the etcd database usage (`ETCD数据库使用量`) above the warning threshold, a key count does not show one runaway prefix, and compaction frees only about 50 MB. On disk, `member` is about 1.7G, `snap` about 1.4G, `wal` about 367M, and `snap/db` about 1.4G. Endpoint status is healthy, DB SIZE matches that file, and no leader change is in progress.

The inspection series is `cluster.kube.etcd.db.size.mb.per.instance`, query `etcd_mvcc_db_total_size_in_bytes{namespace="kube-system"} / 1024 / 1024`, from inspection item `cluster-etcd-database-usage` (`inspectionitems.ait.alauda.io`). It measures the on-disk MVCC file, including pages that compaction already marked free. Compaction alone does not shrink the file; defrag rewrites `snap/db` without the free pages.

## Resolution

Run the diagnostic commands first and apply only the cause whose signature you confirmed. Define a helper for `etcdctl` inside an etcd Pod (certificate paths as on ACP; check them first with `ls /etc/kubernetes/pki/etcd/ca.crt /etc/kubernetes/pki/etcd/server.crt /etc/kubernetes/pki/etcd/server.key` on a master, and do not use the commands as written if the paths differ):

```bash
etcdctl_on() { kubectl -n kube-system exec "etcd-$1" -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key "${@:2}"; }
```

### Take a snapshot first

Take a snapshot from a healthy member before any compaction or defrag. This is also the command-line form of a manual etcd backup. Find the `hostPath` whose `volumeMounts.mountPath` is `/var/lib/etcd` in `kubectl -n kube-system get pod etcd-<healthy-node> -o yaml`; `snapshot save` writes inside the container, and the file lands on that hostPath on the node. The etcd image usually has no `tar`, so `kubectl cp` cannot copy the file out. Leave enough free space for another full copy of the database.

```bash
etcdctl_on <healthy-node> snapshot save /var/lib/etcd/etcd-before-compact.db
```

On that node, move the file out of the data directory:

> **Warning:** The `rm -f` deletes only `/var/lib/etcd/etcd-before-compact.db` (or the same file name on the hostPath), and only after `ls` shows a non-empty copy under `/var/tmp`. Never delete anything inside `member/`. If the copy is missing, skip the `rm` and copy again.

```bash
sudo cp /var/lib/etcd/etcd-before-compact.db /var/tmp/etcd-before-compact.db
sudo ls -l /var/tmp/etcd-before-compact.db
sudo rm -f /var/lib/etcd/etcd-before-compact.db
```

When the etcd Pod cannot be exec'd, run `etcdctl` on the master itself with `ETCDCTL_API=3`, the member endpoints on port 2379, and the certificates under `/etc/kubernetes/pki/etcd/` (`peer.crt`/`peer.key` or `healthcheck-client.crt`/`healthcheck-client.key`).

### Cause 1: etcdserver: mvcc: database space exceeded

Apply only when `alarm list` prints `NOSPACE` or the member log contains `database space exceeded`, and the snapshot exists.

Read the current revision. The table form does not show it on every `etcdctl` build; the JSON form prints it in the response header:

```bash
etcdctl_on <healthy-node> endpoint status -w table
etcdctl_on <healthy-node> endpoint status --write-out=json | grep -o '"revision":[0-9]*'
```

> **Warning:** `etcdctl compact <revision>` drops every revision older than that number; clients that still hold those resourceVersions get a compaction error. Compaction is cluster-wide and cannot be undone. Run it once, with the current revision, after the snapshot exists. A wrong revision is not a reason to wipe `/var/lib/etcd`.

```bash
etcdctl_on <healthy-node> compact <revision>
```

Defragment one member at a time, the current leader (`IS LEADER` true in `endpoint status`) last, and wait until `endpoint health` of that member is true before the next. On a file of several gigabytes add `--command-timeout=300s`; on a file of about 1 GB, `--command-timeout=120s` is enough. Each member returns `Finished defragmenting etcd member[...]`.

> **Warning:** `defrag` blocks the member while it rewrites `snap/db`; expect an API latency spike and a possible leader change. Maintenance window, snapshot saved, compact already run, one member at a time. If a member does not come back, stop. Defrag has no data undo. A snapshot restore is a rollback only for the whole cluster (every member restored from the same file after quorum is lost); one member cannot be restored from it into a running cluster.

```bash
etcdctl_on <node-name> defrag --command-timeout=300s
```

> **Warning:** `alarm disarm` lifts the read-only `NOSPACE` condition for the whole cluster. Run it only when `endpoint status` DB SIZE is below the quota after compact and defrag; disarming while the file is still over quota lets the alarm return. There is no separate re-arm step.

```bash
etcdctl_on <healthy-node> alarm disarm
etcdctl_on <healthy-node> alarm list
```

`alarm list` should be empty and the console message should clear; writes, including Pod deletes, work again. Run `endpoint status -w table` against all members afterwards. If one member answers `context deadline exceeded`, check that member's health and etcd log before closing.

When compaction cannot bring the file under the default 2 GiB quota because the live key set is large, raise `--quota-backend-bytes` to `8589934592` first (see the related article on the etcd quota), wait for the member to come back, `alarm disarm`, compact to the current revision, then defrag each member with `--command-timeout=300s`.

### Cause 2: Compaction frees only tens of megabytes and snap/db stays about 1.4G

An inspection that flags the size while DB SIZE is only slightly above 500 MB needs no immediate action: keep monitoring and compact once the database approaches 1 GB. An inspection that reports the threshold reached is answered with the snapshot and compaction steps of Cause 1, without `alarm disarm` unless `NOSPACE` is set.

When compaction has already run, DB SIZE dropped by only tens of megabytes, `snap/db` is still about 1.4G, and `endpoint status` shows no alarm and a stable leader, defrag each member, leader last. The default 5-second `etcdctl` client timeout can expire before defrag returns on a 1 GB file, so add `--command-timeout=120s` (a client wait, not an etcd setting). Changing `quota-backend-bytes` is not needed for this signature.

> **Warning:** `defrag` rewrites this member's `snap/db` and can move the leader. Maintenance window, snapshot saved, one member at a time, and only for the "compaction freed tens of MB, file still about 1.4G" signature. If the member does not return, stop; the snapshot is for a whole-cluster restore only.

```bash
etcdctl_on <node-name> defrag --command-timeout=120s
```

## Diagnostic Steps

```bash
kubectl -n kube-system get pods -l component=etcd -o wide
etcdctl_on <healthy-node> endpoint status -w table
etcdctl_on <healthy-node> alarm list
```

- `NOSPACE` in `alarm list`, or `alarm:NOSPACE` in the ERRORS column: Cause 1.
- A healthy endpoint whose DB SIZE barely moved after compact: Cause 2.
- A large live key count, usually `replicasets`, Pod create/delete bursts, or every member above 2 GB with kube-apiserver restarting on `leader changed`: see the related etcd quota article.

Count keys by prefix to see whether one resource type dominates:

```bash
etcdctl_on <healthy-node> get / --prefix --keys-only \
  | awk -F '/' '{ h[$3]++ } END {for (k in h) print h[k], k}' | sort -nr | head -30
```

On the node, `du -sh /var/lib/etcd/member /var/lib/etcd/member/snap /var/lib/etcd/member/wal /var/lib/etcd/member/snap/db` separates a large WAL from a large `snap/db`.

The inspection item behind the MB threshold:

```bash
kubectl get inspectionitems.ait.alauda.io -A | grep etcd
kubectl get inspectionitems.ait.alauda.io cluster-etcd-database-usage -o yaml | grep indicator
```

etcd backup files that fill `/` do not move `etcd_mvcc_db_total_size_in_bytes`; that is a disk-space problem, not this metric.
