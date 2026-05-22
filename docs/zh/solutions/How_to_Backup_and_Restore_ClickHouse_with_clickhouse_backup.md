---
kind:
  - How To
products:
  - Alauda Container Platform
  - Alauda Application Services
ProductsVersion:
  - 4.3.x
id: KB260500067
sourceSHA: 9d1f066df63a6221c625b32a7fc219a1ac7747a7f62f86a36da02ac3892f393c
---

# 如何使用 clickhouse-backup 备份和恢复 ClickHouse

## 目的

本文档解释了如何使用 `clickhouse-backup` 边车和 S3 兼容对象存储在 Alauda 容器平台上备份和恢复由 ClickHouse Operator 部署的 ClickHouse 实例。

操作步骤包括：

- 使用 `clickhouse-backup` 边车部署 ClickHouse。
- 在 S3 兼容存储中创建远程备份。
- 从 Kubernetes Job 或 CronJob 运行备份。
- 将备份恢复到单独的 ClickHouseInstallation。
- 验证恢复的表包含预期的数据。

## 解决方案

### 1. 概述

`clickhouse-backup` 作为边车在 ClickHouse Pod 中运行。它通过 `localhost:9000` 连接到 ClickHouse，冻结 MergeTree 表的部分，写入备份元数据，并将备份上传到 S3 兼容存储。

为了使此工作流正确备份表数据，边车必须在 `/var/lib/clickhouse` 挂载与主 `clickhouse` 容器相同的 ClickHouse 数据卷。如果边车看不到 ClickHouse 数据目录，备份可能仅包含元数据文件。

分布式表仅作为模式备份。实际数据存储在底层的 MergeTree 家族本地表中，例如 `events_local`。

### 2. 先决条件

在开始之前准备以下项目：

| 项目                                | 描述                                          | 示例                                   |
| ----------------------------------- | --------------------------------------------- | -------------------------------------- |
| 命名空间                           | ClickHouse 实例和 Job 的命名空间             | `<namespace>`                          |
| 源 ClickHouseInstallation 名称     | 源实例名称                                   | `<source-clickhouseinstallation-name>`  |
| 恢复 ClickHouseInstallation 名称   | 恢复实例名称                                 | `<restore-clickhouseinstallation-name>` |
| ClickHouse 集群名称                | ClickHouseInstallation 规格中的集群名称      | `<clickhouse-cluster-name>`            |
| 源 ClickHouse Pod 名称             | ClickHouse Operator 生成的源 Pod            | `<source-clickhouse-pod-name>`         |
| 源 ClickHouse 服务名称             | 源 Pod 或分片的服务                          | `<source-clickhouse-service-name>`     |
| 恢复 ClickHouse Pod 名称           | ClickHouse Operator 生成的恢复 Pod          | `<restore-clickhouse-pod-name>`        |
| 恢复 ClickHouse 服务名称           | 恢复 Pod 或分片的服务                        | `<restore-clickhouse-service-name>`    |
| S3 端点                            | S3 兼容对象存储端点                         | `http://<s3-host>:<s3-port>`           |
| S3 存储桶                          | 备份存储的存储桶                             | `<s3-bucket>`                          |
| S3 访问密钥                        | 存储桶的访问密钥                             | `<s3-access-key>`                      |
| S3 秘密密钥                        | 存储桶的秘密密钥                             | `<s3-secret-key>`                      |
| S3 凭证 Secret 名称                | 存储 S3 凭证的 Kubernetes Secret             | `<s3-credential-secret-name>`          |
| 备份 Job 名称                      | 用于创建备份的 Kubernetes Job                | `<backup-job-name>`                    |
| 备份 CronJob 名称                  | 用于定期备份的 Kubernetes CronJob            | `<backup-cronjob-name>`                |
| 恢复 Job 名称                      | 用于恢复备份的 Kubernetes Job                | `<restore-job-name>`                   |

为本文档中的命令设置本地变量。如果这些变量已经在您的 shell 中导出，下面的清单模板可以直接通过 `envsubst` 渲染。

使用显式变量列表与 `envsubst`。这可以防止 Job 脚本中的运行时变量，例如 `$BACKUP_NAME`、`$COMMAND` 和 `$STATUS`，在您的工作站上被替换。

