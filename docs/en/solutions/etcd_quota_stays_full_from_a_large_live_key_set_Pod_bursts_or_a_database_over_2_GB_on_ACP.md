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

# etcd quota stays full from a large live key set, Pod bursts, or a database over 2 GB on ACP

## Issue

- etcd DB SIZE stays above about 1 GB after compaction, close to the default 2 GiB quota, and the key count is large (for example tens of thousands of ReplicaSets).
- A workload creates and deletes many Pods in bursts; during a load test etcd returns `Error from server : etcdserver: mvcc:database space exceeded` after about 1,000 Pods, every Pod create and delete fails, and deleted Pods stay in `Terminated`.
- kube-apiserver (for example on a standby `global` cluster) restarts again and again, its log shows `etcdserver: leader changed`, and every member's database is over 2 GB.

On ACP, etcd runs as static Pods `etcd-<node-name>` in `kube-system` (label `component=etcd`). The manifest is `/etc/kubernetes/manifests/etcd.yaml` and the data directory is `/var/lib/etcd`.

Related articles: "etcd reports database space exceeded, or compaction frees only tens of megabytes on ACP" covers the snapshot, compaction, defrag, and `alarm disarm` steps used below.

## Root Cause

### Cause 1: DB SIZE stays above 1 GB after compaction because the live key set is large

`endpoint status` shows DB SIZE around 1.9 GB on every member, and a prefix count shows a large live set (for example 52126 replicasets, 14579 services, 12352 secrets, 9761 pods, 7522 configmaps, 7262 deployments). Compaction drops the file to about 1.2 GB, which is still a capacity risk next to the default 2 GiB quota. A ten-minute watch shows `/registry/minions/` and `/registry/leases/` as the most frequently changing keys, so no single client loop is the source.

ReplicaSets often dominate: about 5000 Deployments with 5 to 10 kept revisions each produce tens of thousands of ReplicaSets, because old ReplicaSets are kept up to the Deployment's `spec.revisionHistoryLimit` (Kubernetes default 10). Other large prefixes can be `rolebindings`, `aquasecurity.github.io` objects, `cert-manager.io`, and `events`.

kube-apiserver compacts etcd about every 5 minutes. If kube-apiserver has been restarting continuously, that compaction does not run and revisions accumulate.

Once compaction has done what it can, raise `quota-backend-bytes` to 8 GiB (`8589934592`) and keep that value permanently.

### Cause 2: Pod create and delete bursts fill the quota

A workload starts many Pods per task and deletes them when the task ends. On a v3.16.2 cluster (etcd 3.5.15), `endpoint status` can show DB SIZE 4.6 GB and `du -sh /var/lib/etcd/` 4.8G while a key count under `/registry` finds only about 2700 keys in total. A file that large over so few live keys is revision history from the Pod churn, not live data. The temporary relief is `--auto-compaction-retention=2h` together with `--quota-backend-bytes=8589934592`, followed by compaction and defrag; restore the previous parameters afterwards.

### Cause 3: kube-apiserver restarts on etcdserver: leader changed while every member's database is over 2 GB

kube-apiserver restarts frequently and its log before each restart shows etcd leader changes. The etcd log repeats `"msg":"apply request took too long"` with `"expected-duration":"100ms"`; read-only range requests on `/registry/events/` (`limit:500`) take 100 to 236 ms, some requests take 1 to 3 seconds (`"took":"3.427755923s"`) and end with `"error":"etcdserver: leader changed"`, and `/readyz` fails with `[-]linearizable_read failed: etcdserver: leader changed` and `"status-code":503`. The three members' databases are 2.3G, 2.4G, and 2.5G. After an etcd compaction, kube-apiserver stops restarting.

## Resolution

Run the diagnostic commands first and apply only the cause whose signature you confirmed. Take a snapshot from a healthy member before any change, as described in the related article. The helper below runs `etcdctl` inside an etcd Pod with the ACP certificate paths:

```bash
etcdctl_on() { kubectl -n kube-system exec "etcd-$1" -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key "${@:2}"; }
etcdctl_on <healthy-node> snapshot save /var/lib/etcd/etcd-before-change.db
```

Copy the snapshot from `/var/lib/etcd` on that node to `/var/tmp` before you continue.

### Cause 1: DB SIZE stays above 1 GB after compaction because the live key set is large

Compact first (compact to the current revision, then defrag each member, leader last; no `alarm disarm` unless `NOSPACE` is set). Confirm kube-apiserver is not crash-looping, otherwise the periodic compaction stalls again:

```bash
kubectl -n kube-system get pods -l component=kube-apiserver -o wide
```

