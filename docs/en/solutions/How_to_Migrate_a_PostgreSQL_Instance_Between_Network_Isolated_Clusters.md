---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
id: KB260721001
---

# How to Migrate a PostgreSQL Instance Between Network-Isolated Clusters

## Background

### The Challenge

The streaming-replication migration described in the [PostgreSQL Instance Cross-Cluster Migration Guide](./How_to_Migrate_a_PostgreSQL_Instance_Across_Clusters.md) requires the target cluster to reach the source cluster's network. In many real deployments the clusters are network-isolated — separate platforms, firewalled sites, disconnected security zones — and no such path exists or can be opened.

### The Solution

When an administrator workstation can reach **both** Kubernetes API servers, the migration can be relayed through the workstation: `pg_dump` runs in the source pod, `pg_restore` runs in the target pod, and the data flows between them through two `kubectl exec` channels piped together on the workstation. The clusters never exchange a packet.

Because the transfer is logical (SQL-level), this method has no version-matching constraints: it works across different operator versions, different PostgreSQL major versions (same or newer on the target), and different CPU architectures.

**Trade-off:** unlike streaming replication, this is a point-in-time copy. Writes made on the source after the dump starts are not transferred — application writes must be stopped for the whole dump+restore window, so downtime equals the full copy duration.

## Environment Information

- PostgreSQL Operator: any 4.x version on each side (versions do **not** need to match)
- PostgreSQL: target major version equal to or newer than the source
- Workstation: `kubectl` access (kubeconfig/context) to both clusters

## Prerequisites

- Two kubeconfig contexts on the workstation, one per cluster; verify both work:

```bash
SRC_CTX="<source-context>";  SRC_NS="<source-namespace>";  SRC_CLUSTER="<source-instance-name>"
TGT_CTX="<target-context>";  TGT_NS="<target-namespace>";  TGT_CLUSTER="<target-instance-name>"

kubectl --context $SRC_CTX -n $SRC_NS get postgresql $SRC_CLUSTER
kubectl --context $TGT_CTX -n $TGT_NS get postgresql $TGT_CLUSTER 2>/dev/null || echo "target instance not created yet"
```

- Enough workstation bandwidth to both API servers for the database size (all data flows through the workstation).
- A maintenance window sized to the dump+restore duration.

## Step 1: Create the Target Instance

Create the target as a plain instance (no `clusterReplication`), sized like the source. Define the application databases and their owner users **in the CR spec** — the operator creates the roles and databases and manages their credentials; do not attempt to dump global objects (roles) from the source:

```yaml
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: acid-target          # $TGT_CLUSTER
  namespace: target-namespace
spec:
  teamId: acid
  numberOfInstances: 2
  postgresql:
    version: "16"            # same as source, or newer major
  users:
    appuser: []              # owner role for the migrated database
  databases:
    appdb: appuser           # database -> owner
  volume:
    size: 5Gi                # at least the source's data size
    storageClass: <target-storageclass>
```

Wait for status `Running`:

```bash
kubectl --context $TGT_CTX -n $TGT_NS get postgresql $TGT_CLUSTER \
  -o jsonpath='{.status.PostgresClusterStatus}{"\n"}'
```

## Step 2: Stop Writes and Take a Baseline

Stop application writes on the source, then record row counts (and, for stronger guarantees, per-table checksums) to compare after the restore:

```bash
SRC_POD=$(kubectl --context $SRC_CTX -n $SRC_NS get pod \
  -l spilo-role=master,cluster-name=$SRC_CLUSTER -o jsonpath='{.items[0].metadata.name}')

kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -d appdb -tA -c \
  "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;"
# Example per-table checksum:
#   SELECT count(*), sum(hashtext(id::text || payload)) FROM your_table;
```

## Step 3: Relay the Database Through the Workstation

Identify the target master pod and read the application user's password from the operator-managed secret, then run the pipe. One pipe per database:

```bash
TGT_POD=$(kubectl --context $TGT_CTX -n $TGT_NS get pod \
  -l spilo-role=master,cluster-name=$TGT_CLUSTER -o jsonpath='{.items[0].metadata.name}')

APP_PW=$(kubectl --context $TGT_CTX -n $TGT_NS get secret \
  appuser.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do \
  -o jsonpath='{.data.password}' | base64 -d)

PG_BIN=/usr/lib/postgresql/16/bin   # match the SOURCE server major (see notes)

kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
    $PG_BIN/pg_dump -U postgres -Fc --no-comments \
    -N metric_helpers -N user_management appdb \
| kubectl --context $TGT_CTX -n $TGT_NS exec -i $TGT_POD -c postgres -- \
    env PGPASSWORD="$APP_PW" \
    $PG_BIN/pg_restore -U appuser -h localhost -d appdb --no-owner -x
echo "pipe exit: $?"
```

