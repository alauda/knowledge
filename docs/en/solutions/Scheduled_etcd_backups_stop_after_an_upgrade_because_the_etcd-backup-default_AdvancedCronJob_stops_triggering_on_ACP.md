---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x
---

# Scheduled etcd backups stop after an upgrade because the etcd-backup-default AdvancedCronJob stops triggering on ACP

## Issue

A routine check of a cluster that was upgraded shows that the last etcd backup is several days old:

- The newest snapshot file in the backup directory on the control plane nodes is from a date shortly after the upgrade, and nothing newer has been written.
- `kubectl get broadcastjobs -n cpaas-system` lists `etcd-backup-default-<unix-time>` BroadcastJobs only up to that date. No newer ones are created, even though the older ones completed (`DESIRED 3`, `SUCCEEDED 3`). The last one can also show one failed node.
- The `etcd-backup` feature is enabled, but the cluster has no etcd backup page in the console.

## Root Cause

Scheduled etcd backups are driven by the AdvancedCronJob (`acj`) `etcd-backup-default` in `cpaas-system`. At each scheduled time it creates a BroadcastJob (`bcj`) named `etcd-backup-default-<unix-time>` that runs the backup on every control plane node. The AdvancedCronJob works out its next trigger time from the BroadcastJobs it owns.

During an upgrade, some BroadcastJobs can be created from the AdvancedCronJob without the schedule annotation. The AdvancedCronJob then fails to compute its next trigger time, and from then on it never triggers again. The object still exists and looks healthy, so the problem only shows up as backups that stop. This happens only occasionally. It is a known defect, and recreating the AdvancedCronJob clears it.

The missing etcd backup page is a separate issue. The page is provided by the **Alauda Container Platform Cluster Enhancer** plugin, so a cluster where this plugin is not installed shows no backup page even though backups run in the background.

## Resolution

1. If the cluster has no etcd backup page, download the **Alauda Container Platform Cluster Enhancer** package that matches the platform version, upload it with `violet push`, and install it on the cluster from **Administrator** > **Marketplace** > **Cluster Plugins**. This restores the page. It does not by itself restart the stopped schedule.

2. Save the AdvancedCronJob and record its schedule:

   ```bash
   kubectl -n cpaas-system get acj etcd-backup-default -o yaml > /tmp/acj-etcd-backup-default.yaml
   grep -n -E 'schedule|paused' /tmp/acj-etcd-backup-default.yaml
   ```

3. Prepare a copy that can be applied again. In `/tmp/acj-etcd-backup-default.recreate.yaml`, remove `metadata.resourceVersion`, `metadata.uid`, `metadata.creationTimestamp`, `metadata.managedFields` and the whole `status` block:

   ```bash
   cp /tmp/acj-etcd-backup-default.yaml /tmp/acj-etcd-backup-default.recreate.yaml
   vi /tmp/acj-etcd-backup-default.recreate.yaml
   ```

4. Delete the AdvancedCronJob and apply the saved copy.

   > **Warning:** While the AdvancedCronJob is deleted, the cluster has no scheduled etcd backup. Do this only when the diagnostic steps confirm that `etcd-backup-default` exists but has created no BroadcastJob since the last good backup, and only after `/tmp/acj-etcd-backup-default.yaml` has been saved. Rollback: `kubectl apply -f /tmp/acj-etcd-backup-default.recreate.yaml`.

   ```bash
   kubectl -n cpaas-system delete acj etcd-backup-default
   kubectl apply -f /tmp/acj-etcd-backup-default.recreate.yaml
   kubectl -n cpaas-system get acj etcd-backup-default
   ```

5. Verify that the schedule fires. Either wait for the next scheduled time, or set the schedule temporarily a few minutes ahead, confirm that a new BroadcastJob runs, and then set the schedule back to the value recorded in step 2:

   ```bash
   kubectl -n cpaas-system edit acj etcd-backup-default     # temporary schedule, then restore it
   kubectl -n cpaas-system get broadcastjobs | grep etcd-backup-default
   ```

   A new `etcd-backup-default-<unix-time>` BroadcastJob should appear and reach `SUCCEEDED` equal to `DESIRED`, and a new snapshot file should appear on each control plane node.

6. Repeat the procedure on every cluster that shows the same symptom.

## Diagnostic Steps

1. Check the dates of the snapshot files on each control plane node. Use the backup path configured for the cluster:

   ```bash
   ls -lt <backup-path> | head
   ```

   Expected for this issue: the newest file is several days old.

2. List the backup BroadcastJobs and compare their ages with the schedule:

   ```bash
   kubectl get broadcastjobs -A | grep etcd-backup
   ```

   Expected for this issue: the newest `etcd-backup-default-<unix-time>` is as old as the newest snapshot, and no newer one exists. If new BroadcastJobs keep appearing but end in `FAILED`, the schedule is working and the backup run itself fails. That is a different problem: read the logs of the failed `etcd-backup` Pods instead.

3. Confirm that the AdvancedCronJob exists and is not paused:

   ```bash
   kubectl -n cpaas-system get acj etcd-backup-default -o jsonpath='{.spec.schedule} paused={.spec.paused}{"\n"}'
   ```

   Expected for this issue: the expected schedule and `paused=` empty or `false`. The object exists, but nothing has been created since the last good backup.

4. When the backup page is missing, check in **Administrator** > **Marketplace** > **Cluster Plugins** whether **Alauda Container Platform Cluster Enhancer** is installed on that cluster. On the global cluster, the installed plugins of a cluster can also be listed with:

   ```bash
   kubectl get moduleinfo -l cpaas.io/cluster-name=<cluster-name> | grep -i enhancer
   ```

   No output means that the plugin is not installed on that cluster.
