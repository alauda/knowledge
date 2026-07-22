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

The procedure is four human operations: create the target instance (Step 1), stop application writes (Step 2), run the migration script (Step 3), and cut over (Steps 4–5). The script migrates **every** application database of the instance and verifies each one.

Because the transfer is logical (SQL-level), this method has no same-version requirement: it works across different operator versions, across CPU architectures, and from an older PostgreSQL major to the same or a newer major on the target. Migrating to an **older** PostgreSQL major (a downgrade) is not supported.

**Trade-off:** unlike streaming replication, this is a point-in-time copy. Writes made on the source after the dump starts are not transferred — application writes must be stopped for the whole dump+restore window, so downtime equals the full copy duration.

## Environment Information

- PostgreSQL Operator: any 4.x version on each side (versions do **not** need to match)
- PostgreSQL: target major version equal to or newer than the source
- Workstation: `bash` and `kubectl` access (kubeconfig/context) to both clusters

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

## Step 1: Create the Target Instance

List the application databases and owners the source actually holds:

```bash
SRC_POD=$(kubectl --context $SRC_CTX -n $SRC_NS get pod \
  -l spilo-role=master,cluster-name=$SRC_CLUSTER -o jsonpath='{.items[0].metadata.name}')

kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -tA -c \
  "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database
   WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1;"
```

Every CR-managed database in this list must be declared in the target CR (`spec.databases`, with its owner in `spec.users`) — the operator creates the roles and databases and manages their credentials; do not attempt to dump global objects (roles) from the source. The `postgres` maintenance database is managed by the operator/image on each side and is not migrated. Databases owned by `postgres` (created outside the CR spec) do not go into the CR — the migration script creates them on the target automatically.

The `users:`/`databases:` sections of the target CR can be generated directly from the source instead of hand-written:

```bash
{
  echo "  users:"
  kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
    psql -U postgres -tA -c \
    "SELECT DISTINCT '    ' || pg_get_userbyid(datdba) || ': []' FROM pg_database
     WHERE NOT datistemplate AND datname <> 'postgres' AND pg_get_userbyid(datdba) <> 'postgres';"
  echo "  databases:"
  kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
    psql -U postgres -tA -c \
    "SELECT '    ' || datname || ': ' || pg_get_userbyid(datdba) FROM pg_database
     WHERE NOT datistemplate AND datname <> 'postgres' AND pg_get_userbyid(datdba) <> 'postgres' ORDER BY 1;"
}
```

### Preserve application credentials

By default the target operator generates **new** passwords for the CR users, which would force every application to be re-configured at cutover. To keep the source passwords, copy each application user's credential secret into the target namespace **before creating the CR** — when the operator finds an existing credential secret, it adopts it and sets the role's password from it instead of generating a new one:

```bash
for SEC in $(kubectl --context $SRC_CTX -n $SRC_NS get secret \
    -l application=spilo,cluster-name=$SRC_CLUSTER -o name); do
  U=$(kubectl --context $SRC_CTX -n $SRC_NS get $SEC -o jsonpath='{.data.username}' | base64 -d)
  case "$U" in postgres|standby) continue ;; esac   # system users stay operator-managed
  PW=$(kubectl --context $SRC_CTX -n $SRC_NS get $SEC -o jsonpath='{.data.password}' | base64 -d)
  kubectl --context $TGT_CTX -n $TGT_NS create secret generic \
    "$U.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do" \
    --from-literal=username="$U" --from-literal=password="$PW"
done
```

The `postgres` and `standby` system users are deliberately skipped — they belong to each instance's own operator. The ordering matters: pre-stage the secrets first, then create the CR (see [Troubleshooting](#troubleshooting) if the CR was created first).

Create the target as a plain instance (no `clusterReplication`), sized like the source:

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
    appuser: []              # generated above
  databases:
    appdb: appuser           # generated above
  volume:
    size: 5Gi                # at least the source's data size
    storageClass: <target-storageclass>
```

Wait for status `Running`:

```bash
kubectl --context $TGT_CTX -n $TGT_NS get postgresql $TGT_CLUSTER \
  -o jsonpath='{.status.PostgresClusterStatus}{"\n"}'
