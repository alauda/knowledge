---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Log archive output: platform logs with workload logs, flat S3 objects, file retention, or undeletable .nfs files on ACP

## Issue

The log archive (log sync to external NFS or S3) is running, and its output is not what the owner expected:

- Only application (workload) logs are enabled, but system component logs from `cpaas-system` and `kube-system` are archived as well.
- After switching the archive from NFS to S3, the bucket has no directory hierarchy; only the log files appear.
- Business logs must be kept for 3 years, but the archive holds only about half a year; the oldest daily directory is about 180 days old.
- `log-exporter-config` says `path: /cpaas/data/logarchive`, but `ls /cpaas/data/logarchive` on the host says `No such file or directory`.
- Does the hostPath archive directory grow without limit?
- Are audit logs archived?
- Deleting old archived logs fails, and files whose names start with `.nfs` appear in the archive directory; their content looks like the consumed Kafka records.

Deploying the archive (the `/cpaas/data/logarchive` mount, the Kafka address, real-time copy versus move after N days) is in [Archive Elasticsearch logs to NFS: logarchive mount, log center Kafka address, and archive limits on ACP](Archive_Elasticsearch_logs_to_NFS_logarchive_mount_log_center_Kafka_address_and_archive_limits_on_ACP.md).

The documented archive ("How to archive logs to third-party storage") consists of three objects in `cpaas-system`:

- Secret `log-export-s3-secret` with `access_key_id` and `secret_access_key` (S3 output only).
- ConfigMap `log-exporter-config` with the file `export.yml`: `scopes` (`system`, `workload`, `kubernetes`, `platform`, each `true` or `false`) and `output` (`type` `local` or `s3`, `path: /cpaas/data/logarchive`, `layout: TimePrefixed`, `max_size`, `compression` such as `gzip`, `file_type: txt`, and for S3 the endpoint, bucket, `s3forcepathstyle`, and `insecure`).
- Deployment `log-exporter` (also seen as `log-export`): an alpine init container that runs `chown`, and a `razor` container that runs `/razor consumer ... --database-type=file --export-config=/etc/log-export/export.yml` against the log center Kafka.

## Root Cause

### Cause 1: on Elasticsearch, the Workload scope also exports platform logs, and the Platform scope has no effect

The archiver selects each log item by its index prefix: `log-system` follows `scopes.system`, `log-kubernetes` follows `scopes.kubernetes`, `log-platform` follows `scopes.platform`, and every other value falls to the default branch, which follows `scopes.workload`. With Elasticsearch log storage, the index prefix is empty for both application (workload) and product (platform) logs, so both fall to the default branch: with Workload on, platform logs are archived too; with Workload off, neither is; the Platform switch changes nothing. System and Kubernetes logs are not affected. No setting separates them.

### Cause 2: S3 objects have no directory hierarchy

This is expected. The date-time / project / cluster directories exist only in the temporary local path; the uploaded objects are the log files themselves.

### Cause 3: archive files older than 180 days are deleted by a cron job on the host, not by the platform

The platform does not limit how long archive files are kept. A scheduled task on the host that mounts the archive volume ran a cleanup script that took a target directory (`TARGET_DIR="${1:-.}"`) and a day threshold (`DAYS_THRESHOLD="${2:-180}"`), listed subdirectories with `find "$TARGET_DIR" -maxdepth 1 -type d`, compared their modification time (`stat -c %Y`), and ran `rm -rf` on those older than the threshold. With the default of 180, about half a year of daily directories remained.

### Cause 4: the output path in log-exporter-config is a path inside the pod

`output.path: /cpaas/data/logarchive` is where the archive container writes. What backs it is the volume mounted at that path in the Deployment. When that volume is a PVC on an NFS StorageClass, the files are on the NFS share of that PV, not in a host directory of that name. Only in the hostPath layout is the same path also the host directory.

### Cause 5: the hostPath archive directory is not cleaned by the platform

Nothing in the archive caps or cleans the hostPath directory; it grows until something removes old files. A scheduled cleanup on the node is the way to bound it.

### Cause 6: audit logs are not an archive scope

The archive covers log data only: system, application (workload), Kubernetes, and product (platform) logs. Audit data is not archived. For a 6-month log backup requirement, the archive is the recommended path rather than a 180-day retention in the log Elasticsearch, which uses a large amount of storage and affects Elasticsearch performance.

### Cause 7: archived files cannot be deleted, and .nfs files appear in the archive directory

