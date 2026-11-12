---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "3.10"
  - "4.2"
  - "4.3"
---

# Harbor returns 500 when its PostgreSQL loses the Kubernetes API, cannot mount its volume, or has corrupt data

## Issue

Harbor returns HTTP 500, an image push returns 500 and keeps retrying, or image pulls fail because Harbor is unavailable. The client shows:

```text
received unexpected HTTP status: 500 Internal Server Error
Retrying in 5 seconds
```

Behind this, Harbor core cannot use its PostgreSQL database. One of the following is seen in `harbor-core`, in the `postgres` container of a Harbor PostgreSQL Pod, or in the Pod events:

```text
failed to update blob: sha256:... status to StatusNone, error:ERROR: cannot execute UPDATE in a read-only transaction (SQLSTATE 25006)
[FATAL] [/core/main.go:188]: failed to migrate: pq: cannot execute CREATE TABLE in a read-only transaction ...
ERROR: Error communicating with DCS
INFO: DCS is not accessible
MountVolume.MountDevice failed for volume "<pv-name>" : ... failed to create dir ".../globalmount": mkdir ... file exists
FATAL:  catalog is missing 1 attribute(s) for relid 2662
```

The registry log may show nothing obvious, and the registry storage (for example a highly available NAS) may have enough free space, so storage looks like the suspect even when it is not.

## Root Cause

### Cause 1: Patroni cannot reach the Kubernetes API (DCS), so PostgreSQL serves read-only transactions

The Harbor PostgreSQL instance runs Patroni, which stores its cluster state in the Kubernetes API (its DCS, distributed configuration store). When Patroni's requests to the API time out, its `postgres` container logs:

```text
ERROR: ObjectCache.run ApiException()
ERROR: get_cluster
patroni.utils.RetryFailedError: 'Exceeded retry deadline'
ERROR: Error communicating with DCS
INFO: DCS is not accessible
WARNING: Loop time exceeded, rescheduling immediately.
```

While Patroni cannot confirm leadership in the DCS, it keeps or demotes PostgreSQL to read-only. `harbor-core` then logs `cannot execute UPDATE in a read-only transaction (SQLSTATE 25006)`, or exits at startup with `failed to migrate: pq: cannot execute CREATE TABLE in a read-only transaction`, and Harbor returns 500. An image push may need several attempts before one succeeds.

The DCS errors may be on only one Pod of the instance: another Pod can still log `no action. i am the leader with the lock`. Read every Pod of the instance. Restarting `harbor-core` alone does not clear the 500. Restarting the Harbor PostgreSQL Pods, and then `harbor-core`, restores pushes.

The same DCS errors can also appear without any `read-only` line, with Harbor Pods Running and the portal reporting that the core service is unavailable. Restarting the Harbor PostgreSQL instance is the recovery in that case as well.

### Cause 2: a stale CSI global mount keeps the PostgreSQL Pod in ContainerCreating

After the Harbor `pg` Pod is deleted or restarted, it stays in `ContainerCreating`, and its events show:

```text
MountVolume.MountDevice failed for volume "<pv-name>" : kubernetes.io/csi: attacher.MountDevice failed to create dir "/var/lib/kubelet/plugins/kubernetes.io/csi/pv/<pv-name>/globalmount": mkdir ... file exists
Unable to attach or mount volumes: unmounted volumes=[pgdata] ... timed out waiting for the condition
```

The CSI global mount directory of the `pgdata` volume already exists on the node as a stale mount, so the kubelet cannot stage the volume. The PVCs are `Bound` and the storage backend (for example Ceph) can report healthy. Without the database the other Harbor components fail in turn:

```text
harbor-core            Init:0/1, then Init:Error
harbor-jobservice      failed to load rest config ... connect: connection refused
harbor-notary-server   Failed to Ping DB, sleep for 1 second. / Failed to connect DB after 30 seconds, time out.
harbor migrator        failed to connect to host=<harbor-pg>-pgpool2 ... dial error
```

Not every Harbor install has a `pgpool` Pod; where it exists it reaches PostgreSQL through a pgpool Service (port 9999).

### Cause 3: the PostgreSQL data is corrupt after the underlying storage was damaged

When the storage under the Harbor database (for example a Ceph cluster) is damaged, the database files can be corrupt. Notary reports that it cannot connect to the database, and the `postgres` container logs:

