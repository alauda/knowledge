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
SUFFIX="credentials.postgresql.acid.zalan.do"
for SEC in $(kubectl --context $SRC_CTX -n $SRC_NS get secret \
    -l application=spilo,cluster-name=$SRC_CLUSTER -o name); do
  NAME=${SEC#secret/}
  U=${NAME%.$SRC_CLUSTER.$SUFFIX}
  [ "$U" = "$NAME" ] && continue                          # not a credential secret
  case "$U" in postgres|standby|pooler) continue ;; esac  # operator-managed system users
  kubectl --context $TGT_CTX -n $TGT_NS apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: $U.$TGT_CLUSTER.$SUFFIX
data:
  username: $(kubectl --context $SRC_CTX -n $SRC_NS get $SEC -o jsonpath='{.data.username}')
  password: $(kubectl --context $SRC_CTX -n $SRC_NS get $SEC -o jsonpath='{.data.password}')
EOF
done
```

The user name is taken from the **secret's name** (which matches the CR user the target operator will look up), not from the secret's `username` field, and the credential bytes are copied base64-verbatim — no decoding on the workstation. The `postgres`, `standby`, and `pooler` system users are deliberately skipped: they belong to each instance's own operator. The ordering matters: pre-stage the secrets first, then create the CR (see [Troubleshooting](#troubleshooting) if the CR was created first). If **password rotation** (`enable_password_rotation`) is active on the source, the rotated login username inside the secret will not match any role the target operator creates — disable rotation for the migration window and migrate with the base credentials.

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

Fill in the six variables at the top, then run it with `bash`. Without arguments it migrates every database; pass database names (`bash migrate.sh appdb`) to migrate only those — used to redo a single database after a failure. Every transfer goes through the same script in one of two modes:

- **Pipe mode** (default): source streams straight into the target — no intermediate storage.
- **File mode** (`DUMP_DIR=/path bash migrate.sh`): each database is dumped to `$DUMP_DIR/<db>.dump` first, then restored from the file. A rerun **reuses completed dumps**, making the transfer resumable — use this for large databases or unreliable links.

```bash
#!/usr/bin/env bash
# Whole-instance PostgreSQL migration relayed through the workstation.
# Migrates every application database of $SRC_CLUSTER into $TGT_CLUSTER.
set -u -o pipefail

SRC_CTX="<source-context>";  SRC_NS="<source-namespace>";  SRC_CLUSTER="<source-instance-name>"
TGT_CTX="<target-context>";  TGT_NS="<target-namespace>";  TGT_CLUSTER="<target-instance-name>"

SRC_POD=$(kubectl --context "$SRC_CTX" -n "$SRC_NS" get pod \
  -l spilo-role=master,cluster-name="$SRC_CLUSTER" -o jsonpath='{.items[0].metadata.name}') \
  && [ -n "$SRC_POD" ] || { echo "ERROR: cannot find source master pod for $SRC_CLUSTER" >&2; exit 1; }
TGT_POD=$(kubectl --context "$TGT_CTX" -n "$TGT_NS" get pod \
  -l spilo-role=master,cluster-name="$TGT_CLUSTER" -o jsonpath='{.items[0].metadata.name}') \
  && [ -n "$TGT_POD" ] || { echo "ERROR: cannot find target master pod for $TGT_CLUSTER" >&2; exit 1; }

srcsql() { local db=$1; shift; kubectl --context "$SRC_CTX" -n "$SRC_NS" exec "$SRC_POD" -c postgres -- psql -U postgres -d "$db" -tA -v ON_ERROR_STOP=1 "$@"; }
tgtsql() { local db=$1; shift; kubectl --context "$TGT_CTX" -n "$TGT_NS" exec "$TGT_POD" -c postgres -- psql -U postgres -d "$db" -tA -v ON_ERROR_STOP=1 "$@"; }

# Client binaries matching the SOURCE server major (present in both Spilo images).
SRC_MAJOR=$(srcsql postgres -c "SHOW server_version;" | cut -d. -f1)
case "$SRC_MAJOR" in ''|*[!0-9]*) echo "ERROR: cannot determine source PostgreSQL major (psql via $SRC_POD failed)" >&2; exit 1 ;; esac
PG_BIN=/usr/lib/postgresql/$SRC_MAJOR/bin
echo "Source PostgreSQL major: $SRC_MAJOR (client binaries: $PG_BIN)"