```bash
export NAMESPACE="<namespace>"
export SOURCE_CHI="<source-clickhouseinstallation-name>"
export RESTORE_CHI="<restore-clickhouseinstallation-name>"
export CLUSTER_NAME="<clickhouse-cluster-name>"
export SOURCE_POD="<source-clickhouse-pod-name>"
export SOURCE_SERVICE="<source-clickhouse-service-name>"
export RESTORE_POD="<restore-clickhouse-pod-name>"
export RESTORE_SERVICE="<restore-clickhouse-service-name>"
export S3_ENDPOINT="http://<s3-host>:<s3-port>"
export S3_BUCKET="<s3-bucket>"
export S3_ACCESS_KEY="<s3-access-key>"
export S3_SECRET_KEY="<s3-secret-key>"
export S3_SECRET_NAME="<s3-credential-secret-name>"
export BACKUP_JOB_NAME="<backup-job-name>"
export BACKUP_CRONJOB_NAME="<backup-cronjob-name>"
export RESTORE_JOB_NAME="<restore-job-name>"
```

在运行备份工作流之前创建 S3 存储桶。

```bash
mc alias set backup-s3 "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
mc mb --ignore-existing "backup-s3/$S3_BUCKET"
```

### 3. 创建命名空间和 S3 凭证 Secret

```bash
kubectl create namespace "$NAMESPACE"

kubectl -n "$NAMESPACE" create secret generic "$S3_SECRET_NAME" \
  --from-literal=access-key="$S3_ACCESS_KEY" \
  --from-literal=secret-key="$S3_SECRET_KEY"
```

### 4. 使用备份边车部署 ClickHouse

创建 `clickhouse-source.yaml.tmpl`。该模板使用先决条件部分中定义的环境变量，并可以直接通过 `envsubst` 渲染。

```yaml
apiVersion: clickhouse.altinity.com/v1
kind: ClickHouseInstallation
metadata:
  name: ${SOURCE_CHI}
  namespace: ${NAMESPACE}
spec:
  configuration:
    clusters:
      - name: ${CLUSTER_NAME}
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
                  value: "false"
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
                  value: ${S3_ENDPOINT}
                - name: S3_BUCKET
                  value: ${S3_BUCKET}
                - name: S3_PATH
                  value: backup/shard-{shard}
                - name: S3_ACCESS_KEY
                  valueFrom:
                    secretKeyRef:
                      name: ${S3_SECRET_NAME}
                      key: access-key
                - name: S3_SECRET_KEY
                  valueFrom:
                    secretKeyRef:
                      name: ${S3_SECRET_NAME}
                      key: secret-key
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

注意：

- `ALLOW_EMPTY_BACKUPS="false"` 建议在生产环境中使用，因为当没有数据时会失败。仅在初始设置、CI、测试或预期为空数据库的可重用模板中将其设置为 `"true"`。
- `S3_DISABLE_SSL="true"` 禁用 S3 流量的 TLS，并在没有传输加密的情况下发送备份。仅在本地测试或受信任的隔离网络中使用。对于生产或不受信任的网络，将其设置为 `"false"` 或省略并为 S3 端点配置 TLS。
- 保留 Pod 模板中的 `clickhouse` 容器条目。如果省略，则生成的 Pod 可能仅包含边车容器。

应用清单并等待 Pod 准备就绪。

```bash
envsubst '${SOURCE_CHI} ${NAMESPACE} ${CLUSTER_NAME} ${S3_ENDPOINT} ${S3_BUCKET} ${S3_SECRET_NAME}' \
  < clickhouse-source.yaml.tmpl > clickhouse-source.yaml

kubectl apply -f clickhouse-source.yaml
kubectl -n "$NAMESPACE" wait --for=condition=Ready pod/"$SOURCE_POD" --timeout=10m
kubectl -n "$NAMESPACE" get pod "$SOURCE_POD"
```

Pod 必须显示两个就绪容器。

```text
NAME                           READY   STATUS
<source-clickhouse-pod-name>   2/2     Running
```

验证备份集成表是否已创建。

```bash
kubectl -n "$NAMESPACE" exec "$SOURCE_POD" -c clickhouse -- \
  clickhouse-client -q "SHOW TABLES FROM system LIKE 'backup_%'"
```

预期输出包括：

```text
backup_actions
backup_list
backup_version
```

### 5. 插入测试数据

创建一个本地 MergeTree 表和一个分布式表。

```bash
kubectl -n "$NAMESPACE" exec "$SOURCE_POD" -c clickhouse -- \
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
    ENGINE = Distributed('$CLUSTER_NAME', default, events_local, rand());

    INSERT INTO events_local
    SELECT today(), rand() % 3, number, 'backup test' FROM numbers(1000);

    SELECT count() FROM events_local;
  "