The pipe must exit `0`. Command details — each flag below was added because omitting it produced a failing, noisy, or broken-permissions restore during validation:

- **Restore as the application user** (`-U appuser` with its password), not as `postgres`: with `--no-owner`, restored objects are owned by the connecting user. Restoring as `postgres` leaves every table owned by `postgres`, and the application user cannot even `SELECT` afterwards (`permission denied for table ...`). Restoring as the CR-defined owner lands the ownership correctly with no post-step.
- **Version-matched binaries** (`/usr/lib/postgresql/<major>/bin/`): the container's default `pg_dump` can be a newer major whose output (e.g. `SET transaction_timeout`) an older target server rejects. The images ship binaries for every supported major, so pick the path explicitly. When migrating to a *newer* target major, use the **target** major's `pg_dump` (also present in the source pod's image).
- **`--no-comments`**: the dump captures `COMMENT ON EXTENSION` for the extensions the image pre-installs (`pg_stat_statements`, `pg_stat_kcache`, `set_user`); executing those requires superuser, which the application user is not. Object comments are dropped — restore them separately as `postgres` if you rely on them.
- **`-N metric_helpers -N user_management`**: the operator image pre-creates these schemas in every database; without the exclusion the restore reports ~20 `already exists` errors.
- **`-x`**: skips ACL statements that reference roles managed by the source operator and absent on the target. Re-grant privileges for any additional (non-owner) users on the target afterwards.

### Large databases

A single pipe has no resume capability. For large databases, dump to a compressed file on the workstation first, then restore from it:

```bash
kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  $PG_BIN/pg_dump -U postgres -Fc --no-comments \
  -N metric_helpers -N user_management appdb > appdb.dump

kubectl --context $TGT_CTX -n $TGT_NS exec -i $TGT_POD -c postgres -- \
  env PGPASSWORD="$APP_PW" \
  $PG_BIN/pg_restore -U appuser -h localhost -d appdb --no-owner -x < appdb.dump
```

Parallel restore (`pg_restore -j N`) cannot read from stdin; to use it, copy the dump file into the target pod (`kubectl cp`) and restore from the local path.

## Step 4: Verify

Rerun the Step 2 queries on the target and compare — counts/checksums must match exactly:

```bash
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
  psql -U postgres -d appdb -tA -c \
  "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;"
```

Then confirm the application user can actually query its data with the target-managed credentials (this catches ownership mistakes immediately):

```bash
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
  env PGPASSWORD="$APP_PW" psql -U appuser -h localhost -d appdb -tA -c \
  "SELECT current_user, count(*) FROM <your-main-table>;"
```

## Step 5: Cut Over and Clean Up

- Repoint applications to the target instance's service and re-enable writes.
- Delete the source instance when satisfied. There is no replication configuration to tear down:

```bash
kubectl --context $SRC_CTX -n $SRC_NS delete postgresql $SRC_CLUSTER
# PVC retention depends on operator configuration — remove leftovers:
kubectl --context $SRC_CTX -n $SRC_NS delete pvc -l cluster-name=$SRC_CLUSTER --ignore-not-found
```

## Troubleshooting

### Application user gets `permission denied for table ...` after a successful restore

The restore was run as `postgres` instead of the application user, so all objects are owned by `postgres`. Either rerun the restore as the application user (Step 3), or transfer ownership in place:

```sql
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO appuser', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO appuser', r.sequencename);
  END LOOP;
END $$;
```

### Restore reports `must be owner of extension pg_stat_statements` (and similar)

`--no-comments` was omitted from `pg_dump`; the extension comments require superuser. The data restores fine — the errors only break the clean exit code. Rerun with `--no-comments` for a verifiable result.

### Restore reports `unrecognized configuration parameter "transaction_timeout"`

The dump was taken with a `pg_dump` newer than the target server (typically the image's default binary). Rerun using the explicit version-matched binary path (Step 3).

### Restore reports `schema "metric_helpers" already exists` (and similar)

The `-N metric_helpers -N user_management` exclusions were omitted. These errors are harmless for the excluded schemas' objects, but rerun with the exclusions for a clean, verifiable exit code.

### Rerunning after a failed restore

Drop and recreate the target database first — a partial restore leaves objects that collide (`relation already exists`, duplicate-key COPY failures). Note `DROP DATABASE` must be executed as its own single statement:

```bash
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- psql -U postgres -c "DROP DATABASE appdb"
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- psql -U postgres -c "CREATE DATABASE appdb OWNER appuser"
```

### Pipe is slow

Throughput is bounded by the workstation's link to both API servers (every byte traverses it twice: exec stream in, exec stream out). Run the relay from a machine with good connectivity to both platforms (e.g. a jump host), or use the file-based variant to at least make progress resumable.