```

## Step 2: Stop Writes

Stop application writes on the source — the transfer is a point-in-time copy, and anything written after the dump starts is lost.

The migration script (Step 3) records and compares exact per-table row counts automatically. For stronger guarantees on critical tables, additionally record per-table checksums now and re-check them in Step 4:

```bash
kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -d <database> -tA -c \
  "SELECT count(*), sum(hashtext(id::text || payload)) FROM <your_table>;"
```

## Step 3: Run the Migration Script

The script performs the whole migration in one run: it enumerates the source's application databases, creates any that are missing on the target (e.g. `postgres`-owned databases created outside the CR spec — their owner role must exist on the target), pre-creates each database's extensions, transfers each database as its owner, and verifies exact per-table row counts — reporting `PASS`/`FAIL` per database and exiting non-zero if anything failed.

Fill in the six variables at the top, then run it with `bash`:

```bash
#!/usr/bin/env bash
# Whole-instance PostgreSQL migration relayed through the workstation.
# Migrates every application database of $SRC_CLUSTER into $TGT_CLUSTER.
set -u -o pipefail

SRC_CTX="<source-context>";  SRC_NS="<source-namespace>";  SRC_CLUSTER="<source-instance-name>"
TGT_CTX="<target-context>";  TGT_NS="<target-namespace>";  TGT_CLUSTER="<target-instance-name>"

SRC_POD=$(kubectl --context "$SRC_CTX" -n "$SRC_NS" get pod \
  -l spilo-role=master,cluster-name="$SRC_CLUSTER" -o jsonpath='{.items[0].metadata.name}')
TGT_POD=$(kubectl --context "$TGT_CTX" -n "$TGT_NS" get pod \
  -l spilo-role=master,cluster-name="$TGT_CLUSTER" -o jsonpath='{.items[0].metadata.name}')

srcsql() { local db=$1; shift; kubectl --context "$SRC_CTX" -n "$SRC_NS" exec "$SRC_POD" -c postgres -- psql -U postgres -d "$db" -tA -v ON_ERROR_STOP=1 "$@"; }
tgtsql() { local db=$1; shift; kubectl --context "$TGT_CTX" -n "$TGT_NS" exec "$TGT_POD" -c postgres -- psql -U postgres -d "$db" -tA -v ON_ERROR_STOP=1 "$@"; }

# Client binaries matching the SOURCE server major (present in both Spilo images).
SRC_MAJOR=$(srcsql postgres -c "SHOW server_version;" | cut -d. -f1)
PG_BIN=/usr/lib/postgresql/$SRC_MAJOR/bin
echo "Source PostgreSQL major: $SRC_MAJOR (client binaries: $PG_BIN)"

COUNT_QUERY="SELECT relname, (xpath('/row/c/text()', query_to_xml(format(
  'SELECT count(*) AS c FROM %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint
  FROM pg_stat_user_tables ORDER BY relname;"

FAILED=""
while read -r DB OWNER; do
  [ -z "$DB" ] && continue
  echo "=== migrating database: $DB (owner: $OWNER) ==="

  # Ensure the database exists on the target (covers databases created
  # outside the CR spec; the owner role must already exist on the target).
  if [ "$(tgtsql postgres -c "SELECT 1 FROM pg_database WHERE datname = '$DB';")" != "1" ]; then
    echo "  creating database $DB on target"
    tgtsql postgres -c "CREATE DATABASE \"$DB\" OWNER \"$OWNER\";" >/dev/null || { FAILED="$FAILED $DB(create)"; continue; }
  fi

  # Pre-create the source's extensions (extension creation needs superuser).
  for EXT in $(srcsql "$DB" -c "SELECT extname FROM pg_extension;"); do
    tgtsql "$DB" -c "CREATE EXTENSION IF NOT EXISTS \"$EXT\";" >/dev/null 2>&1 \
      || echo "  WARNING: could not create extension $EXT on target — restore may fail"
  done

  # Baseline on the source (exact counts).
  SRC_COUNTS=$(srcsql "$DB" -c "$COUNT_QUERY")

  # Restore as the database's owner, with the target-managed password.
  OWNER_PW=$(kubectl --context "$TGT_CTX" -n "$TGT_NS" get secret \
    "$OWNER.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do" \
    -o jsonpath='{.data.password}' | base64 -d) || { FAILED="$FAILED $DB(secret)"; continue; }

  kubectl --context "$SRC_CTX" -n "$SRC_NS" exec "$SRC_POD" -c postgres -- \
      "$PG_BIN/pg_dump" -U postgres -Fc --no-comments \
      -N metric_helpers -N user_management "$DB" \
  | kubectl --context "$TGT_CTX" -n "$TGT_NS" exec -i "$TGT_POD" -c postgres -- \
      env PGPASSWORD="$OWNER_PW" \
      "$PG_BIN/pg_restore" -U "$OWNER" -h localhost -d "$DB" --no-owner -x
  RC=$?

  # Verify: exact counts must match the baseline.
  TGT_COUNTS=$(tgtsql "$DB" -c "$COUNT_QUERY")
  if [ "$RC" -eq 0 ] && [ "$SRC_COUNTS" = "$TGT_COUNTS" ]; then
    echo "  PASS: $DB (tables/rows identical)"
  else
    echo "  FAIL: $DB (pipe exit $RC; counts $( [ "$SRC_COUNTS" = "$TGT_COUNTS" ] && echo match || echo DIFFER ))"
    FAILED="$FAILED $DB"
  fi