```text
ERROR: Exception when changing replication slots
psycopg2.errors.WrongObjectType: cannot open relation "pg_replication_slots"
ERROR libpq: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  catalog is missing 1 attribute(s) for relid 2662
WARNING [notary_signer]: default timeout
```

In standard PostgreSQL, OID 2662 is the `pg_class` OID index, so the damage is in the system catalog, not in a Harbor table. The Patroni leader can still look normal (`no action. i am the leader with the lock`), so the Pod list and the leader lock do not reveal this cause. Corruption of the system catalog cannot be repaired in place.

## Resolution

### Cause 1

1. Confirm the DCS errors on every Harbor PostgreSQL Pod and the `read-only` errors in core. The Patroni log is in the `postgres` container. Pod names vary between installs (for example `<release>-harbor-<id>-pg-0` or `acid-<cluster>-0`).

   ```bash
   PG_NS=<postgresql-namespace>
   for P in $(kubectl -n "$PG_NS" get pods -o name | grep -E -- '-pg-[0-9]+$|acid-'); do
     echo "== $P"
     kubectl -n "$PG_NS" logs "$P" -c postgres --tail=200 \
       | grep -E 'DCS is not accessible|Error communicating with DCS|get_cluster|Exceeded retry deadline|leader with the lock'
   done
   NS=<harbor-namespace>
   CORE=$(kubectl -n "$NS" get pods -o name | grep -- -core | head -1)
   kubectl -n "$NS" logs "$CORE" --tail=100 | grep -E 'read-only|SQLSTATE 25006|failed to migrate'
   kubectl -n "$NS" get harbor <harbor-name> -o jsonpath='{.spec.helmValues.database}{"\n"}'
   ```

   Continue only when a PostgreSQL Pod logs `Error communicating with DCS` or `DCS is not accessible`, or core logs `read-only` while the database host Harbor uses is the PostgreSQL Service name. If the database host is a single Pod IP and that Pod reports `t` for `SELECT pg_is_in_recovery();`, Harbor is pointed at a replica: fix the database address instead of restarting.

2. Restart the PostgreSQL Pods that log the DCS errors.

   > **Warning:** Only when Cause 1 is confirmed in step 1. Impact: deleting a PostgreSQL Pod restarts the database; Harbor cannot connect until the Pod is Ready, and restarting the primary fails over or recovers in place depending on the number of replicas. Precondition: a maintenance window. The StatefulSet recreates the Pod and the volume is kept; in-flight transactions are not recovered.

   ```bash
   kubectl -n "$PG_NS" delete pod <postgresql-pod>
   kubectl -n "$PG_NS" get pods -o wide -w
   ```

   When more than one Pod logs the DCS errors, delete them one at a time and wait for each to be Running before the next. If a `pgpool` Pod belongs to this database and is not Ready after PostgreSQL is up, delete that Pod too so it reconnects.

3. If Harbor still returns 500 or core still logs `read-only`, restart `harbor-core`.

   > **Warning:** Only when PostgreSQL is accepting connections again. Impact: in-flight Harbor API calls are dropped until the new core Pod is Ready. The Deployment recreates the Pod; nothing needs to be rolled back.

   ```bash
   CORE=$(kubectl -n "$NS" get deploy -o name | grep -- -core | head -1)
   kubectl -n "$NS" rollout restart "$CORE"
   kubectl -n "$NS" rollout status "$CORE"
   ```

4. Push the image again. It completes without `500 Internal Server Error`.

### Cause 2

1. Find the node and the volume the `pg` Pod cannot mount. The path to clean is the one printed in the `MountDevice failed` event.

   ```bash
   PG_NS=<postgresql-namespace>
   kubectl -n "$PG_NS" describe pod <pg-pod> | sed -n '/Events:/,$p'
   kubectl -n "$PG_NS" get pod <pg-pod> -o jsonpath='{.spec.nodeName}{"\n"}'
   kubectl -n "$PG_NS" get pvc -o wide
   ```

2. On that node, inspect the global mount directory named in the event. A stale mount is one that `findmnt` still shows, or where `stat` or `ls` returns an error, while no running Pod uses the volume.

   ```bash
   GM=/var/lib/kubelet/plugins/kubernetes.io/csi/pv/<pv-name>/globalmount
   findmnt "$GM"
   stat "$GM"
   ls -la "$GM"
   mount | grep -F <pv-name>
   ```

