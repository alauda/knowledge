---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.16"
  - "4.0"
  - "4.1"
  - "4.2"
---

# etcd backup dates missing in the console, backup tab gone, duplicate copies, or retention to change on ACP

## Issue

- The etcd backup task looks like it skipped dates: every control-plane node has a schedule such as `0 18 * * *`, and some dates are absent from the console.
- The Administrator cluster-management page has no backup-management tab, so the backup policy and a restore cannot be started from that screen.
- Every day a new backup is written to `/cpaas-backup`, and it is not clear how long snapshots are kept or how to shorten the retention. A directory `backup_<digits>` sits next to `cpaas-backup` on `/`.
- The backup retention on a standby global cluster has to change without switching the platform domain to it.
- Each etcd backup run writes two copies.

Related articles: "No default etcd backup on ACP: Cluster Enhancer not installed or etcd-backup-default not created"; "Scheduled etcd backups stop after an upgrade because the etcd-backup-default AdvancedCronJob stops triggering on ACP".

## Root Cause

### Cause 1: repeated label updates on one EtcdBackupRecord collapse the console list, the files are on disk

The scheduled backups run (the `etcd-backup-default` job logs show the execution), and the `snapshot-etcd-*.db` files for the missing dates exist in the backup directory (for example `/mnt/cpaas-backup/` or `/cpaas/backup`). The `EtcdBackupRecord` objects and the audit log show the same resource being label-updated repeatedly, so the console lists one record of that name. The snapshots are not missing, and no backup has to be regenerated.

### Cause 2: on 4.1 the backup-management tab was removed, the backup configuration still exists

On 4.1 the backup-management page of cluster management has been removed. The backup itself keeps running: `cluster-enhancer-apiserver` Pods are `1/1 Running`, and the `EtcdBackupConfiguration` `etcd-backup-default` exists, is not paused, and keeps creating records. Records are viewed from the etcd backup monitoring dashboard (Operations Center → Monitoring → Dashboards → Switch → Cluster → etcd backup), and policy changes are made on the `EtcdBackupConfiguration` object. A restore screen has never been provided in the console; restoring etcd is not started from the UI.

### Cause 3: retention is spec.localStorage.ttl, and backup_<digits> is an upgrade copy

Daily backups to `/cpaas-backup` are the normal behavior. Snapshot retention is `spec.localStorage.ttl` on the `EtcdBackupConfiguration` named `etcd-backup-default` (`apiVersion: enhancement.cluster.alauda.io/v1`), in seconds, for example `ttl: "7776000"` (90 days) with `localStorage.path: /cpaas-backup` and `schedule: 0 0 * * *`. The same object also carries the annotations `life` and `path`; retention is changed through `spec.localStorage.ttl`, not through the `life` annotation. The change applies without a component restart, but snapshots already past the new retention are removed on the next scheduled backup, not at the moment of the edit. In the console, the object is found under Resource Management; searching Custom Resource Definitions for `EtcdBackupConfiguration` returns nothing.

`cpaas-backup` on `/` is the etcd backup data directory and has to be kept. `backup_<digits>` (for example `backup_` plus a date stamp) is written by a platform upgrade and exists only on clusters that were upgraded. It holds an `etcd` and a `kubernetes` subdirectory (with `admin.conf`, `kubeadm-config.yaml`, `encryption-provider.conf`, `kubelet.conf`, and the `manifests`, `pki`, `audit`, and `patches` directories). That upgrade copy can be deleted.

### Cause 4: on a standby global cluster, retention is the LIFE variable of the etcd backup CronJob

When the platform domain is not switched to the standby global cluster, its console backup page is not the path. The retention period there is the `LIFE` environment variable, in seconds, of the etcd backup CronJob (for example container `etcd-backup` running `/backup-local.sh` with `NAME=etcd-backup-default` and `LIFE="1296000"`, 15 days).

### Cause 5: on 4.2.4 the etcd-backup-upgrade-k8s bcj writes a second copy

Each run produces two copies because a `bcj` named `etcd-backup-upgrade-k8s` sits beside the regular backup configuration and fires too. Removing that bcj's annotations, labels, and owner references stops the second copy. Why both objects fire is not established, so treat this as a workaround.

## Resolution

### Cause 1: repeated label updates on one EtcdBackupRecord collapse the console list, the files are on disk

Look on the control-plane nodes before scheduling another backup:

```bash
kubectl get cronjob -A | grep etcd-backup
kubectl get etcdbackuprecord -A
kubectl get etcdbackupconfiguration -A -o yaml | grep -A3 localStorage
sudo ls -l /mnt/cpaas-backup/snapshot-etcd-*.db /cpaas/backup/snapshot-etcd-*.db /cpaas-backup/snapshot-etcd-*.db 2>/dev/null
```

Check the path printed on the configuration object as well. If the dated `snapshot-etcd-*.db` files exist, the single console row is a display effect of repeated label updates on one `EtcdBackupRecord`. Leave the files. If no file exists on any path, this cause does not apply.

### Cause 2: on 4.1 the backup-management tab was removed, the backup configuration still exists

1. Confirm that the backup is still in place:

   ```bash
   kubectl get pods -A | grep cluster-enhancer-apiserver
   kubectl get etcdbackupconfiguration -A -o yaml
   ```

