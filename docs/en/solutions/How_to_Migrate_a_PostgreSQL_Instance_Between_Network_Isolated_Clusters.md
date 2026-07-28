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

### What Is and Is Not Migrated

A logical migration carries less than a byte-level copy. Know the boundary before relying on it:

| Carried by this procedure | NOT carried — handle deliberately |
|---|---|
| Tables, data, indexes, views, functions, sequences (including positions) | `GRANT`s (`-x` skips ACLs at restore; they remain inside the dump file — see Step 4) |
| Roles and their attributes (generated into the target CR in Step 1) | `COMMENT ON` metadata (`--no-comments`; a deliberate, lossy trade for a verifiable exit code) |
| Database encoding and locale (enforced by the script) | CR spec beyond `users`/`databases`/`volume`: `resources`, `postgresql.parameters`, `patroni.pg_hba`, `connectionPooler`, sidecars, load-balancer flags — port them in the target CR yourself |
| Database- and role-in-database-level settings (`ALTER DATABASE/ROLE ... SET`) | Objects requiring superuser: event triggers, publications/subscriptions, FDW servers and user mappings |
| Extensions (schema placement and version preserved) | Tablespace layout (`--no-tablespaces` maps everything to the default) |
| Planner statistics (regenerated via `ANALYZE` in the window) | Instances using `preparedDatabases` (its `<db>_owner/_reader/_writer` role model and `user_management` schema are out of scope for this guide) |

Applications connecting through a source-side `connectionPooler` service need the pooler declared in the target CR, or their connection endpoint changes at cutover.

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
- A maintenance window sized from a rehearsal (below) — not guessed.
- A stable window on both instances: no pending node maintenance or evictions. The script resolves each master pod once at start; a Patroni failover mid-run sends the stream to a demoted pod. For long runs, consider `patronictl pause` on both sides for the duration, and redo any database that was in flight if a failover happens anyway.
- Sufficient Kubernetes permissions in both namespaces: `get` and `list` on `postgresqls.acid.zalan.do`, `pods`, and `secrets`; `create` on `pods/exec`; on the target side additionally `create` on `postgresqls` and `secrets` (credential pre-staging) and `patch` on `secrets` (troubleshooting); on the source side, for the final cleanup, `delete` on `postgresqls` and `persistentvolumeclaims`.
- The commands assume the operator's standard Spilo image: pod labels `spilo-role`/`cluster-name`, database container named `postgres`, and client binaries under `/usr/lib/postgresql/<major>/bin/` for the majors that image generation bundles (current images bundle 13–17; the script verifies the major it needs before starting). Custom or non-Spilo images require adapting these labels and paths.

### Rehearse and Size the Window

The stop-write window equals the full dump+restore+verify duration — do not open a maintenance window without knowing that number. Rehearse first: run Step 1 against a throwaway target instance and run the Step 3 script **without stopping source writes**. Expect `FAIL` verdicts (`SOURCE CHANGED DURING DUMP` is normal here) — the rehearsal measures *duration*, not correctness. Then delete the rehearsal target (CR and PVCs).

Set a go/no-go rule before the real window: if verification has not passed with an agreed margin of window time remaining, roll back — re-enable source writes, keep the source untouched, and investigate offline. The target can be dropped and recreated at any time; the source is the asset.

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

Every CR-managed database in this list must be declared in the target CR (`spec.databases`, with its owner in `spec.users`) — the operator creates the roles and databases and manages their credentials; do not attempt to dump global objects (roles) with `pg_dumpall` from the source. The `postgres` maintenance database is managed by the operator/image on each side and is not migrated. Databases owned by `postgres` (created outside the CR spec) do not go into the CR — the migration script creates them on the target automatically.

The `users:`/`databases:` sections of the target CR can be generated directly from the source instead of hand-written. The `users:` generator enumerates **all** application roles from `pg_roles` — not just database owners — because read-only, monitoring, and per-service accounts that own no database must also exist on the target, and it carries each role's attributes as `userFlags` (a role generated as `some_role: []` on the target would silently lose `NOLOGIN`, `CREATEDB`, etc.):

