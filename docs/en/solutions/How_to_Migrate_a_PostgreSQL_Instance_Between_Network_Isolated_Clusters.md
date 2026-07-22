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

Because the transfer is logical (SQL-level), this method has no same-version requirement: it works across different operator versions, across CPU architectures, and from an older PostgreSQL major to the same or a newer major on the target. Migrating to an **older** PostgreSQL major (a downgrade) is not supported.

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
- Sufficient Kubernetes permissions in both namespaces: `get` on `postgresqls.acid.zalan.do`, `pods`, and `secrets`; `create` on `pods/exec`; plus `create` on `postgresqls` (target side) and, for the final cleanup, `delete` on `postgresqls` and `persistentvolumeclaims` (source side).
- The commands assume the operator's standard Spilo image: pod labels `spilo-role`/`cluster-name`, database container named `postgres`, and client binaries for every supported major under `/usr/lib/postgresql/<major>/bin/`. Custom or non-Spilo images require adapting these labels and paths.

## Step 1: Enumerate Source Databases and Create the Target Instance

An instance can hold several application databases, and **the whole procedure migrates one database at a time**. First list what the source actually holds:

```bash
SRC_POD=$(kubectl --context $SRC_CTX -n $SRC_NS get pod \
  -l spilo-role=master,cluster-name=$SRC_CLUSTER -o jsonpath='{.items[0].metadata.name}')

kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -tA -c \
  "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database
   WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1;"
```

Every database in this list must be declared in the target CR below (`spec.databases`, with its owner in `spec.users`), and Steps 2–4 are then **repeated once per database**, substituting the database name and owner each round. The examples throughout use a single database `appdb` owned by `appuser`. The `postgres` maintenance database is managed by the operator/image on each side and is not migrated.

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

## Step 2: Stop Writes, Inventory Extensions, and Take a Baseline

Run Steps 2–4 once per database from the Step 1 list; the commands below use `appdb`. Stop application writes on the source, then record **exact** row counts (and, for stronger guarantees, per-table checksums) to compare after the restore. Do not use `pg_stat_user_tables.n_live_tup` for this comparison — it is a planner statistics *estimate*, not an exact count:

```bash
# Exact row count of every user table:
kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -d appdb -tA -c \
  "SELECT relname, (xpath('/row/c/text()', query_to_xml(format(
     'SELECT count(*) AS c FROM %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint
   FROM pg_stat_user_tables ORDER BY relname;"
# Example per-table checksum:
#   SELECT count(*), sum(hashtext(id::text || payload)) FROM your_table;
```

Also inventory the extensions the database uses — extension creation typically requires superuser, so any extension that the image does not pre-install must be created on the target ahead of the restore (Step 3):

```bash
kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -d appdb -tA -c "SELECT extname, extversion FROM pg_extension ORDER BY 1;"
```

## Step 3: Relay the Database Through the Workstation

Identify the target master pod, and pre-create (as `postgres`) any extension from the Step 2 inventory that is not already present on the target — the restore runs as the application user, which cannot create extensions:

```bash
TGT_POD=$(kubectl --context $TGT_CTX -n $TGT_NS get pod \
  -l spilo-role=master,cluster-name=$TGT_CLUSTER -o jsonpath='{.items[0].metadata.name}')

kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
  psql -U postgres -d appdb -tA -c "SELECT extname FROM pg_extension ORDER BY 1;"
# For each extension the source has but the target lacks (requires the extension
# packages to be present in the target image):
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
  psql -U postgres -d appdb -c "CREATE EXTENSION IF NOT EXISTS <extname>;"
```

Read the application user's password from the operator-managed secret, then run the pipe — in a shell with `pipefail` set, otherwise a source-side `pg_dump`/`kubectl` failure is masked by the exit status of the last command. This transfers **one database**; run it once per database from the Step 1 list, substituting the database name and its owner user (in the secret name, `-U`, and `-d`) each time:

```bash
APP_PW=$(kubectl --context $TGT_CTX -n $TGT_NS get secret \
  appuser.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do \
  -o jsonpath='{.data.password}' | base64 -d)

PG_BIN=/usr/lib/postgresql/16/bin   # match the SOURCE server major (see notes)

set -o pipefail
kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
    $PG_BIN/pg_dump -U postgres -Fc --no-comments \
    -N metric_helpers -N user_management appdb \
| kubectl --context $TGT_CTX -n $TGT_NS exec -i $TGT_POD -c postgres -- \
    env PGPASSWORD="$APP_PW" \
    $PG_BIN/pg_restore -U appuser -h localhost -d appdb --no-owner -x
echo "pipe exit: $? (dump=${PIPESTATUS[0]}, restore=${PIPESTATUS[1]})"
```

The pipe must exit `0` (with `pipefail`, a non-zero status from *either* side surfaces; `PIPESTATUS` shows which side failed). Command details — each flag below was added because omitting it produced a failing, noisy, or broken-permissions restore during validation:

- **Restore as the application user** (`-U appuser` with its password), not as `postgres`: with `--no-owner`, restored objects are owned by the connecting user. Restoring as `postgres` leaves every table owned by `postgres`, and the application user cannot even `SELECT` afterwards (`permission denied for table ...`). Restoring as the CR-defined owner lands the ownership correctly with no post-step. **Scope note:** this pattern fits the operator's standard layout — one application database wholly owned by one CR-defined user. If your database has multiple owning roles, `SECURITY DEFINER` functions, or objects in non-`public` schemas with distinct owners, `--no-owner` collapses all ownership onto the connecting user; plan an explicit post-restore ownership and grant pass for those objects.
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

### Security notes

- While the restore runs, `$APP_PW` is expanded into the workstation's `kubectl` argument list and is visible in local process listings (`ps`). Run the relay from a trusted, single-user workstation, and do not enable shell tracing (`set -x`) around these commands. `unset APP_PW` when finished.
- A dump file is a full plaintext logical copy of the database. Create it with restrictive permissions (`umask 077` before dumping, or `chmod 600` immediately after), encrypt it at rest if your policy requires, and delete it once the migration is verified.
- The data itself only traverses the two TLS-protected `kubectl exec` channels; nothing is exposed on the network beyond the two Kubernetes API connections.

## Step 4: Verify

Rerun the Step 2 baseline queries on the target and compare — exact counts/checksums must match exactly:

```bash
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
  psql -U postgres -d appdb -tA -c \
  "SELECT relname, (xpath('/row/c/text()', query_to_xml(format(
     'SELECT count(*) AS c FROM %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint
   FROM pg_stat_user_tables ORDER BY relname;"
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

This block covers tables and sequences in the `public` schema only. Views, functions, types, and objects in other schemas need analogous `ALTER ... OWNER TO` statements (enumerate them via `pg_views`, `pg_proc`, `pg_type`, or `\dn`/`\df` in psql).

### Restore reports `permission denied to create extension ...`

The source database uses an extension that is not pre-installed on the target, and the application user cannot create it. Create the extension as `postgres` on the target database (Step 3 pre-create), then rerun the restore. If `CREATE EXTENSION` itself fails with a missing-file error, the extension's packages are not present in the target image at all — it must be added to the image/instance before this migration can carry that database.

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
