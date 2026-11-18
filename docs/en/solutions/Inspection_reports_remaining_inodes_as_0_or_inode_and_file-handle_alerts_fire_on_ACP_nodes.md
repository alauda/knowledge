---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Inspection reports remaining inodes as 0, or inode and file-handle alerts fire on ACP nodes

## Issue

On Alauda Container Platform one of the following is reported for some or all nodes of a cluster:

- The platform inspection reports that the remaining inode count on the node is 0 (`节点内剩余inode数为0`, "the remaining inode count on the node is 0"), although the root filesystem still has inodes.
- An inode usage alert fires on some nodes.
- A file-handle usage alert fires, but the node looks fine.

Only one of the three shapes below is a node that really cannot create files. `df -h` free bytes say nothing about inodes; compare `df -i` per mount with the number the alert or the inspection shows before cleaning anything.

## Root Cause

### Cause 1: df -i IUse% near 100% on the root or /var filesystem

`df -h` still has free bytes, `df -i` on `/` or `/var` shows almost no free inodes, and the node condition mentions `nodefs.inodesFree` or `imagefs.inodesFree`. This is real inode exhaustion, caused by many tiny files, often under `/var/log`, a container log directory, or an overlay upper directory. When the kubelet `inodesFree` eviction threshold is crossed, the node also reports `DiskPressure=True`.

### Cause 2: inspection remaining inode is 0, while df -i on / still has free inodes

`df -i /boot/efi` is the exhausted number; `df -i /` and `df -i /var` are not. The inspection indicator `node.disk.inode.free`, defined in ConfigMap `indicators-standard-node` in `cpaas-system`, reads `node_filesystem_files_free` with `device!~"rootfs|tmpfs"` and no mount-point filter. The `/boot/efi` partition is typically vfat and reports no inode pool, so its 0 becomes the node's value. The alert is a false positive: `/boot/efi` is normally unused, the node can still create files, and scheduling is not affected.

### Cause 3: inode or file-handle alert fires, but the node still has plenty of both

`df -i` on the alarmed mount and `/proc/sys/fs/file-nr` show ample headroom, and kubelet reports no pressure condition. The inode and file-handle thresholds of the monitoring rules are low for that environment. No remediation is required on the nodes.

## Resolution

### Cause 1: df -i IUse% near 100% on the root or /var filesystem

1. Find the directory with the most files. `du -x` stays on one filesystem; a `find` loop over `/*` also walks `/proc` and floods the output with errors such as `Too many levels of symbolic links`.

```bash
df -i <mount>
du -x --inodes -d 1 <mount> | sort -n | tail
```

Repeat `du` on the largest directory until you reach the one where small files accumulate.

2. Remove files you are allowed to lose (rotated logs, expired cache). Do not delete `/boot/efi` to fix an inode alarm.

> **Warning:** Deleting a large set of small files is irreversible. Precondition: the directory is not a live etcd, Elasticsearch, or containerd data directory, and you have listed a sample of the names. Rollback: none.

```bash
find <dir> -xdev -type f -name '<pattern>' -print | head
find <dir> -xdev -type f -name '<pattern>' -delete
df -i <mount>
```

Truncating a file frees bytes but not its inode, and a deleted file that a process still holds open keeps its inode until it is closed. When `df -i` is the number at 100%, the count drops only after closed files are removed. For container logs under `/var/log/pods`, let the runtime rotate them instead of removing directories it still has open.

### Cause 2: inspection remaining inode is 0, while df -i on / still has free inodes

1. Confirm the false positive. If `/` or `/var` is actually out of inodes, use Cause 1 instead.

```bash
df -i / /var /boot/efi
```

2. On a control-plane node of the affected cluster, look at the indicator:

```bash
kubectl -n cpaas-system get configmap indicators-standard-node -o yaml | grep -n -A3 'node.disk.inode.free'
```

If the indicator is not there, find the ConfigMap that holds the inode query (a search for `boot/efi` alone can miss it, because the query has no mount-point filter):

```bash
kubectl get configmap -A -o json \
  | jq -r '.items[] | select((.data // {}) | tostring | test("node.disk.inode.free|node_filesystem_files_free")) | "\(.metadata.namespace)/\(.metadata.name)"'
```

3. Exclude `/boot/efi` from the query.

> **Warning:** A bad edit can hide real filesystem alerts, not only `/boot/efi`. Precondition: `df -i /` shows free inodes, and the ConfigMap is saved. Rollback: `kubectl apply -f /tmp/indicators-standard-node.before.yaml`. Do not disable the whole inode item; that also hides a real `nodefs.inodesFree` problem.

```bash
kubectl -n cpaas-system get configmap indicators-standard-node -o yaml > /tmp/indicators-standard-node.before.yaml
kubectl -n cpaas-system edit configmap indicators-standard-node
```

Search for `node.disk.inode.free` and change its `query` value from:

```text
node_filesystem_files_free{node_name=~\"{{.name}}\",device!~\"rootfs|tmpfs\"}
```

to:

```text
node_filesystem_files_free{node_name=~\"{{.name}}\",device!~\"rootfs|tmpfs\",mountpoint!~\"/boot/efi\"}
```

Keep the escaped quotes as they are inside the ConfigMap. If the query on your cluster has a positive mount-point list (`mountpoint=~...`) that contains `/boot/efi`, remove `/boot/efi` from that list instead. Make the change on every cluster that reports the row.

4. Collection refreshes about every 15 minutes. To apply it sooner, restart `courier` in `cpaas-system`, then re-run the inspection and confirm the row is gone.

> **Warning:** Restarting `courier` drops inspection and cluster-list calls until the new pod is Ready. Precondition: the ConfigMap edit is saved. Rollback: none needed; the controller recreates the pod.

```bash
kubectl -n cpaas-system get deploy,pod | grep courier
kubectl -n cpaas-system rollout restart deploy/courier
```

If `courier` is not a Deployment, delete the pod that `kubectl -n cpaas-system get pod | grep courier` prints, so that its controller recreates it.

`indicators-standard-node` is a platform object. Re-check the query after a platform upgrade, and include the change in your pre-upgrade review of platform customizations.

### Cause 3: inode or file-handle alert fires, but the node still has plenty of both

Confirm the headroom before you treat the alert as noise:

```bash
df -i <alarmed-mount>
cat /proc/sys/fs/file-nr
cat /proc/sys/fs/file-max
```

`file-nr` prints allocated handles, unused handles, and the maximum. If the allocated number is far below the maximum and `IUse%` is far below 100%, the alert threshold, not the node, is the issue, and no handling is required. If the alert is too noisy for the environment, review the threshold of that alert rule. When `IUse%` really is high, use Cause 1.

## Diagnostic Steps

1. Print inode usage for every mount the alert could mean, including `/boot/efi`:

```bash
df -i / /var /var/lib /cpaas /boot/efi
kubectl describe node <node> | grep -E 'DiskPressure|inodesFree'
```

2. Classify:

- `/` or `/var` with no free inodes, possibly `DiskPressure`: Cause 1. Rank directories with `du -x --inodes -d 1`.
- Only `/boot/efi` shows 0 free inodes, and the inspection reports remaining inodes as 0: Cause 2.
- An inode or file-handle alert while `df -i` and `/proc/sys/fs/file-nr` show plenty of headroom and the node has no pressure condition: Cause 3.

A node that is `DiskPressure` because bytes, not inodes, ran out is a different problem; use `df -h` and `du -x -d 1` to find the directory that filled the mount.