```bash
{
  echo "  users:"
  kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
    psql -U postgres -tA -c \
    "SELECT '    ' || rolname || ': [' || array_to_string(ARRAY(
       SELECT f FROM unnest(ARRAY[
         CASE WHEN rolsuper THEN 'superuser' END,
         CASE WHEN rolcreatedb THEN 'createdb' END,
         CASE WHEN rolcreaterole THEN 'createrole' END,
         CASE WHEN NOT rolcanlogin THEN 'nologin' END]) f WHERE f IS NOT NULL), ',') || ']'
     FROM pg_roles
     WHERE rolname NOT LIKE 'pg\\_%'
       AND rolname NOT IN ('postgres','standby','pooler','admin','zalandos','cron_admin','robot_zmon')
     ORDER BY (rolname) COLLATE \"C\";"
  echo "  databases:"
  kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
    psql -U postgres -tA -c \
    "SELECT '    ' || datname || ': ' || pg_get_userbyid(datdba) FROM pg_database
     WHERE NOT datistemplate AND datname <> 'postgres' AND pg_get_userbyid(datdba) <> 'postgres' ORDER BY 1;"
}
```

Review the generated `users:` list before applying: the `NOT IN` filter excludes the standard operator/image system roles — if your deployment defines additional operator-managed roles, exclude those too rather than declaring them in the CR.

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
  UB64=$(kubectl --context $SRC_CTX -n $SRC_NS get $SEC -o jsonpath='{.data.username}')
  PB64=$(kubectl --context $SRC_CTX -n $SRC_NS get $SEC -o jsonpath='{.data.password}')
  [ -n "$UB64" ] && [ -n "$PB64" ] \
    || { echo "WARNING: $NAME has an empty username/password field — skipping (fix on the source first)" >&2; continue; }
  kubectl --context $TGT_CTX -n $TGT_NS apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: $U.$TGT_CLUSTER.$SUFFIX
data:
  username: $UB64
  password: $PB64
EOF
done
```

The copied secrets carry no operator labels or ownerReference until the operator adopts them, so if you abandon the migration and delete the target CR, delete these pre-staged secrets manually — they are not garbage-collected.

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
  numberOfInstances: 1       # restore on a single instance; scale out AFTER Step 4
  postgresql:
    version: "16"            # same as source, or newer major
  users:
    app_owner: []            # generated above
  databases:
    appdb: app_owner         # generated above
  volume:
    size: 10Gi               # ~2x the source data size: data + indexes being rebuilt + WAL growth during restore
    storageClass: <target-storageclass>
```

Restoring into a single instance keeps the full-restore WAL burst off streaming replication and the WAL archive; scale `numberOfInstances` up after verification (Step 4). Size `volume` with headroom — a logical restore holds data, indexes under construction, and the restore's own WAL at the same time.

Wait until the instance is actually ready — `Running` reports pod health, while the operator creates roles, databases, and credential secrets **asynchronously after** that, so poll for the objects Step 3 depends on:

```bash
until [ "$(kubectl --context $TGT_CTX -n $TGT_NS get postgresql $TGT_CLUSTER \
    -o jsonpath='{.status.PostgresClusterStatus}')" = "Running" ]; do sleep 5; done

TGT_POD=$(kubectl --context $TGT_CTX -n $TGT_NS get pod \
  -l spilo-role=master,cluster-name=$TGT_CLUSTER -o jsonpath='{.items[0].metadata.name}')

# every CR-declared user must exist as a role, with its credential secret:
until [ "$(kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
    psql -U postgres -tA -c "SELECT count(*) FROM pg_roles WHERE rolname = 'app_owner';")" = "1" ] \
  && kubectl --context $TGT_CTX -n $TGT_NS get secret \
    "app-owner.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do" >/dev/null 2>&1
do sleep 5; done
```

Note the secret's name: the operator sanitizes role names into RFC 1123 form, so a role like `app_owner` gets the secret `app-owner.<cluster>.credentials...` (`_` becomes `-`). Use the sanitized form wherever a secret is fetched by name.

## Step 2: Stop Writes

Stop application writes on the source — the transfer is a point-in-time copy, and anything written after the dump starts is lost.

Do not rely on "the team said the app is stopped": **enforce** it. Blocking new connections and terminating leftovers turns a would-be silent data loss into an immediate, visible failure:

```bash
# per application database: no new non-superuser connections, kill the stragglers
kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -c "ALTER DATABASE <database> CONNECTION LIMIT 0;"
kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = '<database>' AND usename NOT IN ('postgres','standby');"
```

(If you abort the migration, restore access with `ALTER DATABASE <database> CONNECTION LIMIT -1;`.) As a second line of defense, the Step 3 script re-reads the source row counts after each transfer and fails that database with `SOURCE CHANGED DURING DUMP` if anything moved.

The script records and compares exact per-table row counts automatically. For stronger guarantees on critical tables, additionally record per-table checksums now and re-check them in Step 4. Use a construct that is stable across PostgreSQL versions and explicit about NULLs (an aggregate over an expression that can be NULL silently skips those rows):

```bash
kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -d <database> -tA -c \
  "SELECT count(*), md5(string_agg(id::text || ':' || coalesce(payload,'<NULL>'), '|' ORDER BY id))
   FROM <your_table>;"
```

## Step 3: Run the Migration Script

The script performs the whole migration in one run: it enumerates the source's application databases, ensures each exists on the target **with the source's encoding and locale** (recreating empty mismatched ones — this also covers CR-created databases, which the operator builds with target defaults), pre-creates missing extensions preserving their schema and version, transfers each database, carries over database-level settings, runs `ANALYZE`, and verifies row counts, an object census, and sequence positions — reporting `PASS`/`FAIL` per database and exiting non-zero if anything failed.

Fill in the six variables at the top, then run it with `bash`. Without arguments it migrates every database; pass database names (`bash migrate.sh appdb`) to migrate only those — used to redo a single database after a failure. Every transfer goes through the same script in one of two modes:

- **File mode** (default; override the location with `DUMP_DIR=/path`): each database is dumped to `$DUMP_DIR/<db>.dump` first, then restored from the file. This is the default because the long-lived `kubectl exec` streams are the fragile link in this relay — API-server load balancers and kubelet idle timeouts can cut a multi-hour stream, and a file makes that cost one database instead of the whole run. By default every run takes a **fresh** dump; set `REUSE_DUMPS=1` to reuse completed dumps (resumable). Reuse is only safe **within the same stopped-write maintenance window** — a dump taken before source writes resumed would silently migrate stale data.
- **Pipe mode** (`PIPE_MODE=1 bash migrate.sh`): source streams straight into the target — no intermediate storage on the workstation. Acceptable for small instances (roughly under 5 GB) where a cut stream just means a quick rerun; for anything that takes hours, use file mode.

