---
products:
   - Alauda Container Platform
   - Alauda Application Services
kind:
   - Solution
ProductsVersion:
   - 4.3.x
---
# How to Back Up and Restore ClickHouse with clickhouse-backup

## Issue

ClickHouse data needs a repeatable backup and restore procedure for disaster recovery, migration validation, and operational recovery. In Alauda Container Platform environments, ClickHouse instances deployed by the ClickHouse Operator can use a `clickhouse-backup` sidecar to create local backups, upload backups to S3-compatible storage, and restore backups into another ClickHouse instance.

## Environment

This solution applies to environments with the following components:

- Alauda Container Platform 4.3.x
- Alauda Application Services ClickHouse Operator 4.3.x
- ClickHouseInstallation custom resources managed by the ClickHouse Operator
- S3-compatible object storage, such as MinIO
- Network connectivity from ClickHouse Pods to the S3 endpoint
- `kubectl` access to the target cluster

The upstream `clickhouse-backup` tool supports ClickHouse versions later than `1.1.54394`. For older ClickHouse versions, only MergeTree family table engines are supported. Additional table types are supported by newer `clickhouse-server` versions when embedded backup and restore mode is enabled.

## Resolution

Deploy the ClickHouse instance with a `clickhouse-backup` sidecar, make the ClickHouse data directory visible to both containers, create a remote backup, and restore that backup into a separate ClickHouse instance.

The critical requirements are:

- Keep the main ClickHouse container in the custom Pod template by adding `- name: clickhouse`.
- Mount the same ClickHouse data volume at `/var/lib/clickhouse` in both `clickhouse` and `clickhouse-backup` containers.
- Back up data from MergeTree-family local tables. Distributed tables are backed up as schema only.
- Use a separate restore ClickHouseInstallation for validation.

## Prerequisites

Before starting, collect the following information:

| Item | Description | Example |
|------|-------------|---------|
| Namespace | Namespace for the ClickHouse instances and Jobs | `clickhouse-backup-demo` |
| Source ClickHouseInstallation name | Source instance name | `demo` |
| Restore ClickHouseInstallation name | Restore instance name | `demo-restore` |
| ClickHouse cluster name | Cluster name in the ClickHouseInstallation spec | `replicated` |
| S3 endpoint | S3-compatible object storage endpoint | `http://<minio-host>:<port>` |
| S3 bucket | Bucket for backup storage | `clickhouse` |
| S3 access key | Access key for the bucket | `<s3-access-key>` |
| S3 secret key | Secret key for the bucket | `<s3-secret-key>` |

Create the S3 bucket before running the backup workflow.

```bash
mc alias set backup-s3 http://<minio-host>:<port> <s3-access-key> <s3-secret-key>
mc mb --ignore-existing backup-s3/clickhouse
```

## Implementation Steps

### Step 1: Create a namespace

```bash
kubectl create namespace clickhouse-backup-demo
```

### Step 2: Create a ClickHouse instance with a backup sidecar

Create `clickhouse-source.yaml`.

Replace the S3 endpoint, bucket, access key, and secret key with values from your environment.

