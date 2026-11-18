---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.14.x
  - 3.16.x
  - 4.2.x
  - 4.3.x
---

# Archive Elasticsearch logs to NFS: logarchive mount, log center Kafka address, and archive limits on ACP

## Issue

Platform logs stored in Elasticsearch should also be kept on an external NAS or NFS share, and the archive deployment or its result raises questions:

- The archive manifest has `hostPath` `/cpaas/data/logarchive`. Must the NFS export be mounted on the node first, or should that path be replaced with the NFS server's directory?
- Which Kafka goes into the archive form field `Kafka 服务地址` (Kafka service address): the Kafka that came with the log storage, or a new Kafka from the Data Services catalog?
- Local Elasticsearch should keep about 7 days and older logs should move to the NAS. How are logs older than 7 days read afterwards?
- The archive copies the logs of every project and uses too much space; can it archive only selected projects?
- Logs must be kept 180 days, but the platform allows at most 30 days, and a 180-day lifecycle set in Kibana is reset.
- With ClickHouse log storage on 4.2 or 4.3, can logs be archived or cold-backed up to NFS or NAS?

The archive is the platform documentation's log archiving solution: "Transfer to external NFS" on 3.14, and "How to archive logs to third-party storage" (Observability, Logs, Practical Guides) on 4.x, which writes to an external NFS or S3 through a log sync workload created with `kubectl`. What a running archive writes (scopes, S3 layout, file retention, files that cannot be deleted) is in [Log archive output: platform logs with workload logs, flat S3 objects, file retention, or undeletable .nfs files on ACP](Log_archive_output_platform_logs_with_workload_logs_flat_S3_objects_file_retention_or_undeletable_.nfs_files_on_ACP.md).

## Root Cause

### Cause 1: /cpaas/data/logarchive is the host directory, and the NFS export must be mounted on it before the pod runs there

The log sync workload mounts a `hostPath` volume `data` with `path: /cpaas/data/logarchive` and `type: DirectoryOrCreate`. The path stays as it is in the manifest; it is not rewritten to the NFS server's export. Because `DirectoryOrCreate` creates a local directory when nothing is mounted there, the NFS export has to be mounted on `/cpaas/data/logarchive` on the node before the pod starts on that node, and the pod has to be pinned to that node. Otherwise the archive writes to the node's local disk. The working sequence: label the node, schedule the archive workload onto it, create the directory, mount NFS on it. Whether NFS v3 needs `nolock` was not part of the verified setup.

### Cause 2: the Kafka service address is the log center Kafka, not a new Data Services Kafka

The log collection plugins write the collected logs into the log center Kafka, and the archive component reads them from there. The archive form's `Kafka 服务地址` (Kafka service address) is therefore the platform's built-in log center Kafka. A Kafka instance created from the Data Services catalog receives no logs, so an archive pointed at it stays empty.

### Cause 3: the archive is a real-time copy, not a move after N days

The archive writes a copy of each new log to the NFS share as it is produced. It does not move logs to the NAS after they have been kept locally for some days, and no supported option tiers Elasticsearch logs by age. Log queries within the configured retention are not affected. Logs older than the retention are read from the archive path, not through the log query page; archived files can be read directly after any compressed file is decompressed.

### Cause 4: the archive is cluster-wide and cannot be limited to selected projects

The archive works at cluster level and archives the logs of every project of the cluster (verified on 3.16.2). Archiving only some projects is not supported, so the archive storage has to be sized for all projects.

### Cause 5: logs must be kept longer than the platform retention allows

The platform caps log retention (30 days for a project policy and in 4.x consoles), and a lifecycle edited in Kibana is overwritten by the platform policy. On 3.16 the Elasticsearch retention can be set to 180 days, but adding disks to keep 180 days in place is not recommended, and later versions cap log retention at 30 days. For Elasticsearch, the long-term copy is the log archive to NFS. For ClickHouse log storage in 4.x, the logging plugin allows at most 30 days of log retention, events and audit records have their own, longer maximum (read it on the plugin form), and no supported way to keep logs longer is known.

### Cause 6: ClickHouse log storage on 4.2 and 4.3 has no log archive to NFS or NAS

The log archiving in the documentation applies to Elasticsearch storage. ClickHouse log storage on 4.2 and 4.3 has no log archive, so the archive guide does not apply to it and backing up ClickHouse logs to a NAS is not supported. What ClickHouse logging offers instead is S3 integration with hot/cold separation, available from the 4.3 logging component. A 4.2 platform gets it by upgrading the platform to 4.2.5 and then the logging component to 4.3. Hot/cold separation tiers data inside the retention the plugin allows; it is not a way past the 30-day log cap.

