---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 4.x
---

# How to Migrate a Redis Sentinel Instance Across Kubernetes Clusters With an RDB Snapshot

## Introduction

This guide describes how to move a Sentinel-mode Redis instance to a different Kubernetes cluster while also changing the StorageClass or the underlying storage. The dataset is carried across as a Redis database snapshot (RDB) file, `/data/dump.rdb`: writes are frozen on the source, a final snapshot is taken, the file is copied into a freshly created target instance, and only after the data is verified are replicas restored and the client application switched over.

The target instance is deliberately created with a single Primary and no Replicas (`master: 1`, `slave: 0`) so that the imported snapshot is loaded exactly once and cannot be overwritten by a replication full sync before it has been checked.

:::info Applicable Version
Sentinel-mode instances managed by redis-operator **4.0 and later**, on both the source and the target cluster.
:::

:::note
This document uses "Primary" and "Replica" to refer to the main Redis node and its replicas. This is the current standard terminology, replacing the previously used "Master"/"Slave". The `master` and `slave` field names still appear in the `Redis` custom resource and in `redis-cli` output, and are kept verbatim where they are part of an API or command output.
:::

### When to Use This Procedure

Use this procedure when:

- The S3 object-storage backup and restore path is not available.
- Writes from the client application can be stopped for the duration of the migration window.
- The Redis version and configuration on the source and the target are compatible.

Do **not** use this procedure when a downtime window cannot be scheduled, or when the migration must be online and incremental. For a continuous-replication alternative, see [Migrate Redis Data Across Kubernetes Clusters](./How_to_Migrate_Redis_Across_Clusters.md), which uses RedisShake.

## Prerequisites

1. **Matching Redis version and configuration.** The source and target instances run the same Redis version with compatible configuration.
2. **Target capacity.** The target PVC is at least as large as the actual source dataset, and uses a StorageClass that exists in the new cluster.
3. **API access to both clusters.** The workstation running the procedure can reach the Kubernetes API of both the old and the new cluster, with a `kubectl` context configured for each.
4. **`tar` in the Redis container.** `kubectl cp` requires `tar` to be present inside the container. Verify this before the migration window starts.

:::warning
Create the target instance with the **RDB parameter template**, not the AOF template. When `appendonly yes` is active, Redis loads the AOF file on startup and ignores `dump.rdb`, so the imported snapshot produces an empty dataset. See [Backup and Restore Compatibility With Parameter Templates](./Backup_Restore_Template_Compatibility.md) for the loading rules and for the procedure to re-enable AOF after the data is verified.
:::

## Migration Procedure

Replace the cluster context, namespace, pod names, and authentication arguments in the commands below to match your environment. The examples use `-a $REDIS_PASSWORD`, which resolves inside the Redis container; pass the password explicitly if the variable is not set in your environment.

### 1. Stop Writes From the Client Application

Stop every component that can write to Redis. For a GitLab deployment this includes Puma, Sidekiq, and any other worker that holds a Redis connection. Confirm that all of them are stopped **before** generating the final snapshot — a write that lands after `BGSAVE` will not be part of the migrated dataset.

### 2. Record the Source Keyspace

Use `INFO keyspace` to record the number of keys and the number of keys with an expiration for each logical database. This is the baseline you compare against after the import.

```bash
kubectl --context <source-context> -n <namespace> exec <source-pod> -c redis -- \
  redis-cli -a $REDIS_PASSWORD INFO keyspace
```

### 3. Generate the Final RDB Snapshot

```bash
kubectl --context <source-context> -n <namespace> exec <source-pod> -c redis -- \
  redis-cli -a $REDIS_PASSWORD BGSAVE

kubectl --context <source-context> -n <namespace> exec <source-pod> -c redis -- \
  redis-cli -a $REDIS_PASSWORD INFO persistence
```

Do not continue until `INFO persistence` reports both of the following:

```text
rdb_bgsave_in_progress:0
rdb_last_bgsave_status:ok
```

### 4. Export the RDB File

```bash
kubectl --context <source-context> -n <namespace> cp \
  -c redis "<source-pod>:/data/dump.rdb" ./dump.rdb

sha256sum ./dump.rdb
```

Record the file size and the SHA-256 checksum.

### 5. Create the Target Instance