```yaml
apiVersion: clickhouse.altinity.com/v1
kind: ClickHouseInstallation
metadata:
  name: demo
  namespace: clickhouse-backup-demo
spec:
  configuration:
    clusters:
      - name: replicated
        layout:
          shardsCount: 1
          replicasCount: 1
        templates:
          podTemplate: clickhouse-with-backup
  templates:
    podTemplates:
      - name: clickhouse-with-backup
        spec:
          containers:
            - name: clickhouse
              volumeMounts:
                - name: clickhouse-data
                  mountPath: /var/lib/clickhouse
            - name: clickhouse-backup
              image: docker-mirrors.alauda.cn/altinity/clickhouse-backup:2.6.3
              imagePullPolicy: IfNotPresent
              args:
                - server
              env:
                - name: LOG_LEVEL
                  value: debug
                - name: ALLOW_EMPTY_BACKUPS
                  value: "true"
                - name: API_LISTEN
                  value: 0.0.0.0:7171
                - name: API_CREATE_INTEGRATION_TABLES
                  value: "true"
                - name: BACKUPS_TO_KEEP_REMOTE
                  value: "3"
                - name: REMOTE_STORAGE
                  value: s3
                - name: S3_ACL
                  value: private
                - name: S3_ENDPOINT
                  value: http://<minio-host>:<port>
                - name: S3_BUCKET
                  value: clickhouse
                - name: S3_PATH
                  value: backup/shard-{shard}
                - name: S3_ACCESS_KEY
                  value: <s3-access-key>
                - name: S3_SECRET_KEY
                  value: <s3-secret-key>
                - name: S3_FORCE_PATH_STYLE
                  value: "true"
                - name: S3_DISABLE_SSL
                  value: "true"
              ports:
                - containerPort: 7171
                  name: backup-rest
              volumeMounts:
                - name: clickhouse-data
                  mountPath: /var/lib/clickhouse
              securityContext:
                runAsUser: 101
                runAsGroup: 101
    volumeClaimTemplates:
      - name: clickhouse-data
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 10Gi
```

Apply the manifest and wait for the Pod to become ready.

```bash
kubectl apply -f clickhouse-source.yaml
kubectl -n clickhouse-backup-demo wait --for=condition=Ready pod/chi-demo-replicated-0-0-0 --timeout=10m
kubectl -n clickhouse-backup-demo get pod chi-demo-replicated-0-0-0
```

The Pod must show two ready containers.

```text
NAME                        READY   STATUS
chi-demo-replicated-0-0-0   2/2     Running
```

Verify that the backup integration tables were created.

```bash
kubectl -n clickhouse-backup-demo exec chi-demo-replicated-0-0-0 -c clickhouse -- \
  clickhouse-client -q "SHOW TABLES FROM system LIKE 'backup_%'"
```

Expected output includes:

```text
backup_actions
backup_list
backup_version
```

### Step 3: Insert test data

Create a local MergeTree table and a Distributed table.

```bash
kubectl -n clickhouse-backup-demo exec chi-demo-replicated-0-0-0 -c clickhouse -- \
  clickhouse-client -mn --query "
    CREATE TABLE events_local
    (
      event_date Date,
      event_type Int32,
      article_id Int32,
      title String
    )
    ENGINE = MergeTree()
    PARTITION BY toYYYYMM(event_date)
    ORDER BY (event_type, article_id);

    CREATE TABLE events AS events_local
    ENGINE = Distributed('replicated', default, events_local, rand());

    INSERT INTO events_local
    SELECT today(), rand() % 3, number, 'backup test' FROM numbers(1000);

    SELECT count() FROM events_local;
  "
```

The expected count is:

```text
1000
```

Confirm that ClickHouse created active data parts for the local table.

```bash
kubectl -n clickhouse-backup-demo exec chi-demo-replicated-0-0-0 -c clickhouse -- \
  clickhouse-client -q "
    SELECT table, sum(rows), sum(bytes_on_disk)
    FROM system.parts
    WHERE database = 'default' AND table = 'events_local' AND active
    GROUP BY table
  "
```

### Step 4: Create and upload a backup

The simplest verified command is `create_remote`, which creates a local backup and uploads it to the configured remote storage in one step.

```bash
BACKUP_NAME="full-$(date +%Y%m%d%H%M%S)"

kubectl -n clickhouse-backup-demo exec chi-demo-replicated-0-0-0 -c clickhouse-backup -- \
  clickhouse-backup create_remote "$BACKUP_NAME"
```

List the backup from the sidecar.

```bash
kubectl -n clickhouse-backup-demo exec chi-demo-replicated-0-0-0 -c clickhouse-backup -- \
  clickhouse-backup list | grep "$BACKUP_NAME"
```

Expected output contains both local and remote entries.

```text
full-20260514135449   ...   local    regular
full-20260514135449   ...   remote   tar, regular
```