# Count every user table outside the schemas the dump excludes.
COUNT_QUERY="SELECT schemaname||'.'||relname, (xpath('/row/c/text()', query_to_xml(format(
  'SELECT count(*) AS c FROM %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint
  FROM pg_stat_user_tables
  WHERE schemaname NOT IN ('metric_helpers','user_management') ORDER BY 1;"

FAILED=""; ATTEMPTED=0
while read -r DB OWNER; do
  [ -z "$DB" ] && continue
  # With arguments, migrate only the named databases (e.g. to redo one FAIL).
  if [ "$#" -gt 0 ]; then
    case " $* " in *" $DB "*) ;; *) continue ;; esac
  fi
  ATTEMPTED=$((ATTEMPTED+1))
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

  # Transfer: straight pipe by default; with DUMP_DIR set, dump to a file
  # first and restore from it (resumable — completed dumps are reused).
  if [ -n "${DUMP_DIR:-}" ]; then
    mkdir -p "$DUMP_DIR"
    DUMP_FILE="$DUMP_DIR/$DB.dump"
    if [ -s "$DUMP_FILE" ]; then
      echo "  reusing existing dump $DUMP_FILE"
    else
      kubectl --context "$SRC_CTX" -n "$SRC_NS" exec "$SRC_POD" -c postgres -- \
          "$PG_BIN/pg_dump" -U postgres -Fc --no-comments \
          -N metric_helpers -N user_management "$DB" > "$DUMP_FILE.partial" \
        && mv "$DUMP_FILE.partial" "$DUMP_FILE" \
        || { rm -f "$DUMP_FILE.partial"; FAILED="$FAILED $DB(dump)"; continue; }
    fi
    kubectl --context "$TGT_CTX" -n "$TGT_NS" exec -i "$TGT_POD" -c postgres -- \
        env PGPASSWORD="$OWNER_PW" \
        "$PG_BIN/pg_restore" -U "$OWNER" -h localhost -d "$DB" --no-owner -x < "$DUMP_FILE"
    RC=$?
  else
    kubectl --context "$SRC_CTX" -n "$SRC_NS" exec "$SRC_POD" -c postgres -- \
        "$PG_BIN/pg_dump" -U postgres -Fc --no-comments \
        -N metric_helpers -N user_management "$DB" \
    | kubectl --context "$TGT_CTX" -n "$TGT_NS" exec -i "$TGT_POD" -c postgres -- \
        env PGPASSWORD="$OWNER_PW" \
        "$PG_BIN/pg_restore" -U "$OWNER" -h localhost -d "$DB" --no-owner -x
    RC=$?
  fi

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
if [ "$ATTEMPTED" -eq 0 ]; then
  echo "ERROR: no databases migrated — source enumeration failed, or no database matched the arguments" >&2
  exit 1
fi
if [ -n "$FAILED" ]; then echo "MIGRATION INCOMPLETE — failed:$FAILED"; exit 1; fi
echo "MIGRATION COMPLETE — $ATTEMPTED database(s) verified."
```

If a database reports `FAIL`, see [Troubleshooting](#troubleshooting); after fixing the cause, redo just that database by passing its name to the script (in file mode, its completed dump is reused).

### Security notes

- While a restore runs, the owner password is expanded into the workstation's `kubectl` argument list and is visible in local process listings (`ps`). Run the migration from a trusted, single-user workstation, and do not enable shell tracing (`set -x`) around these commands.
- In file mode, `$DUMP_DIR` holds full plaintext logical copies of the databases. Point it at a directory with restrictive permissions (`umask 077` before running, or `chmod 700` on the directory), encrypt at rest if your policy requires, and delete the dumps once the migration is verified.
- The data itself only traverses the two TLS-protected `kubectl exec` channels; nothing is exposed on the network beyond the two Kubernetes API connections.

## Step 4: Verify Application Access

The script has already verified per-table row counts. Confirm in addition that each application user can actually query its data with the **target**-managed credentials (this catches ownership problems immediately), and re-check any Step 2 checksums. If you pre-staged the credential secrets in Step 1, this password is identical to the source one — applications keep their existing credentials and only the connection endpoint changes at cutover:

```bash
TGT_POD=$(kubectl --context $TGT_CTX -n $TGT_NS get pod \
  -l spilo-role=master,cluster-name=$TGT_CLUSTER -o jsonpath='{.items[0].metadata.name}')

APP_PW=$(kubectl --context $TGT_CTX -n $TGT_NS get secret \
  <owner>.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do \
  -o jsonpath='{.data.password}' | base64 -d)

kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
  env PGPASSWORD="$APP_PW" psql -U <owner> -h localhost -d <database> -tA -c \
  "SELECT current_user, count(*) FROM <your-main-table>;"
```

The dump deliberately skips ACL statements (`-x`) because they reference roles managed by the source operator — if additional (non-owner) users need privileges on the migrated data, re-grant them on the target now.

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

The restore was run as `postgres` instead of the application user, so all objects are owned by `postgres` (the script always restores as the owner; this typically comes from a hand-run restore). Either redo the database — drop and recreate it, then rerun the script with the database name — or transfer ownership in place:

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

Related scope note: the migration's `--no-owner` model assumes the operator's standard layout — one database wholly owned by one CR-defined user. If a database has multiple owning roles, `SECURITY DEFINER` functions, or objects in non-`public` schemas with distinct owners, ownership collapses onto the restoring user; plan an explicit post-restore ownership and grant pass for those objects.

### Restore reports `permission denied to create extension ...`

The source database uses an extension that is not pre-installed on the target, and the application user cannot create it. The script warns about this (`WARNING: could not create extension`). Create the extension as `postgres` on the target database, then rerun the restore. If `CREATE EXTENSION` itself fails with a missing-file error, the extension's packages are not present in the target image at all — it must be added to the image/instance before this migration can carry that database.

### Restore reports `must be owner of extension pg_stat_statements` (and similar)

`--no-comments` was omitted from `pg_dump`; the extension comments require superuser. The data restores fine — the errors only break the clean exit code. Rerun with `--no-comments` for a verifiable result.

### Restore reports `unrecognized configuration parameter "transaction_timeout"`

The dump was taken with a `pg_dump` newer than the target server (typically the image's default binary — a hand-run dump without the explicit `PG_BIN` path; the script auto-detects it from `SHOW server_version`). Rerun with the version-matched binary path. When migrating to a *newer* target major, use the **target** major's binaries instead — they are present in the source pod's image too.

### Restore reports `schema "metric_helpers" already exists` (and similar)

The `-N metric_helpers -N user_management` exclusions were omitted. These errors are harmless for the excluded schemas' objects, but rerun with the exclusions for a clean, verifiable exit code.

### Rerunning after a failed restore

Drop the target database first — a partial restore leaves objects that collide (`relation already exists`, duplicate-key COPY failures). Note `DROP DATABASE` must be executed as its own single statement:

```bash
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- psql -U postgres -c "DROP DATABASE appdb"
```

Then rerun the script with **only the failed database** as an argument (`bash migrate.sh <database>`) — it recreates the database with the correct owner, and in file mode it reuses the completed dump. Do not rerun it without arguments after a partial success: restoring into the databases that already transferred produces `already exists` collisions that mark them as failed.

### Application passwords changed after the migration

The target CR was created **before** the credential secrets were pre-staged (Step 1), so the operator generated new passwords. To restore the source credentials after the fact, update both the secret and the role together — the secret alone is not enough, and an `ALTER ROLE` alone would be reverted by the operator's next sync from the secret. The commands below stay safe for passwords containing quotes, backslashes, or JSON metacharacters: the secret is patched with the base64 value (JSON-safe by construction), and the SQL uses psql's `:'pw'` literal quoting instead of string interpolation:

```bash
PW_B64=$(kubectl --context $SRC_CTX -n $SRC_NS get secret \
  appuser.$SRC_CLUSTER.credentials.postgresql.acid.zalan.do -o jsonpath='{.data.password}')

kubectl --context $TGT_CTX -n $TGT_NS patch secret \
  appuser.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do \
  --type merge -p "{\"data\":{\"password\":\"$PW_B64\"}}"

kubectl --context $TGT_CTX -n $TGT_NS exec -i $TGT_POD -c postgres -- \
  psql -U postgres -v pw="$(printf %s "$PW_B64" | base64 -d)" <<'SQL'
ALTER ROLE appuser PASSWORD :'pw';
SQL
```

Verify with a login test as in Step 4.

### Pipe is slow

Throughput is bounded by the workstation's link to both API servers (every byte traverses it twice: exec stream in, exec stream out). Run the migration from a machine with good connectivity to both platforms (e.g. a jump host), and use file mode (`DUMP_DIR`) so progress is resumable. If a very large restore needs parallelism, note `pg_restore -j N` cannot read from stdin — copy the dump file into the target pod (`kubectl cp`) and restore from the local path there.