## Resolution

### Cause 1: /cpaas/data/logarchive is the host directory, and the NFS export must be mounted on it before the pod runs there

1. Read the two images the documented manifest needs, on the global cluster:

   ```bash
   # alpine image
   kubectl get daemonset nevermore -n cpaas-system -o jsonpath='{.spec.template.spec.initContainers[0].image}'
   # log sync image: the 3.14 document reads it from lanaya, the 4.x guide from razor
   kubectl get deployment lanaya -n cpaas-system -o jsonpath='{.spec.template.spec.containers[0].image}'
   kubectl get deployment razor -n cpaas-system -o jsonpath='{.spec.template.spec.containers[0].image}'
   ```

2. On the node that will run the archive, create the directory and mount the NFS export on it.

   > **Warning:** Mounting NFS on `/cpaas/data/logarchive` hides any files already in that directory while the mount is in place. Precondition: the directory is empty or its contents were copied aside, and `<nfs-server>:<export>` is the archive target. Rollback: `umount /cpaas/data/logarchive`. Persist the mount the way this node persists its other NFS mounts, so a reboot does not leave the archive writing to local disk.

   ```bash
   mkdir -p /cpaas/data/logarchive
   mount -t nfs <nfs-server>:<export> /cpaas/data/logarchive
   df -hT /cpaas/data/logarchive
   ```

   `df` must show an `nfs` type, not the root disk.

3. Pin the archive workload to that node, either with a node label that the workload's node selector uses or with the node name if the manifest takes one:

   ```bash
   kubectl label node <archive-node> <archive-label>=true
   ```

4. Apply the manifest from the documentation, keeping `/cpaas/data/logarchive` unchanged.

### Cause 2: the Kafka service address is the log center Kafka, not a new Data Services Kafka

Read the log center Kafka service and use the broker address the log pipeline already produces to:

```bash
kubectl -n cpaas-system get svc | grep -i kafka
kubectl -n cpaas-system get pods | grep -i kafka
```

### Cause 3: the archive is a real-time copy, not a move after N days

Set the local retention to the number of days that must stay searchable, and deploy the archive as in Causes 1 and 2 so every new log is also copied. Read older logs on the share, for example:

```bash
ls -lt /cpaas/data/logarchive | head
find /cpaas/data/logarchive -name '*.gz' -mtime +7 | head
zcat <archive-file>.gz | less
```

List the directory first; use the decompressor that matches the files if they are not gzip.

### Cause 4: the archive is cluster-wide and cannot be limited to selected projects

No configuration narrows it. Size the archive storage for the logs of all projects of the cluster.

### Cause 5: logs must be kept longer than the platform retention allows

On Elasticsearch, keep the platform retention within its cap and deploy the archive to NFS for the long-term copy; do not rely on Kibana lifecycle edits. On ClickHouse, 30 days is the maximum log retention in the 4.x logging plugin; a longer retention has to be raised as a feature request.

### Cause 6: ClickHouse log storage on 4.2 and 4.3 has no log archive to NFS or NAS

Check the documentation of the installed logging component; offer ClickHouse archiving only if that version lists it. To move retained ClickHouse logs off local disk, use S3 hot/cold storage from the 4.3 logging component. On 4.2:

1. Upgrade the platform to 4.2.5.
2. Upgrade the logging component to 4.3.
3. Configure S3 as described in "How to Use S3 Storage with ClickHouse" in the logging documentation.

## Diagnostic Steps

1. On the archive node, confirm the mount and the pod placement:

   ```bash
   findmnt /cpaas/data/logarchive
   kubectl get pods -A -o wide | grep -iE 'log-export|archive'
   ```

   `findmnt` must show `nfs`, and the archive pod's node must be the node with the mount. A local file system type means the archive writes to local disk (Cause 1).

2. If the archive stays empty while Elasticsearch has recent logs, compare the configured Kafka address with the brokers listed in Cause 2. The archive only receives what the collectors write to the log center Kafka.
3. Which log store runs: `kubectl get pods -A | grep -iE 'clickhouse|cpaas-elasticsearch'`. A ClickHouse store asking for archive or NAS backup is Cause 6, and a request to keep logs longer than 30 days is Cause 5. For Elasticsearch, tiering by age is Cause 3 and selected projects is Cause 4.