Verify that the remote storage contains both metadata and data part objects.

```bash
mc find backup-s3/clickhouse/backup/shard-0/$BACKUP_NAME --maxdepth 5
```

Expected objects include a `shadow` path for MergeTree data parts.

```text
backup/shard-0/full-20260514135449/metadata.json
backup/shard-0/full-20260514135449/metadata/default/events.json
backup/shard-0/full-20260514135449/metadata/default/events_local.json
backup/shard-0/full-20260514135449/shadow/default/events_local/default_202605_1_1_0.tar
```

### Step 5: Create a backup Job

The sidecar also exposes `system.backup_actions`. This allows backup automation from a Kubernetes Job that only needs `clickhouse-client` network access to the ClickHouse service.

Create `clickhouse-backup-job.yaml`.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: clickhouse-backup-manual
  namespace: clickhouse-backup-demo
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: run-backup
          image: clickhouse/clickhouse-client:latest
          imagePullPolicy: IfNotPresent
          env:
            - name: CLICKHOUSE_HOST
              value: chi-demo-replicated-0-0
            - name: CLICKHOUSE_PORT
              value: "9000"
          command:
            - bash
            - -ec
            - |
              BACKUP_NAME="full-$(date +%Y%m%d%H%M%S)"
              COMMAND="create_remote ${BACKUP_NAME}"

              clickhouse-client --host="$CLICKHOUSE_HOST" --port="$CLICKHOUSE_PORT" -mn \
                --query="INSERT INTO system.backup_actions(command) VALUES('${COMMAND}')"

              while true; do
                STATUS=$(clickhouse-client --host="$CLICKHOUSE_HOST" --port="$CLICKHOUSE_PORT" -mn \
                  --query="SELECT status FROM system.backup_actions WHERE command='${COMMAND}' ORDER BY start DESC LIMIT 1 FORMAT TabSeparatedRaw")
                echo "${COMMAND}: ${STATUS}"
                if [ "$STATUS" != "in progress" ]; then
                  break
                fi
                sleep 2
              done

              if [ "$STATUS" != "success" ]; then
                clickhouse-client --host="$CLICKHOUSE_HOST" --port="$CLICKHOUSE_PORT" -mn \
                  --query="SELECT command,status,error FROM system.backup_actions WHERE command='${COMMAND}' ORDER BY start DESC LIMIT 1"
                exit 1
              fi

              echo "BACKUP_NAME=${BACKUP_NAME}"
```

Apply and verify the Job.

```bash
kubectl apply -f clickhouse-backup-job.yaml
kubectl -n clickhouse-backup-demo wait --for=condition=complete job/clickhouse-backup-manual --timeout=20m
kubectl -n clickhouse-backup-demo logs job/clickhouse-backup-manual
```

### Step 6: Create a scheduled backup CronJob

After the manual Job succeeds, use the same command body in a CronJob.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: clickhouse-backup-cron
  namespace: clickhouse-backup-demo
spec:
  schedule: "0 0 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 1
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: run-backup
              image: clickhouse/clickhouse-client:latest
              imagePullPolicy: IfNotPresent
              env:
                - name: CLICKHOUSE_HOST
                  value: chi-demo-replicated-0-0
                - name: CLICKHOUSE_PORT
                  value: "9000"
              command:
                - bash
                - -ec
                - |
                  BACKUP_NAME="full-$(date +%Y%m%d%H%M%S)"
                  COMMAND="create_remote ${BACKUP_NAME}"
                  clickhouse-client --host="$CLICKHOUSE_HOST" --port="$CLICKHOUSE_PORT" -mn \
                    --query="INSERT INTO system.backup_actions(command) VALUES('${COMMAND}')"
                  while true; do
                    STATUS=$(clickhouse-client --host="$CLICKHOUSE_HOST" --port="$CLICKHOUSE_PORT" -mn \
                      --query="SELECT status FROM system.backup_actions WHERE command='${COMMAND}' ORDER BY start DESC LIMIT 1 FORMAT TabSeparatedRaw")
                    echo "${COMMAND}: ${STATUS}"
                    if [ "$STATUS" != "in progress" ]; then
                      break
                    fi
                    sleep 2
                  done
                  test "$STATUS" = "success"
```