Then raise the quota only when DB SIZE is still above about 1 GB after a successful compaction, the prefix count shows a large live set, and the filesystem that holds `/var/lib/etcd` has room for an 8 GiB file. Set it where etcd's arguments come from on this cluster.

When the control plane is generated from a `kubeadmConfigSpec`, set the value there, as a quoted string:

```yaml
kubeadmConfigSpec:
  clusterConfiguration:
    etcd:
      local:
        extraArgs:
          quota-backend-bytes: "8589934592"
```

When kubelet runs etcd from `/etc/kubernetes/manifests/etcd.yaml`, add the flag next to the other etcd arguments on each master, one master at a time. If both the manifest and `kubeadmConfigSpec` exist, set the same value in both so they do not disagree.

```yaml
# in the etcd container command list of /etc/kubernetes/manifests/etcd.yaml
- --quota-backend-bytes=8589934592
```

> **Warning:** Raising the quota does not shrink etcd; it lets the member grow up to 8 GiB. Saving `etcd.yaml`, or applying the kubeadm extra argument, restarts that etcd member. One master at a time, after compaction, in a maintenance window, and only with free space for an 8 GiB `snap/db`. Rollback: set the previous value again only after DB SIZE is under that value. Without the flag, etcd uses 2147483648 (2 GiB); putting that back while the file is larger turns `NOSPACE` on again.

After the Pod is recreated, its arguments must contain `--quota-backend-bytes=8589934592`:

```bash
kubectl -n kube-system get pod etcd-<node-name> -o yaml | grep quota-backend-bytes
```

To reduce the number of ReplicaSets, lower `spec.revisionHistoryLimit` on Deployments that do not need many rollback revisions.

### Cause 2: Pod create and delete bursts fill the quota

Raise the quota as in Cause 1 so that writes can resume, and add `--auto-compaction-retention=2h` temporarily.

> **Warning:** Saving `etcd.yaml` restarts this member. One master at a time, after a snapshot, and only while `mvcc: database space exceeded` is confirmed and Pod churn is the source. A `2h` retention discards revisions faster than before, so clients with old resourceVersions see compaction errors sooner. Rollback: remove `--auto-compaction-retention=2h` once DB SIZE is back under the quota you will keep, and save again.

```yaml
# temporary, next to the other etcd arguments in /etc/kubernetes/manifests/etcd.yaml
- --auto-compaction-retention=2h
- --quota-backend-bytes=8589934592
```

When the file is under the new quota, run `alarm disarm`, then compact and defrag each member. Restore the previous parameters when DB SIZE allows the previous quota.

### Cause 3: kube-apiserver restarts on etcdserver: leader changed while every member's database is over 2 GB

Apply only when `endpoint status` shows every member above about 2 GB, kube-apiserver's pre-restart log shows `etcdserver: leader changed`, and the etcd log has `apply request took too long` on large range reads:

```bash
kubectl -n kube-system logs etcd-<node-name> --tail=500 | grep -E 'changed leader|leader changed|linearizable_read' || true
```

Take the snapshot, compact to the current revision (no `alarm disarm` unless `NOSPACE` is set), and defrag each member, leader last. kube-apiserver stops restarting after the compaction. Leader changes while the database is small are not fixed by compaction; check etcd disk latency and packet loss between the masters instead.

## Diagnostic Steps

```bash
kubectl -n kube-system get pods -l component=etcd -o wide
etcdctl_on <healthy-node> endpoint status -w table
etcdctl_on <healthy-node> alarm list
```

- A large live prefix count, usually `replicasets`: Cause 1.
- A load test that creates and deletes Pods until `database space exceeded`, with a multi-gigabyte file over a few thousand keys: Cause 2.
- Every member above 2 GB while kube-apiserver restarts on `leader changed`: Cause 3.
- `NOSPACE` without one of these patterns, or a DB SIZE that barely moved after compaction: see the related article.

Count keys by prefix:

```bash
etcdctl_on <healthy-node> get / --prefix --keys-only \
  | awk -F '/' '{ h[$3]++ } END {for (k in h) print h[k], k}' | sort -nr | head -30
```

Watch which keys change for ten minutes, to rule out a single client writing in a loop:

```bash
kubectl -n kube-system exec etcd-<healthy-node> -- sh -c \
  'export ETCDCTL_API=3; timeout 600 etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
    --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
    watch --prefix / -w fields' > /tmp/etcd-watch.txt
grep -w Key /tmp/etcd-watch.txt | awk '{print $NF}' | tr -d '"' | sort | uniq -c | sort -nr | head -20
```

Lease and node-status keys at the top (for example about 300 changes per lease and 120 per `/registry/minions/<node>` in ten minutes) are normal heartbeat traffic.