done < <(srcsql postgres -F' ' -c \
  "SELECT datname, pg_get_userbyid(datdba) FROM pg_database
   WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1;")

echo
if [ -n "$FAILED" ]; then echo "MIGRATION INCOMPLETE — failed:$FAILED"; exit 1; fi
echo "MIGRATION COMPLETE — all databases verified."
```

If a database reports `FAIL`, see [Troubleshooting](#troubleshooting) and the [manual single-database transfer](#reference-manual-single-database-transfer) reference — it explains what each part of the script does, so the failing database can be transferred and debugged in isolation. For very large databases, prefer the file-based variant described there (a straight pipe is not resumable).

### Security notes

- While a restore runs, the owner password is expanded into the workstation's `kubectl` argument list and is visible in local process listings (`ps`). Run the migration from a trusted, single-user workstation, and do not enable shell tracing (`set -x`) around these commands.
- A dump file (file-based variant) is a full plaintext logical copy of the database. Create it with restrictive permissions (`umask 077` before dumping, or `chmod 600` immediately after), encrypt it at rest if your policy requires, and delete it once the migration is verified.
- The data itself only traverses the two TLS-protected `kubectl exec` channels; nothing is exposed on the network beyond the two Kubernetes API connections.

## Step 4: Verify Application Access

The script has already verified per-table row counts. Confirm in addition that each application user can actually query its data with the **target**-managed credentials (this catches ownership problems immediately), and re-check any Step 2 checksums. If you pre-staged the credential secrets in Step 1, this password is identical to the source one — applications keep their existing credentials and only the connection endpoint changes at cutover:

```bash
APP_PW=$(kubectl --context $TGT_CTX -n $TGT_NS get secret \
  <owner>.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do \
  -o jsonpath='{.data.password}' | base64 -d)

kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
  env PGPASSWORD="$APP_PW" psql -U <owner> -h localhost -d <database> -tA -c \
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

## Reference: Manual Single-Database Transfer

This section is the script's inner loop as standalone commands. Use it to debug a database the script reported as `FAIL`, to migrate a single database only, or to handle very large databases with the resumable file-based variant. The examples transfer a database `appdb` owned by `appuser`.

First inventory the source database's extensions and pre-create (as `postgres`) any that are missing on the target — the restore runs as the application user, which cannot create extensions:

```bash
TGT_POD=$(kubectl --context $TGT_CTX -n $TGT_NS get pod \
  -l spilo-role=master,cluster-name=$TGT_CLUSTER -o jsonpath='{.items[0].metadata.name}')

kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -d appdb -tA -c "SELECT extname, extversion FROM pg_extension ORDER BY 1;"
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
  psql -U postgres -d appdb -c "CREATE EXTENSION IF NOT EXISTS <extname>;"
```

Record the exact row counts on the source (do not use `pg_stat_user_tables.n_live_tup` for this — it is a planner statistics *estimate*):

```bash
kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -d appdb -tA -c \
  "SELECT relname, (xpath('/row/c/text()', query_to_xml(format(
     'SELECT count(*) AS c FROM %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint
   FROM pg_stat_user_tables ORDER BY relname;"
```

Read the application user's password from the operator-managed secret, then run the pipe — in a shell with `pipefail` set, otherwise a source-side `pg_dump`/`kubectl` failure is masked by the exit status of the last command:

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

The pipe must exit `0` (with `pipefail`, a non-zero status from *either* side surfaces; `PIPESTATUS` shows which side failed). Rerun the count query on the target afterwards and compare with the baseline. Command details — each flag below was added because omitting it produced a failing, noisy, or broken-permissions restore during validation:

- **Restore as the application user** (`-U appuser` with its password), not as `postgres`: with `--no-owner`, restored objects are owned by the connecting user. Restoring as `postgres` leaves every table owned by `postgres`, and the application user cannot even `SELECT` afterwards (`permission denied for table ...`). Restoring as the CR-defined owner lands the ownership correctly with no post-step. **Scope note:** this pattern fits the operator's standard layout — one application database wholly owned by one CR-defined user. If your database has multiple owning roles, `SECURITY DEFINER` functions, or objects in non-`public` schemas with distinct owners, `--no-owner` collapses all ownership onto the connecting user; plan an explicit post-restore ownership and grant pass for those objects.
- **Version-matched binaries** (`/usr/lib/postgresql/<major>/bin/`): the container's default `pg_dump` can be a newer major whose output (e.g. `SET transaction_timeout`) an older target server rejects. The images ship binaries for every supported major, so pick the path explicitly (the script auto-detects this from `SHOW server_version`). When migrating to a *newer* target major, use the **target** major's `pg_dump` (also present in the source pod's image).
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

## Troubleshooting

### Application user gets `permission denied for table ...` after a successful restore

The restore was run as `postgres` instead of the application user, so all objects are owned by `postgres`. Either rerun the restore as the application user (see the [reference section](#reference-manual-single-database-transfer)), or transfer ownership in place:

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

The source database uses an extension that is not pre-installed on the target, and the application user cannot create it. The script warns about this (`WARNING: could not create extension`). Create the extension as `postgres` on the target database, then rerun the restore. If `CREATE EXTENSION` itself fails with a missing-file error, the extension's packages are not present in the target image at all — it must be added to the image/instance before this migration can carry that database.

### Restore reports `must be owner of extension pg_stat_statements` (and similar)

`--no-comments` was omitted from `pg_dump`; the extension comments require superuser. The data restores fine — the errors only break the clean exit code. Rerun with `--no-comments` for a verifiable result.

### Restore reports `unrecognized configuration parameter "transaction_timeout"`

The dump was taken with a `pg_dump` newer than the target server (typically the image's default binary). Rerun using the explicit version-matched binary path (the script auto-detects it; in the manual commands set `PG_BIN` to the source server's major).

### Restore reports `schema "metric_helpers" already exists` (and similar)

The `-N metric_helpers -N user_management` exclusions were omitted. These errors are harmless for the excluded schemas' objects, but rerun with the exclusions for a clean, verifiable exit code.

### Rerunning after a failed restore

Drop and recreate the target database first — a partial restore leaves objects that collide (`relation already exists`, duplicate-key COPY failures). Note `DROP DATABASE` must be executed as its own single statement:

```bash
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- psql -U postgres -c "DROP DATABASE appdb"
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- psql -U postgres -c "CREATE DATABASE appdb OWNER appuser"
```

Then redo **only the failed database** with the [manual transfer](#reference-manual-single-database-transfer). Do not rerun the whole script after a partial success: it would restore into the databases that already transferred, and the resulting `already exists` collisions would mark them as failed.

### Application passwords changed after the migration

The target CR was created **before** the credential secrets were pre-staged (Step 1), so the operator generated new passwords. To restore the source credentials after the fact, update both the secret and the role together — the secret alone is not enough, and an `ALTER ROLE` alone would be reverted by the operator's next sync from the secret:

```bash
SRC_PW=$(kubectl --context $SRC_CTX -n $SRC_NS get secret \
  appuser.$SRC_CLUSTER.credentials.postgresql.acid.zalan.do -o jsonpath='{.data.password}' | base64 -d)

kubectl --context $TGT_CTX -n $TGT_NS patch secret \
  appuser.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do \
  -p "{\"stringData\":{\"password\":\"$SRC_PW\"}}"
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
  psql -U postgres -c "ALTER ROLE appuser PASSWORD '$SRC_PW';"
```

Verify with a login test as in Step 4.

### Pipe is slow

Throughput is bounded by the workstation's link to both API servers (every byte traverses it twice: exec stream in, exec stream out). Run the relay from a machine with good connectivity to both platforms (e.g. a jump host), or use the file-based variant to at least make progress resumable.