```bash
#!/usr/bin/env bash
# Whole-instance PostgreSQL migration relayed through the workstation.
# Migrates every application database of $SRC_CLUSTER into $TGT_CLUSTER.
set -u -o pipefail

SRC_CTX="<source-context>";  SRC_NS="<source-namespace>";  SRC_CLUSTER="<source-instance-name>"
TGT_CTX="<target-context>";  TGT_NS="<target-namespace>";  TGT_CLUSTER="<target-instance-name>"

# File mode is the default (resumable; a broken exec stream costs one database,
# not the run). PIPE_MODE=1 streams directly — for small instances only.
DUMP_DIR="${DUMP_DIR:-./pg-migrate-dumps}"

SRC_POD=$(kubectl --context "$SRC_CTX" -n "$SRC_NS" get pod \
  -l spilo-role=master,cluster-name="$SRC_CLUSTER" -o jsonpath='{.items[0].metadata.name}') \
  && [ -n "$SRC_POD" ] || { echo "ERROR: cannot find source master pod for $SRC_CLUSTER" >&2; exit 1; }
TGT_POD=$(kubectl --context "$TGT_CTX" -n "$TGT_NS" get pod \
  -l spilo-role=master,cluster-name="$TGT_CLUSTER" -o jsonpath='{.items[0].metadata.name}') \
  && [ -n "$TGT_POD" ] || { echo "ERROR: cannot find target master pod for $TGT_CLUSTER" >&2; exit 1; }

srcsql() { local db=$1; shift; kubectl --context "$SRC_CTX" -n "$SRC_NS" exec "$SRC_POD" -c postgres -- psql -U postgres -d "$db" -tA -v ON_ERROR_STOP=1 "$@"; }
tgtsql() { local db=$1; shift; kubectl --context "$TGT_CTX" -n "$TGT_NS" exec "$TGT_POD" -c postgres -- psql -U postgres -d "$db" -tA -v ON_ERROR_STOP=1 "$@"; }
tgtexec() { kubectl --context "$TGT_CTX" -n "$TGT_NS" exec "$TGT_POD" -c postgres -- "$@"; }

# Multi-hour dumps/restores must not be killed by timeouts configured on the
# instance or its roles.
PGOPT='-c statement_timeout=0 -c lock_timeout=0 -c idle_in_transaction_session_timeout=0'

# Client binaries matching the SOURCE server major; images bundle a bounded set
# of majors, so verify before starting instead of failing mid-restore.
SRC_MAJOR=$(srcsql postgres -c "SHOW server_version;" | cut -d. -f1)
case "$SRC_MAJOR" in ''|*[!0-9]*) echo "ERROR: cannot determine source PostgreSQL major (psql via $SRC_POD failed)" >&2; exit 1 ;; esac
PG_BIN=/usr/lib/postgresql/$SRC_MAJOR/bin
tgtexec test -x "$PG_BIN/pg_restore" \
  || { echo "ERROR: $PG_BIN/pg_restore not present in the target image" >&2; exit 1; }
echo "Source PostgreSQL major: $SRC_MAJOR (client binaries: $PG_BIN)"

# Verification queries. The explicit COLLATE "C" pins the sort order — the two
# databases can legitimately have different collations, and a text comparison
# of differently-ordered output would report false differences. The object
# census excludes extension-owned objects (extension versions differ across
# PostgreSQL majors) and counts everything else by kind.
COUNT_QUERY="SELECT schemaname||'.'||relname, (xpath('/row/c/text()', query_to_xml(format(
  'SELECT count(*) AS c FROM %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint
  FROM pg_stat_user_tables
  WHERE schemaname NOT IN ('metric_helpers','user_management')
  ORDER BY (schemaname||'.'||relname) COLLATE \"C\";"
OBJ_QUERY="SELECT c.relkind||':'||count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast','metric_helpers','user_management')
    AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = c.oid AND dep.deptype = 'e')
  GROUP BY c.relkind ORDER BY (c.relkind::text) COLLATE \"C\";"
SEQ_QUERY="SELECT schemaname||'.'||sequencename||'='||coalesce(last_value,0) FROM pg_sequences
  WHERE schemaname NOT IN ('metric_helpers','user_management')
  ORDER BY (schemaname||'.'||sequencename) COLLATE \"C\";"

FAILED=""; ATTEMPTED=0
while read -r DB OWNER; do
  [ -z "$DB" ] && continue
  # With arguments, migrate only the named databases (e.g. to redo one FAIL).
  if [ "$#" -gt 0 ]; then
    case " $* " in *" $DB "*) ;; *) continue ;; esac
  fi
  ATTEMPTED=$((ATTEMPTED+1))
  echo "=== migrating database: $DB (owner: $OWNER) ==="

  # The target database must exist with the SOURCE's encoding and locale —
  # plain CREATE DATABASE inherits the target template's defaults, silently
  # changing sort order and LIKE behavior (or failing the restore outright on
  # an encoding mismatch). TEMPLATE template0 is required to override them.
  # CR-declared databases are covered too: the operator creates those with
  # target defaults, so an empty database with the wrong locale is recreated.
  read -r ENC COLL CTYPE < <(srcsql postgres -F' ' -c \
    "SELECT pg_encoding_to_char(encoding), datcollate, datctype FROM pg_database WHERE datname = '$DB';")
  CREATE_SQL="CREATE DATABASE \"$DB\" OWNER \"$OWNER\" TEMPLATE template0 ENCODING '$ENC' LC_COLLATE '$COLL' LC_CTYPE '$CTYPE';"
  TGT_LOC=$(tgtsql postgres -c "SELECT pg_encoding_to_char(encoding)||'/'||datcollate||'/'||datctype FROM pg_database WHERE datname = '$DB';")
  if [ -z "$TGT_LOC" ]; then
    echo "  creating database $DB on target ($ENC/$COLL/$CTYPE)"
    tgtsql postgres -c "$CREATE_SQL" >/dev/null || { FAILED="$FAILED $DB(create)"; continue; }
  elif [ "$TGT_LOC" != "$ENC/$COLL/$CTYPE" ]; then
    if [ "$(tgtsql "$DB" -c "SELECT count(*) FROM pg_stat_user_tables WHERE schemaname NOT IN ('metric_helpers','user_management');")" = "0" ]; then
      echo "  recreating database $DB on target with source locale ($ENC/$COLL/$CTYPE, was $TGT_LOC)"
      tgtsql postgres -c "DROP DATABASE \"$DB\";" >/dev/null \
        && tgtsql postgres -c "$CREATE_SQL" >/dev/null \
        || { FAILED="$FAILED $DB(locale)"; continue; }
    else
      echo "  FAIL: $DB exists on target with different locale ($TGT_LOC vs $ENC/$COLL/$CTYPE) and is not empty"
      FAILED="$FAILED $DB(locale)"; continue
    fi
  fi

  # Pre-create only the extensions the target is missing (creation needs
  # superuser), preserving the source's schema placement and version — a
  # relocated or version-drifted extension breaks dependent objects at restore.
  while read -r EXT ESCH EVER; do
    [ -z "$EXT" ] && continue
    [ "$(tgtsql "$DB" -c "SELECT 1 FROM pg_extension WHERE extname = '$EXT';")" = "1" ] && continue
    tgtsql "$DB" -c "CREATE SCHEMA IF NOT EXISTS \"$ESCH\";" >/dev/null 2>&1
    tgtsql "$DB" -c "CREATE EXTENSION \"$EXT\" WITH SCHEMA \"$ESCH\" VERSION '$EVER';" >/dev/null 2>&1 \
      || tgtsql "$DB" -c "CREATE EXTENSION \"$EXT\" WITH SCHEMA \"$ESCH\";" >/dev/null 2>&1 \
      || echo "  WARNING: could not create extension $EXT (schema $ESCH) on target — restore may fail"
  done < <(srcsql "$DB" -F' ' -c \
    "SELECT e.extname, n.nspname, e.extversion FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql';")

  # Baseline on the source (exact counts, object census, sequence positions).
  SRC_COUNTS=$(srcsql "$DB" -c "$COUNT_QUERY")
  SRC_OBJS=$(srcsql "$DB" -c "$OBJ_QUERY"); SRC_SEQS=$(srcsql "$DB" -c "$SEQ_QUERY")

  # Transfer. The restore connects as postgres over the pod-local socket and
  # switches to the owner with --role: objects land owned by the owner, with
  # no password handling and nothing secret in the kubectl argument list.
  if [ "${PIPE_MODE:-0}" != "0" ]; then
    kubectl --context "$SRC_CTX" -n "$SRC_NS" exec "$SRC_POD" -c postgres -- \
        env PGOPTIONS="$PGOPT" \
        "$PG_BIN/pg_dump" -U postgres -Fc --no-comments \
        -N metric_helpers -N user_management "$DB" \
    | kubectl --context "$TGT_CTX" -n "$TGT_NS" exec -i "$TGT_POD" -c postgres -- \
        env PGOPTIONS="$PGOPT" \
        "$PG_BIN/pg_restore" -U postgres --role="$OWNER" -d "$DB" --no-owner --no-tablespaces -x
    RC=$?
  else
    install -d -m 700 "$DUMP_DIR"
    DUMP_FILE="$DUMP_DIR/$DB.dump"
    if [ "${REUSE_DUMPS:-0}" != "0" ] && [ -s "$DUMP_FILE" ]; then
      echo "  reusing existing dump $DUMP_FILE"
    else
      kubectl --context "$SRC_CTX" -n "$SRC_NS" exec "$SRC_POD" -c postgres -- \
          env PGOPTIONS="$PGOPT" \
          "$PG_BIN/pg_dump" -U postgres -Fc --no-comments \
          -N metric_helpers -N user_management "$DB" > "$DUMP_FILE.partial" \
        && mv "$DUMP_FILE.partial" "$DUMP_FILE" \
        || { rm -f "$DUMP_FILE.partial"; FAILED="$FAILED $DB(dump)"; continue; }
    fi
    kubectl --context "$TGT_CTX" -n "$TGT_NS" exec -i "$TGT_POD" -c postgres -- \
        env PGOPTIONS="$PGOPT" \
        "$PG_BIN/pg_restore" -U postgres --role="$OWNER" -d "$DB" --no-owner --no-tablespaces -x < "$DUMP_FILE"
    RC=$?
  fi

  # Carry over database- and role-in-database-level settings
  # (ALTER DATABASE ... SET / ALTER ROLE ... IN DATABASE ... SET) — pg_dump
  # without --create does not emit them, so they would silently disappear.
  srcsql postgres -c \
    "SELECT 'ALTER '||CASE WHEN s.setrole = 0 THEN 'DATABASE '||quote_ident(d.datname)
              ELSE 'ROLE '||quote_ident(r.rolname)||' IN DATABASE '||quote_ident(d.datname) END
            ||' SET '||quote_ident(split_part(cfg,'=',1))||' = '||quote_literal(substr(cfg, strpos(cfg,'=')+1))||';'
       FROM pg_db_role_setting s
       JOIN pg_database d ON d.oid = s.setdatabase
       LEFT JOIN pg_roles r ON r.oid = s.setrole
       CROSS JOIN LATERAL unnest(s.setconfig) cfg
      WHERE d.datname = '$DB';" \
    | kubectl --context "$TGT_CTX" -n "$TGT_NS" exec -i "$TGT_POD" -c postgres -- \
        psql -U postgres -v ON_ERROR_STOP=1 -f - >/dev/null \
    || echo "  WARNING: could not carry over ALTER DATABASE/ROLE ... SET settings for $DB"

  # A restore ships no planner statistics — without ANALYZE the first minutes
  # of production traffic run on empty stats (sequential scans everywhere).
  # This belongs INSIDE the maintenance window, not after cutover.
  tgtexec env PGOPTIONS="$PGOPT" "$PG_BIN/vacuumdb" -U postgres --analyze-in-stages -d "$DB" >/dev/null 2>&1 \
    || echo "  WARNING: vacuumdb --analyze-in-stages failed for $DB — run ANALYZE manually before cutover"

  # Verify: rows, object census, and sequence positions must match — and the
  # source must not have changed while the transfer ran (writes not stopped).
  TGT_COUNTS=$(tgtsql "$DB" -c "$COUNT_QUERY")
  TGT_OBJS=$(tgtsql "$DB" -c "$OBJ_QUERY"); TGT_SEQS=$(tgtsql "$DB" -c "$SEQ_QUERY")
  SRC_RECHECK=$(srcsql "$DB" -c "$COUNT_QUERY")
  if [ "$SRC_RECHECK" != "$SRC_COUNTS" ]; then
    echo "  FAIL: $DB (SOURCE CHANGED DURING DUMP — enforce the write stop per Step 2, then redo this database)"
    FAILED="$FAILED $DB"
  elif [ "$RC" -eq 0 ] && [ "$SRC_COUNTS" = "$TGT_COUNTS" ] && [ "$SRC_OBJS" = "$TGT_OBJS" ] && [ "$SRC_SEQS" = "$TGT_SEQS" ]; then
    echo "  PASS: $DB (rows, objects, and sequences identical)"
  else
    echo "  FAIL: $DB (transfer exit $RC; rows $( [ "$SRC_COUNTS" = "$TGT_COUNTS" ] && echo match || echo DIFFER ); objects $( [ "$SRC_OBJS" = "$TGT_OBJS" ] && echo match || echo DIFFER ); sequences $( [ "$SRC_SEQS" = "$TGT_SEQS" ] && echo match || echo DIFFER ))"
    FAILED="$FAILED $DB"
  fi
done < <(srcsql postgres -F' ' -c \
  "SELECT datname, pg_get_userbyid(datdba) FROM pg_database
   WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY (datname) COLLATE \"C\";")

echo
if [ "$ATTEMPTED" -eq 0 ]; then
  echo "ERROR: no databases migrated — source enumeration failed, or no database matched the arguments" >&2
  exit 1
fi
if [ -n "$FAILED" ]; then echo "MIGRATION INCOMPLETE — failed:$FAILED"; exit 1; fi
echo "MIGRATION COMPLETE — $ATTEMPTED database(s) verified."
```