3. Clean up the stale mount.

   > **Warning:** Only when the `pg` Pod does not start, its events show `MountDevice failed ... globalmount: mkdir ... file exists` for this volume, and `findmnt` shows a stale mount for it on this node. Impact: `umount` detaches that mount. Precondition: the `pg` Pod is not running, no other Pod on the node uses the volume, and the path is not the PostgreSQL data directory (a directory that contains `PG_VERSION` is data, not a leftover mount point). Rollback: the kubelet mounts a healthy volume again when the Pod starts; do not remount it by hand. `rmdir` is only for an empty leftover directory and cannot be undone.

   ```bash
   sudo umount "$GM"
   # Only if the path is no longer a mount point and does not contain PG_VERSION:
   sudo rmdir "$GM"
   ```

4. Wait for the `pg` Pod to become Ready. If a `pgpool` Pod exists and is still not Ready, delete it so it reconnects. Core, jobservice, and Notary recover once the database is reachable.

### Cause 3

1. Confirm the corruption in the database log and save the Harbor resource:

   ```bash
   NS=<harbor-namespace>
   kubectl -n "$NS" logs <harbor-pg-pod> -c postgres --tail=200 \
     | grep -E 'catalog is missing|WrongObjectType|cannot open relation|PQconnectPoll'
   kubectl -n "$NS" get harbor <harbor-name> -o yaml > "$HOME/harbor-<harbor-name>-before-redeploy.yaml"
   ```

2. Look for a backup of the Harbor database (a scheduled dump or a volume snapshot). If one exists, restore it instead of redeploying onto an empty database. See [How to perform disaster recovery for Harbor](How_to_perform_disaster_recovery_for_harbor.md).

3. Without a backup, redeploy Harbor through the operator against a new PostgreSQL instance. Do not reuse the corrupt data directory.

   > **Warning:** Only when the database log shows the corruption signature (`catalog is missing ... attribute(s) for relid`, `cannot open relation "pg_replication_slots"`) and no restorable backup exists. Impact: the registry metadata in the corrupt database (projects, repositories, artifact records, users, and settings) is lost; image blobs on the registry storage are neither repaired nor deleted by the redeploy. Precondition: a maintenance window and the Harbor YAML saved in step 1. Rollback: re-apply the saved YAML only if you have a good database to point it at; pointing it back at the corrupt data returns the same failure.

4. After the new instance is Ready, configure regular backups for the Harbor database.

## Diagnostic Steps

```bash
kubectl get pods -A -o wide | grep -E 'harbor|acid-|pgpool'
NS=<harbor-namespace>
CORE=$(kubectl -n "$NS" get pods -o name | grep -- -core | head -1)
kubectl -n "$NS" logs "$CORE" --tail=80
kubectl -n "$NS" get harbor <harbor-name> -o jsonpath='{.spec.helmValues.database}{"\n"}'
```

Harbor workload names differ between installs (`<release>-harbor-core`, `harbor-<release>-core`); `grep -- -core` matches both. The last command shows the database host Harbor uses: a Service name with `SQLSTATE 25006` in core is Cause 1; a single Pod IP that is in recovery is a wrong database address, not this article.

| What you see | Cause |
| --- | --- |
| Patroni `Error communicating with DCS` / `DCS is not accessible`; core `read-only transaction (SQLSTATE 25006)` or `failed to migrate`; push 500 and `Retrying` | Cause 1 |
| `MountDevice failed ... globalmount: mkdir ... file exists`; `pg` Pod `ContainerCreating`; Notary `Failed to Ping DB` | Cause 2 |
| `catalog is missing 1 attribute(s) for relid 2662`; `cannot open relation "pg_replication_slots"`; the storage was damaged | Cause 3 |
| `too many clients already (SQLSTATE 53300)` | [Harbor PostgreSQL rejects sessions with too many clients already (SQLSTATE 53300)](Harbor_PostgreSQL_rejects_sessions_with_too_many_clients_already_SQLSTATE_53300.md) |
| The database Pod does not start | [Harbor PostgreSQL database Pod never starts after an operator upgrade, with transparent huge pages, low CPU, or on NFS](Harbor_PostgreSQL_database_Pod_never_starts_after_an_operator_upgrade_with_transparent_huge_pages_low_CPU_or_on_NFS.md) |