```

预期计数为：

```text
1000
```

确认 ClickHouse 为本地表创建了活动数据部分。

```bash
kubectl -n "$NAMESPACE" exec "$SOURCE_POD" -c clickhouse -- \
  clickhouse-client -q "
    SELECT table, sum(rows), sum(bytes_on_disk)
    FROM system.parts
    WHERE database = 'default' AND table = 'events_local' AND active
    GROUP BY table
  "
```

### 6. 手动创建并上传备份

`create_remote` 命令在一步中创建本地备份并将其上传到配置的远程存储。

```bash
BACKUP_NAME="full-$(date +%Y%m%d%H%M%S)"

kubectl -n "$NAMESPACE" exec "$SOURCE_POD" -c clickhouse-backup -- \
  clickhouse-backup create_remote "$BACKUP_NAME"
```

从边车列出备份。

```bash
kubectl -n "$NAMESPACE" exec "$SOURCE_POD" -c clickhouse-backup -- \
  clickhouse-backup list | grep "$BACKUP_NAME"
```

预期输出包含本地和远程条目。

```text
<backup-name>   ...   local    regular
<backup-name>   ...   remote   tar, regular
```

验证远程存储包含元数据和数据部分对象。

```bash
mc find "backup-s3/$S3_BUCKET/backup/shard-0/$BACKUP_NAME" --maxdepth 5
```

预期对象包括 MergeTree 数据部分的 `shadow` 路径。

```text
backup/shard-0/<backup-name>/metadata.json
backup/shard-0/<backup-name>/metadata/default/events.json
backup/shard-0/<backup-name>/metadata/default/events_local.json
backup/shard-0/<backup-name>/shadow/default/events_local/default_202605_1_1_0.tar
```

### 7. 从 Kubernetes Job 运行备份

边车公开了 `system.backup_actions`。这允许从 Kubernetes Job 自动化备份，该 Job 只需要 `clickhouse-client` 对 ClickHouse 服务的网络访问。

创建 `clickhouse-backup-job.yaml.tmpl`。仅用 `envsubst` 渲染清单变量；不要在 Job 脚本中渲染运行时变量，例如 `$BACKUP_NAME`、`$COMMAND` 或 `$STATUS`。

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: ${BACKUP_JOB_NAME}
  namespace: ${NAMESPACE}
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
              value: ${SOURCE_SERVICE}
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

应用并验证 Job。

```bash
envsubst '${BACKUP_JOB_NAME} ${NAMESPACE} ${SOURCE_SERVICE}' \
  < clickhouse-backup-job.yaml.tmpl > clickhouse-backup-job.yaml

kubectl apply -f clickhouse-backup-job.yaml
kubectl -n "$NAMESPACE" wait --for=condition=complete job/"$BACKUP_JOB_NAME" --timeout=20m
kubectl -n "$NAMESPACE" logs job/"$BACKUP_JOB_NAME"
```

### 8. 使用 CronJob 安排备份

在手动 Job 成功后，使用相同的命令体创建一个 CronJob。

创建 `clickhouse-backup-cronjob.yaml.tmpl`，并仅用 `envsubst` 渲染清单变量。

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${BACKUP_CRONJOB_NAME}
  namespace: ${NAMESPACE}
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
                  value: ${SOURCE_SERVICE}
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

渲染并应用 CronJob。

```bash
envsubst '${BACKUP_CRONJOB_NAME} ${NAMESPACE} ${SOURCE_SERVICE}' \
  < clickhouse-backup-cronjob.yaml.tmpl > clickhouse-backup-cronjob.yaml

kubectl apply -f clickhouse-backup-cronjob.yaml
```

对于多分片集群，每个分片对一个副本服务运行相同的命令，并为每个分片使用唯一的 `S3_PATH` 或备份名称。

### 9. 创建恢复 ClickHouse 实例

创建另一个具有相同边车和 S3 配置的 ClickHouseInstallation。使用不同的实例名称。

通过复制 `clickhouse-source.yaml.tmpl` 创建 `clickhouse-restore.yaml.tmpl`，并将元数据名称变量从 `${SOURCE_CHI}` 更改为 `${RESTORE_CHI}`。然后渲染模板。

```bash
envsubst '${RESTORE_CHI} ${NAMESPACE} ${CLUSTER_NAME} ${S3_ENDPOINT} ${S3_BUCKET} ${S3_SECRET_NAME}' \
  < clickhouse-restore.yaml.tmpl > clickhouse-restore.yaml

kubectl apply -f clickhouse-restore.yaml
kubectl -n "$NAMESPACE" wait --for=condition=Ready pod/"$RESTORE_POD" --timeout=10m
```

### 10. 恢复备份

使用第 6 步或第 7 步中的备份名称。

```bash
BACKUP_NAME="<backup-name>"