For multi-shard clusters, run the same command once against one replica service per shard, and use a unique `S3_PATH` or backup name per shard.

### Step 7: Create a restore ClickHouse instance

Create another ClickHouseInstallation with the same sidecar and S3 configuration. Use a different instance name.

Create `clickhouse-restore.yaml` by copying `clickhouse-source.yaml` and changing only the metadata name.

```yaml
metadata:
  name: demo-restore
  namespace: clickhouse-backup-demo
```

Apply it and wait for the restore Pod.

```bash
kubectl apply -f clickhouse-restore.yaml
kubectl -n clickhouse-backup-demo wait --for=condition=Ready pod/chi-demo-restore-replicated-0-0-0 --timeout=10m
```

### Step 8: Restore the backup to the new instance

Use the backup name from Step 4 or Step 5.

```bash
BACKUP_NAME=<backup-name>

kubectl -n clickhouse-backup-demo exec chi-demo-restore-replicated-0-0-0 -c clickhouse-backup -- \
  clickhouse-backup restore_remote "$BACKUP_NAME"
```

The same restore can be automated through `system.backup_actions`.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: clickhouse-backup-restore
  namespace: clickhouse-backup-demo
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: run-restore
          image: clickhouse/clickhouse-client:latest
          imagePullPolicy: IfNotPresent
          env:
            - name: CLICKHOUSE_HOST
              value: chi-demo-restore-replicated-0-0
            - name: CLICKHOUSE_PORT
              value: "9000"
            - name: RESTORE_BACKUP
              value: <backup-name>
          command:
            - bash
            - -ec
            - |
              COMMAND="restore_remote ${RESTORE_BACKUP}"
              clickhouse-client --host="$CLICKHOUSE_HOST" --port="$CLICKHOUSE_PORT" -mn \
                --query="INSERT INTO system.backup_actions(command) VALUES('${COMMAND}')"
              while true; do
                STATUS=$(clickhouse-client --host="$CLICKHOUSE_HOST" --port="$CLICKHOUSE_PORT" -mn \
                  --query="SELECT status FROM system.backup_actions WHERE command='${COMMAND}' ORDER BY start DESC LIMIT 1 FORMAT TabSeparatedRaw")
                echo "${COMMAND}: ${STATUS}"
                if [ "$STATUS" != "in progress" ]; then
                  break
                fi
                sleep 2
              done
              test "$STATUS" = "success"
```

Apply and verify the restore Job.

```bash
kubectl apply -f clickhouse-restore-job.yaml
kubectl -n clickhouse-backup-demo wait --for=condition=complete job/clickhouse-backup-restore --timeout=20m
kubectl -n clickhouse-backup-demo logs job/clickhouse-backup-restore
```

### Step 9: Verify restored data

```bash
kubectl -n clickhouse-backup-demo exec chi-demo-restore-replicated-0-0-0 -c clickhouse -- \
  clickhouse-client -mn --query "
    SHOW TABLES;
    SELECT count() FROM events_local;
    SELECT count() FROM events;
  "