If a database reports `FAIL`, see [Troubleshooting](#troubleshooting); after fixing the cause, redo just that database by passing its name to the script (in file mode, add `REUSE_DUMPS=1` to skip re-dumping if writes have stayed stopped).

### Security notes

- This relay deliberately makes the administrator workstation a data path between two otherwise-isolated environments — exactly what an isolation policy exists to control. Confirm the data path is approved by your security/compliance owner before migrating; "each hop is TLS" is a transport property, not an authorization.
- The migration script itself handles no database passwords: dumps and restores connect as `postgres` over the pod-local socket (the restore switches to the owner with `--role`). The only password-bearing command in this guide is the Step 4 login test — see the caveat there.
- In file mode (the default), `$DUMP_DIR` holds full plaintext logical copies of the databases. The script creates it with mode `700`; if you point `DUMP_DIR` at an existing directory, restrict it yourself, encrypt at rest if your policy requires, and delete the dumps once the migration is verified.
- The data traverses the two TLS-protected `kubectl exec` channels; nothing is exposed on the network beyond the two Kubernetes API connections.

## Step 4: Verify Application Access

The script has already verified per-table row counts, an object census, and sequence positions, and has run `ANALYZE` on each database. Confirm in addition that each application user can actually query its data with the **target**-managed credentials (this catches ownership problems immediately), and re-check any Step 2 checksums. If you pre-staged the credential secrets in Step 1, this password is identical to the source one — applications keep their existing credentials and only the connection endpoint changes at cutover. Note the secret name uses the RFC 1123-sanitized role name (`app_owner` → `app-owner`):

```bash
TGT_POD=$(kubectl --context $TGT_CTX -n $TGT_NS get pod \
  -l spilo-role=master,cluster-name=$TGT_CLUSTER -o jsonpath='{.items[0].metadata.name}')

APP_PW=$(kubectl --context $TGT_CTX -n $TGT_NS get secret \
  <owner-sanitized>.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do \
  -o jsonpath='{.data.password}' | base64 -d)

kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
  env PGPASSWORD="$APP_PW" psql -U <owner> -h localhost -d <database> -tA -c \
  "SELECT current_user, count(*) FROM <your-main-table>;"
```

**Caveat:** `kubectl exec` places its command — including this `PGPASSWORD` value — in the API request URI, which Kubernetes audit logging records at `Metadata` level and above, and it is also visible in local `ps` output while the command runs. This is a deliberate, one-off login *test*; if your audit policy treats recorded credentials as exposed, rotate this password after cutover (or verify from an application pod instead).

The restore skips ACL statements (`pg_restore -x`) because they reference roles managed by the source operator. The `GRANT`s themselves are still **inside the dump file** — if additional (non-owner) users need privileges on the migrated data, either re-grant manually now, or list the dump's ACL entries (`"$PG_BIN/pg_restore" -l <db>.dump | grep ' ACL '`) and replay just those with `pg_restore -L` once the roles exist on the target.

## Step 5: Cut Over and Clean Up

- Scale the target back out (`numberOfInstances: 2` or your HA baseline) and wait for the replica to catch up.
- Repoint applications to the target instance's service and re-enable writes.
- Retire the source in stages rather than deleting it immediately — it is your only rollback for data problems discovered after cutover. Keep it read-only and scaled to zero for an observation period first:

```bash
# freeze the source but keep its data (rollback insurance)
kubectl --context $SRC_CTX -n $SRC_NS patch postgresql $SRC_CLUSTER \
  --type merge -p '{"spec":{"numberOfInstances":0}}'
```

- After the observation period (days, per your policy), delete it. There is no replication configuration to tear down. If your operator is configured with delete-protection annotations (`delete_annotation_date_key`/`delete_annotation_name_key`), set those annotations on the CR first or the operator ignores the deletion:

```bash
kubectl --context $SRC_CTX -n $SRC_NS delete postgresql $SRC_CLUSTER
# PVC retention depends on operator configuration — remove leftovers:
kubectl --context $SRC_CTX -n $SRC_NS delete pvc -l cluster-name=$SRC_CLUSTER --ignore-not-found
```

## Troubleshooting

### Application user gets `permission denied for table ...` after a successful restore

The restore ran without switching to the application user, so all objects are owned by `postgres` (the script connects as `postgres` but switches with `--role=<owner>`; this typically comes from a hand-run restore that omitted `--role`). Either redo the database — drop and recreate it, then rerun the script with the database name — or transfer ownership in place:

```sql
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO app_owner', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO app_owner', r.sequencename);
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

The dump was taken with a `pg_dump` newer than the target server (typically the image's default binary — a hand-run dump without the explicit `PG_BIN` path; the script pins `$PG_BIN` to the source major, which it verifies exists on both sides before starting). Rerun with the version-matched binary path. If the script's own pre-check fails instead (`pg_restore not present in the target image` — very old or custom images bundle fewer majors), run the dump and restore with a workstation-side PostgreSQL client of the matching major rather than the in-pod binaries.

### A database reports `FAIL ... SOURCE CHANGED DURING DUMP`

Source writes were not fully stopped: the script re-reads the source row counts after each transfer and refuses to PASS a database whose source moved mid-copy. Enforce the write stop (Step 2 — `CONNECTION LIMIT 0` plus `pg_terminate_backend`), then redo that database (`bash migrate.sh <database>` after dropping it on the target).

### Restore reports `schema "metric_helpers" already exists` (and similar)

The `-N metric_helpers -N user_management` exclusions were omitted. These errors are harmless for the excluded schemas' objects, but rerun with the exclusions for a clean, verifiable exit code.

### Rerunning after a failed restore

Drop the target database first — a partial restore leaves objects that collide (`relation already exists`, duplicate-key COPY failures). Note `DROP DATABASE` must be executed as its own single statement:

```bash
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- psql -U postgres -c "DROP DATABASE appdb"
```

Then rerun the script with **only the failed database** as an argument (`bash migrate.sh <database>`) — it recreates the database with the correct owner and locale; add `REUSE_DUMPS=1` to restore from the completed dump instead of re-dumping (only if source writes have stayed stopped). Do not rerun it without arguments after a partial success: restoring into the databases that already transferred produces `already exists` collisions that mark them as failed.

### Application passwords changed after the migration

The target CR was created **before** the credential secrets were pre-staged (Step 1), so the operator generated new passwords. To restore the source credentials after the fact, update both the secret and the role together — the secret alone is not enough, and an `ALTER ROLE` alone would be reverted by the operator's next sync from the secret. The commands below stay safe for passwords containing quotes, backslashes, or JSON metacharacters: the secret is patched with the base64 value (JSON-safe by construction), and the SQL uses psql's `:'pw'` literal quoting instead of string interpolation:

```bash
PW_B64=$(kubectl --context $SRC_CTX -n $SRC_NS get secret \
  app-owner.$SRC_CLUSTER.credentials.postgresql.acid.zalan.do -o jsonpath='{.data.password}')

kubectl --context $TGT_CTX -n $TGT_NS patch secret \
  app-owner.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do \
  --type merge -p "{\"data\":{\"password\":\"$PW_B64\"}}"

kubectl --context $TGT_CTX -n $TGT_NS exec -i $TGT_POD -c postgres -- \
  psql -U postgres -v pw="$(printf %s "$PW_B64" | base64 -d)" <<'SQL'
ALTER ROLE app_owner PASSWORD :'pw';
SQL
```

Verify with a login test as in Step 4.

### Transfer is slow

Throughput is bounded by the workstation's link to both API servers (every byte traverses it twice: exec stream in, exec stream out). Run the migration from a machine with good connectivity to both platforms (e.g. a jump host), and keep the default file mode so progress is resumable per database. If a very large restore needs parallelism, note `pg_restore -j N` cannot read from stdin — copy the dump file into the target pod (`kubectl cp`) and restore from the local path there. If the measured rehearsal duration does not fit any acceptable window, this relay is the wrong tool for that instance — plan a network-connected migration path instead.