Install redis-operator 4.0 or later in the new cluster, then create a Sentinel-mode Redis instance using the RDB parameter template and the new StorageClass. The replica counts must be set as follows:

```yaml
spec:
  replicas:
    sentinel:
      master: 1
      slave: 0
```

Wait until `rfr-<instance-name>-0` is Ready. The target instance must not receive any application traffic at this point.

### 6. Import the RDB File

```bash
kubectl --context <target-context> -n <namespace> cp \
  -c redis ./dump.rdb "rfr-<instance-name>-0:/data/dump.rdb"

kubectl --context <target-context> -n <namespace> exec "rfr-<instance-name>-0" -c redis -- \
  sha256sum /data/dump.rdb
```

The checksum inside the pod must match the one recorded in step 4. If it does not, copy the file again — do not proceed with a mismatched snapshot.

### 7. Recreate the Target Pod

Redis only reads `dump.rdb` at startup, so the pod must be restarted to load the imported file. Force-delete the pod to skip the `PreStop` hook, which would otherwise trigger a save and overwrite the file you just copied. The StatefulSet recreates `rfr-<instance-name>-0` on the same PVC.

```bash
kubectl --context <target-context> -n <namespace> delete pod "rfr-<instance-name>-0" \
  --grace-period=0 --force
```

Wait until the old container has definitively exited and the PVC mount is released, then confirm that the new pod starts on the original PVC and becomes Ready.

:::warning
Force deletion does not wait for the node to confirm that the old process has terminated. Do not run it when the node is unhealthy or the kubelet is unreachable — two processes writing the same PVC will corrupt the dataset.
:::

### 8. Verify the Imported Data

```bash
kubectl --context <target-context> -n <namespace> logs "rfr-<instance-name>-0" -c redis

kubectl --context <target-context> -n <namespace> exec "rfr-<instance-name>-0" -c redis -- \
  redis-cli -a $REDIS_PASSWORD INFO keyspace
```

Check that:

- The Redis log contains no RDB format, checksum, or load-failure errors.
- `INFO keyspace` matches the baseline recorded in step 2.
- Key expirations keep advancing during the migration, so the target may report slightly fewer keys than the source. A small shortfall accounted for by expired keys is expected; an unexplained gap is not.
- The application's critical Redis keys can be read back.

### 9. Restore Replicas and Switch the Application Over

Restore the replica count by editing the Redis custom resource. The example below returns the instance to two nodes:

```bash
kubectl --context <target-context> -n <namespace> patch \
  redis.middleware.alauda.io "<instance-name>" --type=merge \
  -p '{"spec":{"replicas":{"sentinel":{"master":1,"slave":1}}}}'
```

The operator scales the Redis StatefulSet to `master + slave` pods. The new `rfr-<instance-name>-1` pod is created with its own new PVC and performs a full sync from the current Primary. Wait for all pods to become Ready, then confirm the topology:

```text
# On the Primary — INFO replication
role:master
connected_slaves:<expected replica count>

# On each Replica — INFO replication
master_link_status:up
```

Finally, update the client application's Redis/Sentinel address, credentials, and logical database number, start the application, and run basic validation such as login, project access, and background job execution.

## Rollback

- Keep the source instance and its PVCs until the migration has been formally accepted.
- As long as the target has not accepted any writes, roll back by stopping the target instance and pointing the application back at the source Redis.
- Once the target has accepted new writes, the two datasets have diverged and a direct switch back is no longer safe. Stop writes first and handle the reverse migration as a separate exercise.

## Important Considerations

- **Freeze writes before `BGSAVE`, not after.** The snapshot is a point-in-time copy; anything written after it is lost on cutover.
- **Verify the checksum on both sides.** A truncated `kubectl cp` produces a file that Redis may partially load without an obvious error.
- **Do not skip the forced pod deletion.** A graceful delete runs the `PreStop` hook, which saves the in-memory (empty) dataset over the imported `dump.rdb`.
- **Keep the target at zero replicas until the data is verified.** Scaling out before verification propagates a bad dataset to the new Replicas through a full sync.
- **Use the RDB parameter template.** With the AOF template the imported snapshot is ignored on startup.
- **The Replica PVCs are new.** Restoring the replica count provisions fresh PVCs from the new StorageClass and populates them by full sync; the old cluster's volumes are never reused.