kubectl -n "$NAMESPACE" exec "$RESTORE_POD" -c clickhouse-backup -- \
  clickhouse-backup restore_remote "$BACKUP_NAME"
```

相同的恢复可以通过 `system.backup_actions` 自动化。

创建 `clickhouse-restore-job.yaml.tmpl`。将 `BACKUP_NAME` 设置为第 6 步或第 7 步中创建的备份，并仅用 `envsubst` 渲染清单变量。

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: ${RESTORE_JOB_NAME}
  namespace: ${NAMESPACE}
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
              value: ${RESTORE_SERVICE}
            - name: CLICKHOUSE_PORT
              value: "9000"
            - name: RESTORE_BACKUP
              value: ${BACKUP_NAME}
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

应用并验证恢复 Job。

```bash
envsubst '${RESTORE_JOB_NAME} ${NAMESPACE} ${RESTORE_SERVICE} ${BACKUP_NAME}' \
  < clickhouse-restore-job.yaml.tmpl > clickhouse-restore-job.yaml

kubectl apply -f clickhouse-restore-job.yaml
kubectl -n "$NAMESPACE" wait --for=condition=complete job/"$RESTORE_JOB_NAME" --timeout=20m
kubectl -n "$NAMESPACE" logs job/"$RESTORE_JOB_NAME"
```

### 11. 验证恢复的数据

```bash
kubectl -n "$NAMESPACE" exec "$RESTORE_POD" -c clickhouse -- \
  clickhouse-client -mn --query "
    SHOW TABLES;
    SELECT count() FROM events_local;
    SELECT count() FROM events;
  "
```

预期输出：

```text
events
events_local
1000
1000
```

### 12. 故障排除

#### Pod 仅显示一个容器

如果 Pod 显示 `1/1` 且仅存在 `clickhouse-backup` 容器，则自定义 Pod 模板替换了默认的 ClickHouse 容器。将 `- name: clickhouse` 容器条目添加到 Pod 模板中。

```bash
kubectl -n "$NAMESPACE" get pod "$SOURCE_POD"
```

#### 备份仅包含元数据文件

检查两个容器是否在 `/var/lib/clickhouse` 挂载相同的卷。

```bash
kubectl -n "$NAMESPACE" get pod "$SOURCE_POD" -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{range .volumeMounts[*]}{.name}{" -> "}{.mountPath}{"\n"}{end}{end}'
```

有效的数据备份在 S3 中包含 `shadow/...tar` 对象。仅包含 `metadata/*.json` 对象的备份是仅模式或无法看到 ClickHouse 数据目录。

```bash
mc find "backup-s3/$S3_BUCKET/backup/shard-0/<backup-name>" --maxdepth 5
```

#### 备份集成表不存在

检查 `clickhouse-backup` 容器日志。

```bash
kubectl -n "$NAMESPACE" logs "$SOURCE_POD" -c clickhouse-backup --tail=100
```

还要确认 `API_CREATE_INTEGRATION_TABLES` 设置为 `true`。

#### 分布式表数据未包含

这是预期的。分布式表仅作为模式备份。备份和恢复底层的 MergeTree 家族本地表。

#### 恢复无法找到备份

确认恢复实例使用与源实例相同的 `S3_ENDPOINT`、`S3_BUCKET` 和 `S3_PATH`。

```bash
kubectl -n "$NAMESPACE" exec "$RESTORE_POD" -c clickhouse-backup -- \
  clickhouse-backup list
```

### 13. 验证结果

此操作步骤已在 Alauda 容器平台 4.3 环境中使用 ClickHouse Operator 4.3 和 `altinity/clickhouse-backup:2.6.3` 进行了验证。

验证结果：

- 源 Pod 运行了两个容器：`clickhouse` 和 `clickhouse-backup`。
- 两个容器挂载了相同的 `/var/lib/clickhouse` 卷。
- 创建了 `system.backup_actions`、`system.backup_list` 和 `system.backup_version`。
- `clickhouse-backup create_remote` 将元数据和 MergeTree 数据部分归档上传到 S3。
- `system.backup_actions` 成功触发了 `create_remote <backup-name>`。
- `clickhouse-backup restore_remote <backup-name>` 将备份恢复到单独的 ClickHouseInstallation。
- 恢复的 `events_local` 和 `events` 表均返回 `1000` 行。

## 相关信息

- `clickhouse-backup` 支持 MergeTree 家族表引擎的备份和恢复。
- 在验证备份时使用单独的恢复 ClickHouseInstallation，以避免修改源实例。
- 对于多分片集群，每个分片运行一次备份和恢复操作，并避免在多个副本上恢复相同的分片数据。