The log archive does not create `.nfs` files itself. They are the NFS client's protection for open files: when a file that a process still holds open is deleted on an NFS mount, the client renames it to `.nfs<id>` instead of removing it, and removes it when the last process closes it. Archived files that cannot be deleted, with `.nfs` files left in their place, come from a known defect in the log archiving solution that keeps files open; it is fixed in versions after 3.18.3.

## Resolution

### Cause 1: on Elasticsearch, the Workload scope also exports platform logs, and the Platform scope has no effect

Plan the archive storage for workload plus platform logs when Workload is on, and do not rely on the Platform switch. Check the live scopes:

```bash
kubectl -n cpaas-system get configmap log-exporter-config -o jsonpath='{.data.export\.yml}'
```

### Cause 2: S3 objects have no directory hierarchy

No change. Find files by object name and time in the bucket.

### Cause 3: archive files older than 180 days are deleted by a cron job on the host, not by the platform

Find the scheduled task on the node that mounts the archive volume and read its threshold:

```bash
crontab -l
grep -r -l -iE 'rm -rf|find ' /etc/cron.d/ 2>/dev/null
cat <cleanup-script>
```

> **Warning:** The script runs `rm -rf` on archive directories; a wrong directory argument or a threshold in the wrong unit deletes archive data permanently. Precondition: you saved the current crontab, the first argument is the archive directory, and the new threshold is in days (about 1095 for 3 years). Rollback: restore the saved crontab line; deleted directories do not return.

```bash
crontab -l > /tmp/crontab.before
crontab -e
```

Change the day threshold argument of the cleanup line to the number of days that must be kept, and size the share for that period (a 1.7T share was 54% used with about 180 days on it).

### Cause 4: the output path in log-exporter-config is a path inside the pod

Read the volume mounted at that path, then where that volume lives:

```bash
kubectl -n cpaas-system get deploy | grep -E 'log-export'
kubectl -n cpaas-system get deploy <log-exporter-deploy> -o jsonpath='{range .spec.template.spec.volumes[*]}{.name}{" pvc="}{.persistentVolumeClaim.claimName}{" hostPath="}{.hostPath.path}{"\n"}{end}'
kubectl -n cpaas-system get pvc <archive-pvc> -o jsonpath='{.spec.volumeName}{"\n"}'
df -h | grep <pv-name>
```

For a PVC the files are on the PV's share; for hostPath they are on the node that runs the pod.

### Cause 5: the hostPath archive directory is not cleaned by the platform

Add a scheduled cleanup on each node that runs the archive pod.

> **Warning:** The cleanup deletes archive files permanently. Precondition: `<archive-dir>` is the hostPath archive directory (check it with the Cause 4 commands), `<days>` is at least the period that must be kept, and you ran the `find` without `-delete` first. Rollback: remove the crontab line; deleted files do not return.

```bash
find <archive-dir> -type f -mtime +<days> | head
( crontab -l; echo "0 2 * * * find <archive-dir> -type f -mtime +<days> -delete" ) | crontab -
```

### Cause 6: audit logs are not an archive scope

Audit records are not archived. Keep the needed audit days in the log storage retention (read the maximum on the plugin form) and size the disk for it. For logs, deploy the archive with the scopes that are required.

### Cause 7: archived files cannot be deleted, and .nfs files appear in the archive directory

1. Confirm which process holds the files (on the node that mounts the share):

   ```bash
   ls -la <archive-dir>/.nfs* | head
   lsof +D <archive-dir> 2>/dev/null | head
   kubectl -n cpaas-system get deploy,pods | grep -E 'log-export'
   ```

2. Do not delete the `.nfs` files by hand; the NFS client removes each one when the process that holds it closes it.
3. Upgrade the log archiving solution to a version after 3.18.3, which fixes the defect.

## Diagnostic Steps

1. Read the archive configuration and workload:

   ```bash
   kubectl -n cpaas-system get configmap log-exporter-config -o yaml
   kubectl -n cpaas-system get deploy,pods | grep -E 'log-export'
   kubectl -n cpaas-system logs deploy/<log-exporter-deploy> --tail=100
   ```

2. Store type: `kubectl get pods -A | grep -iE 'cpaas-elasticsearch|clickhouse'`. Platform logs in the archive with only Workload on, on Elasticsearch, is Cause 1.
3. Archive directories disappearing at a fixed age that matches a host cron script threshold is Cause 3:

   ```bash
   ls <archive-dir> | head
   ```

4. `No such file or directory` on the host for the ConfigMap path is Cause 4.
5. `.nfs` files next to archived files that cannot be deleted, on an NFS-backed archive, is Cause 7.
