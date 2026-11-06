---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
  - 4.x
id: KB260500095
---

# Migrate Redis Data Across Kubernetes Clusters

:::info Applicable Versions
- Platform **4.x** with **redis-operator 5.1** or later. Redis 7.x sources need a redis-operator release later than **5.1.1**; see [Choose a Migration Mode](#choose-a-migration-mode).
- Platform **3.8.x – 3.16.x**: the procedure is the same, but you must set the image yourself and only Redis 5.x and 6.x are supported. See [Appendix: Platform 3.x](#appendix-platform-3x).
:::

## Introduction

This guide explains how to copy data from one Redis instance to another, including instances in different Kubernetes clusters, with the platform's built-in migration based on **RedisShake**. You describe a migration with one `RedisShake` custom resource, and redis-operator runs it. The source and the target can each be any of these architectures:

| Architecture | Description |
| --- | --- |
| `standalone` | Single-node Redis |
| `sentinel` | Sentinel-based primary/replica instance |
| `cluster` | Sharded Redis Cluster |

A `RedisShake` resource runs in one of two modes:

- **`sync`**: copies the full dataset, then keeps replicating every write made on the source. It never stops on its own; you end it by deleting the resource. Use it when the source must stay in service until cutover.
- **`rump`**: copies the keys once, by scanning the source, and then finishes. Writes made after a key was copied are not carried over. Use it when you can stop writes on the source for the whole copy.

## Choose a Migration Mode

| Source Redis | Target Redis | Mode |
| --- | --- | --- |
| 5.x or 6.x | 6.x or 7.2 | `sync` |
| 7.0 or 7.2 | 7.2 | `sync` on redis-operator later than 5.1.1; `rump` on earlier releases |
| 7.x | 5.x or 6.x | Not supported |
| 7.4 or later | Any | Not supported |

RedisShake added support for the RDB format of Redis 7.0 and 7.2 after redis-operator 5.1.1. What matters is the redis-operator in the cluster where you create the `RedisShake` resource, because the migration pod uses the RedisShake image delivered with that operator. With an earlier release there, a `sync` migration from a Redis 7.x source fails at once, the target stays empty, and the `redis-shake` container log shows:

```text
[PANIC] parse rdb header error
[error]: verify version, invalid RDB version number 11, 9
```

If you see this, either upgrade redis-operator or delete the resource and recreate it with `modelType: rump`.

## Prerequisites

1. **Capacity.** The target must have enough memory for the source dataset:
   - Sentinel target: at least **5/4 of the source dataset size**.
   - Cluster target with a standalone or Sentinel source: at least **5/4 of the source dataset size**.
   - Cluster target with a cluster source: at least **5/4 of the dataset size of the largest source shard**.
2. **Where the migration runs.** Create the `RedisShake` resource in a cluster where redis-operator is installed, usually the target cluster. The migration pod must reach both instances over a stable IPv4 network.
3. **External access.** An instance in a different cluster from the `RedisShake` resource must have NodePort or LoadBalancer access enabled:
   - Cluster instance: RedisShake connects to every shard at the address the shard announces, so in-cluster addresses do not work from another cluster.
   - Sentinel instance: enable external access for both the data nodes (`spec.expose.type`) and the Sentinel nodes (`spec.sentinel.expose.type`). RedisShake asks Sentinel for the primary's address and then connects to that primary.
4. **Databases.** A Redis Cluster has only database 0. When the target is a cluster, keys in other databases of the source are **skipped without any error**. Run `INFO keyspace` on the source and make sure every key is in `db0` before you migrate to a cluster.
5. **Redis functions.** Function libraries (Redis 7 `FUNCTION LOAD`) are not migrated. Load them on the target separately, for example with `FUNCTION DUMP` on the source and `FUNCTION RESTORE` on the target.
6. **Writes.** Reduce writes on the source to lower replication pressure. With `rump`, stop writes for the whole copy.

## Migration Procedure

### 1. Create the Password Secrets

If a side is password-protected, create one Secret for it, with the data key `password`, in the namespace where you create the `RedisShake` resource:

```bash
kubectl -n <namespace> create secret generic <secret-name> \
  --from-literal=password=<password>
```

### 2. Find the Addresses

Find the access endpoints in **Data Services > Instance Detail > Access Method > In-cluster Access / External Access**, then write each address in the format for its architecture and role:

| Architecture | As source | As target |
| --- | --- | --- |
| `standalone` | `<host>:<port>` | `<host>:<port>` |
| `sentinel` | `mymaster@<sentinel-host>:<sentinel-port>` | `mymaster@<sentinel-host>:<sentinel-port>` |
| `cluster` | `master@<host>:<port>` | `<host>:<port>` |

- For a Sentinel instance, use the **Sentinel** endpoint. `mymaster` is the primary name the platform gives every Sentinel instance.
- For a cluster instance, any one node endpoint is enough: RedisShake discovers the other shards. Only a cluster **source** takes the `master@` prefix.

:::warning
If the Sentinel nodes of an instance have their own password (`spec.sentinel.passwordSecret`), the `mymaster@` address does not work on either side: RedisShake cannot authenticate to Sentinel and the log shows `no sentinels available; last error: NOAUTH Authentication required.` Connect to the data nodes directly instead. Set `type: standalone`, use the Secret of the **data node** password, and use the external address of the read-write Service `rfr-<instance-name>-read-write`. To read its NodePort:

```bash
kubectl -n <instance-namespace> get svc rfr-<instance-name>-read-write \
  -o jsonpath='{.spec.ports[0].nodePort}'
```
:::

### 3. Create the RedisShake Resource

```yaml
apiVersion: middle.alauda.cn/v1alpha1
kind: RedisShake
metadata:
  name: <migration-name>
  namespace: <namespace>
spec:
  modelType: sync            # or rump, see "Choose a Migration Mode"
  keyExists: rewrite         # overwrite keys that already exist on the target
  source:
    type: sentinel           # standalone, sentinel or cluster
    address:
      - "mymaster@<source-sentinel-host>:<source-sentinel-port>"
    passwordSecret: <source-password-secret>
  target:
    type: cluster            # standalone, sentinel or cluster
    address:
      - "<target-host>:<target-port>"
    passwordSecret: <target-password-secret>
  resources:                 # optional
    requests:
      cpu: "2"
      memory: 2Gi
    limits:
      cpu: "4"
      memory: 4Gi
```

- Change `source` and `target` for your scenario, using the address formats from step 2.
- Leave out `image`: redis-operator 5.1 and later use the RedisShake image delivered with the operator.
- `keyExists` also accepts `ignore`, which keeps the target's value, and `none`, which stops the migration at the first key that already exists on the target. `none` is the default.
- Without `resources`, the migration pod gets 500m CPU and 500Mi memory, with limits of 1 CPU and 1Gi. For large datasets, allocate 2–8 CPU; 4 is a good starting point.

Apply the file with `kubectl apply -f`, or create the resource in the platform UI. redis-operator then creates the workload `<migration-name>-shake`: a Deployment for `sync`, or a Job for `rump`.

### 4. Monitor the Migration

Check the migration pod and its log:

```bash
kubectl -n <namespace> get pods | grep <migration-name>-shake
kubectl -n <namespace> logs deploy/<migration-name>-shake -c redis-shake --tail=50   # sync
kubectl -n <namespace> logs job/<migration-name>-shake -c redis-shake --tail=50      # rump
```

- **`sync`**: the log line `DbSyncer[0] sync rdb done` means the full copy has finished and incremental replication has started. With a cluster source there is one `DbSyncer` per source shard.
- **`rump`**: the Job completes, and the log ends with `all rumpers finish!`.

A `sync` migration also exposes Prometheus metrics on port 9320:

```bash
kubectl get --raw "/api/v1/namespaces/<namespace>/pods/<pod-name>:9320/proxy/metrics" \
  | grep -E 'redisshake_(full_sync_process_percent|fake_slave_delay_offset)'
```

| Metric | Meaning |
| --- | --- |
| `redisshake_full_sync_process_percent` | Progress of the full copy; `100` when it is done. One series per source shard, labelled `db_syncer`. |
| `redisshake_fake_slave_delay_offset` | How far the target lags behind the source, in bytes. Replication heartbeats keep it moving between `0` and about 150 even with no writes; the target has caught up when it keeps returning to `0` while writes are paused. |

redis-operator also creates a ServiceMonitor named `redis-shake` in its own namespace, so the platform Prometheus can collect these metrics. No Grafana dashboard is shipped for them.

### 5. Verify the Data

With writes paused on the source, compare the key counts on both sides. Use the `REDISCLI_AUTH` environment variable so the password does not appear on the command line:

```bash
# standalone or Sentinel: run against the primary
REDISCLI_AUTH=<password> redis-cli -h <host> -p <port> dbsize

# cluster: prints one line per primary; add them up
REDISCLI_AUTH=<password> redis-cli --cluster call <host>:<port> dbsize --cluster-only-masters
```

Keys with an expiry time can make the counts differ slightly, because each side expires keys on its own schedule.

### 6. Cut Over and Clean Up

1. Pause writes on the source.
2. For `sync`, wait until `redisshake_fake_slave_delay_offset` settles at `0`, then compare the key counts again.
3. Point the applications at the target.
4. Delete the resource. This removes the Deployment or Job, its ConfigMaps and its Service:

   ```bash
   kubectl -n <namespace> delete redisshake <migration-name>
   ```

5. Delete the password Secrets if you no longer need them.

## Changing a Running Migration

Edits to a running `RedisShake` resource only partly take effect:

- **Applied**: fields of the migration pod, such as `resources`, `nodeSelector`, `tolerations` and `affinity`. redis-operator updates the Deployment and the pod restarts.
- **Ignored**: `source`, `target`, `filter`, `keyExists`, `parallel` and the other migration settings. They are written into a ConfigMap only when the resource is created.

To change a migration setting, delete the resource and create it again. A `rump` Job is never updated; to run it again, delete and recreate the resource.

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| `invalid RDB version number 11, 9` (or `10, 9`) in the `redis-shake` log, and the container restarts | The RedisShake image predates Redis 7.x support | Upgrade redis-operator to a release later than 5.1.1, or use `modelType: rump` |
| `no sentinels available; last error: NOAUTH Authentication required.` | The Sentinel nodes have their own password | Connect to the data nodes directly, as described in step 2 |
| `target key name is busy` and the container restarts | `keyExists` is `none`, and the key already exists on the target | Set `keyExists: rewrite` or `ignore`, or empty the target first |
| `spec.template.spec.containers[0].image: Required value` in the operator log, and no migration pod | redis-operator earlier than 5.1 does not fill in the image | Set `spec.image` to the RedisShake image of your release |
| The `shake-init` container log shows `Could not connect to Redis at mymaster@...: Name does not resolve` | The init script also tries the Sentinel-style address as a host name | None needed; this message is harmless |
| Keys from databases other than 0 are missing on a cluster target | Redis Cluster has only database 0 | Move the keys to database 0 on the source before migrating |

## Important Considerations

- **Replication never stops automatically.** A `sync` migration keeps running until you delete the resource. Always verify before cutover.
- **Consumer groups on a cluster target.** Consumer groups that exist on the source when the migration starts are copied with their streams. But `XGROUP` commands run on the source *during* a migration to a cluster target can be sent to the wrong shard, so a group created then may be missing on the target, with no error. Create consumer groups before you start, or recreate them on the target after cutover.
- **No Redis 7.4 or later.** Their RDB format is not supported, and the migration stops at once.
- **No migration to an older Redis.** A Redis 7.x source cannot be migrated to a 5.x or 6.x target.
- **Network stability.** Persistent network instability between the two sides causes replication restarts and growing lag. Make sure the connection is stable before you start.

## Appendix: Platform 3.x

On platform 3.8.x – 3.16.x, the procedure above applies with these differences.

**Set the image.** Add `spec.image` to the resource, using the image for your platform version:

| ACP Version | RedisShake Image |
| --- | --- |
| 3.8.1 - 3.8.3 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2` |
| 3.10.1 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2` |
| 3.10.2, 3.10.3 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.3` |
| 3.12.1 - 3.12.3 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-5ad6d091` |
| 3.14.1, 3.14.2 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-063e3b5d` |
| 3.16.1 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-9bb65a7b` |
| 3.16.2 | `build-harbor.alauda.cn/middleware/redis-shake:v3.8.2-3777a73b` |

**Redis versions.** Only Redis 5.x and 6.x sources and targets are supported.

**Monitoring.** From 3.10.2, the Grafana dashboard **"Redis Shake Dashboard"** is available under **Platform Management > Operations Center > Monitoring > Grafana > Dashboards**. Its panel `SyncProcessPercent` reaches `100` when the full copy is done, and `SlaveDelayOffset` returns to `0` when the target has caught up. Before 3.10.2 there is no dashboard; compare key counts instead.

**Known issue.** On 3.16.0 and 3.16.1, when the source is a Sentinel instance, the source instance status may be reported as `Processing` even though the instance is healthy. This is fixed in 3.16.2.