2. Read records from the etcd backup monitoring dashboard.
3. To change the policy, save the object, edit the saved copy, and apply it.

   > **Warning:** Applying a changed `EtcdBackupConfiguration` changes the schedule, path, or retention of the platform etcd backup; a bad path or a much smaller `ttl` can remove snapshots you still need on the next run. Precondition: only when you intend that policy change, and only after the backup copy exists. Rollback: apply the saved copy again before the next scheduled run.

   ```bash
   kubectl get etcdbackupconfiguration -A -o yaml > /tmp/etcd-backup-default.yaml
   cp /tmp/etcd-backup-default.yaml /tmp/etcd-backup-default.new.yaml
   vi /tmp/etcd-backup-default.new.yaml
   kubectl apply -f /tmp/etcd-backup-default.new.yaml
   ```

### Cause 3: retention is spec.localStorage.ttl, and backup_<digits> is an upgrade copy

1. Read the current retention, path, and schedule. An empty NAMESPACE column means the object is cluster-scoped; drop `-n` then:

   ```bash
   kubectl get etcdbackupconfiguration -A
   kubectl get etcdbackupconfiguration etcd-backup-default -n <namespace> -o yaml > /tmp/etcd-backup-default.yaml
   grep -n -A3 'localStorage' /tmp/etcd-backup-default.yaml
   ```

2. Set the retention you want, in seconds, as a quoted string like the existing value (`604800` is 7 days, `2592000` is 30 days).

   > **Warning:** Lowering `ttl` makes the next scheduled backup delete every snapshot older than the new value. Precondition: only when that retention is intended, after saving the object. Rollback: `kubectl apply -f /tmp/etcd-backup-default.yaml` before the next scheduled run; snapshots already removed by a run do not come back. Leave the `life` annotation alone; it is not the setting.

   ```bash
   kubectl patch etcdbackupconfiguration etcd-backup-default -n <namespace> --type=merge \
     -p '{"spec":{"localStorage":{"ttl":"604800"}}}'
   ```

   Old snapshots are removed by the next scheduled backup.

3. To free the upgrade copy on `/`, check what it is first:

   ```bash
   sudo ls -ld /cpaas-backup /backup_* 2>/dev/null || true
   sudo ls /backup_<digits>
   ```

   > **Warning:** Deleting `backup_<digits>` removes the configuration and etcd copy that the upgrade took, and cannot be undone. Precondition: only that directory, after `ls` shows it is the upgrade backup (`etcd` and `kubernetes` subdirectories) and not `cpaas-backup`, and only when the upgrade has completed. Rollback: none, unless you archived the directory elsewhere first.

   ```bash
   sudo rm -rf /backup_<digits>
   ```

### Cause 4: on a standby global cluster, retention is the LIFE variable of the etcd backup CronJob

1. Find the CronJob and save it:

   ```bash
   kubectl get cronjob -A | grep -i etcd-backup
   kubectl -n <namespace> get cronjob <etcd-backup-cronjob> -o yaml > /tmp/etcd-backup-cronjob.yaml
   grep -n -A1 'name: LIFE' /tmp/etcd-backup-cronjob.yaml
   ```

2. Set `LIFE` to the retention you want, in seconds.

   > **Warning:** A smaller `LIFE` removes older standby snapshots on the next run. Precondition: only on the CronJob whose container is `etcd-backup`, and only with the value you intend. Rollback: `kubectl apply -f /tmp/etcd-backup-cronjob.yaml`.

   ```bash
   kubectl -n <namespace> set env cronjob/<etcd-backup-cronjob> -c etcd-backup LIFE=1296000
   ```

### Cause 5: on 4.2.4 the etcd-backup-upgrade-k8s bcj writes a second copy

1. Confirm the extra object:

   ```bash
   kubectl get bcj -A | grep etcd-backup
   ```

2. Save it, then clear its annotations, labels, and owner references.

   > **Warning:** This detaches `etcd-backup-upgrade-k8s` from its owner; the duplicate stops only as long as no controller writes those fields back. It does not delete snapshot files already written. Precondition: only when `etcd-backup-upgrade-k8s` exists and each run writes two copies. Rollback: `kubectl apply -f /tmp/etcd-backup-upgrade-k8s.yaml`.

   ```bash
   kubectl -n <namespace> get bcj etcd-backup-upgrade-k8s -o yaml > /tmp/etcd-backup-upgrade-k8s.yaml
   kubectl -n <namespace> annotate bcj etcd-backup-upgrade-k8s --all-
   kubectl -n <namespace> label bcj etcd-backup-upgrade-k8s --all-
   kubectl -n <namespace> patch bcj etcd-backup-upgrade-k8s --type=json -p='[{"op":"remove","path":"/metadata/ownerReferences"}]'
   ```

   If `ownerReferences` is already absent, skip the patch. The next backup run should write one copy.

## Diagnostic Steps

```bash
kubectl get etcdbackupconfiguration -A
kubectl get etcdbackuprecord -A
kubectl get cronjob -A | grep etcd-backup
kubectl get bcj -A | grep etcd-backup
```

- Dated snapshot files exist on disk while the console shows one `EtcdBackupRecord`: Cause 1.
- 4.1, no backup-management tab, `etcd-backup-default` present: Cause 2.
- A retention change, or `backup_<digits>` next to `cpaas-backup`: Cause 3. Expected: `spec.localStorage.ttl` in the YAML, and `etcd` and `kubernetes` subdirectories in `backup_<digits>`.
- Retention on a standby global cluster without a domain switch: Cause 4.
- Two copies per run and `etcd-backup-upgrade-k8s` in the `bcj` list: Cause 5.
- No `EtcdBackupConfiguration` at all: see the related article on the missing default backup.