```

Expected output:

```text
events
events_local
1000
1000
```

## Root Cause

ClickHouse Operator manages database Pods and services, but it does not provide a complete scheduled backup and restore workflow by itself. `clickhouse-backup` can provide that workflow when it runs as a sidecar that can connect to ClickHouse and read the ClickHouse data directory.

If the sidecar does not mount the same `/var/lib/clickhouse` volume as the main ClickHouse container, backups may contain only metadata. In that case, `clickhouse-backup` can query table schemas through ClickHouse, but it cannot read the frozen MergeTree parts from the filesystem.

For Distributed tables, `clickhouse-backup` backs up schema only. The actual data is stored in the underlying MergeTree-family local tables, such as `events_local`.

## Diagnostic Steps

### Check whether the Pod has both containers

```bash
kubectl -n clickhouse-backup-demo get pod chi-demo-replicated-0-0-0
```

Expected output:

```text
READY   STATUS
2/2     Running
```

If the Pod shows `1/1` and only the `clickhouse-backup` container exists, the custom Pod template replaced the default container. Add the `- name: clickhouse` container entry to the Pod template.

### Check whether both containers mount the data volume

```bash
kubectl -n clickhouse-backup-demo get pod chi-demo-replicated-0-0-0 -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{range .volumeMounts[*]}{.name}{" -> "}{.mountPath}{"\n"}{end}{end}'
```

Both containers must mount the same volume at `/var/lib/clickhouse`.

### Check backup integration tables

```bash
kubectl -n clickhouse-backup-demo exec chi-demo-replicated-0-0-0 -c clickhouse -- \
  clickhouse-client -q "SHOW TABLES FROM system LIKE 'backup_%'"
```

Expected tables include:

```text
backup_actions
backup_list
backup_version
```

If these tables do not exist, check the `clickhouse-backup` logs.

```bash
kubectl -n clickhouse-backup-demo logs chi-demo-replicated-0-0-0 -c clickhouse-backup --tail=100
```

### Check whether table data exists

```bash
kubectl -n clickhouse-backup-demo exec chi-demo-replicated-0-0-0 -c clickhouse -- \
  clickhouse-client -q "
    SELECT database, table, sum(rows), sum(bytes_on_disk)
    FROM system.parts
    WHERE active
    GROUP BY database, table
    ORDER BY database, table
  "
```

### Check whether the backup contains data files

```bash
mc find backup-s3/clickhouse/backup/shard-0/<backup-name> --maxdepth 5
```

A backup that contains data includes `shadow/...tar` objects. A backup that only contains `metadata/...json` objects is schema-only or cannot see the ClickHouse data directory.

### Common Issues

| Symptom | Possible cause | Action |
|---------|----------------|--------|
| Pod has only one container | The Pod template omitted the `clickhouse` container entry | Add `- name: clickhouse` to the Pod template. |
| Backup contains only `metadata/*.json` | The sidecar does not mount the same `/var/lib/clickhouse` volume | Mount the ClickHouse data volume into both containers. |
| `system.backup_actions` does not exist | The sidecar is not running, cannot connect to ClickHouse, or `API_CREATE_INTEGRATION_TABLES` is not enabled | Check sidecar logs and environment variables. |
| Distributed table data is not backed up | Distributed tables store schema only | Back up the underlying MergeTree local tables. |
| Backup upload fails | S3 endpoint, bucket, credentials, or network path are incorrect | Verify the S3 configuration and test with `mc ls`. |
| Restore cannot find backup | The restore instance uses a different `S3_PATH` or backup name | Use `clickhouse-backup list` and S3 object paths to confirm the backup name. |
| Duplicate rows after restore in a multi-replica cluster | Data restore was run on multiple replicas for the same shard | Restore data once per shard. |
| CronJob overlaps with a previous run | Backup duration is longer than schedule interval | Use `concurrencyPolicy: Forbid`. |

## Validation Result

The procedure was validated on an Alauda Container Platform 4.3 environment with ClickHouse Operator 4.3 and `altinity/clickhouse-backup:2.6.3`.

Validated results:

- Source Pod ran with two containers: `clickhouse` and `clickhouse-backup`.
- Both containers mounted the same `/var/lib/clickhouse` volume.
- `system.backup_actions`, `system.backup_list`, and `system.backup_version` were created.
- `clickhouse-backup create_remote` uploaded metadata and MergeTree data part archives to S3.
- `system.backup_actions` successfully triggered `create_remote <backup-name>`.
- `clickhouse-backup restore_remote <backup-name>` restored the backup into a separate ClickHouseInstallation.
- The restored `events_local` and `events` tables both returned `1000` rows.
