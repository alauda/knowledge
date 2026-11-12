---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Harbor PostgreSQL rejects sessions with too many clients already (SQLSTATE 53300)

## Issue

Harbor garbage collection (GC) fails as soon as it starts, or `harbor-core` cannot open a database session. The GC job log or the core log shows:

```text
failed to execute GC job at mark phase ... too many clients already (SQLSTATE 53300)
```

The error is raised while dialing the Harbor PostgreSQL Service, for example `acid-<cluster>.<namespace>.svc:5432`. The database Pod is Running and the Service has endpoints, so the database looks healthy.

Related articles: [Harbor PostgreSQL database Pod never starts after an operator upgrade, with transparent huge pages, low CPU, or on NFS](Harbor_PostgreSQL_database_Pod_never_starts_after_an_operator_upgrade_with_transparent_huge_pages_low_CPU_or_on_NFS.md) covers a database that does not start at all.

## Root Cause

### Cause 1: the PostgreSQL instance has no free client slots

`SQLSTATE 53300` means PostgreSQL refused a new session because `max_connections` is reached. Harbor GC then cannot open a session during the mark phase. A Running database Pod and a healthy Endpoint do not rule this out.

A small instance (1 CPU / 2 GiB) with default connection settings can run out of slots under Harbor's load. Raising the instance to 2 CPU / 4 GiB and setting `max_connections`, `shared_buffers`, `work_mem`, and `effective_cache_size` clears the GC failure.

If `harbor-notary-server` is crash-looping with `transport: x509: certificate has expired or is not yet valid`, the sessions are being used up by Notary reconnects. Fix the Notary certificate first (see [Harbor notary-server fails with an expired x509 certificate on ACP](Harbor_notary-server_fails_with_an_expired_x509_certificate_on_ACP.md)); the parameter change below is for a database that rejects sessions while Notary is not in that restart loop.

GC that fails at the mark phase with `write: broken pipe` on port 5432 and no `SQLSTATE 53300` is a different problem: the database already reset sessions held by jobservice. See [Harbor garbage collection fails with write broken pipe to PostgreSQL when jobservice exhausts database connections](Harbor_garbage_collection_fails_with_write_broken_pipe_to_PostgreSQL_when_jobservice_exhausts_database_connections.md).

## Resolution

### Cause 1

1. Read the live limit, the session count, and the current instance size, and keep a copy of the current values:

   ```bash
   PG_NS=<postgresql-namespace>
   PG_POD=<acid-pod>
   kubectl -n "$PG_NS" exec "$PG_POD" -- psql -U postgres -c "SHOW max_connections;"
   kubectl -n "$PG_NS" exec "$PG_POD" -- psql -U postgres -c \
     "SELECT state, count(*) FROM pg_stat_activity GROUP BY 1;"
   kubectl -n "$PG_NS" get postgresql <cluster> -o yaml > "$HOME/<cluster>-before.yaml"
   kubectl -n "$PG_NS" get postgresql <cluster> -o yaml | sed -n '/resources:/,/volume:/p'
   ```

2. Raise the instance size and the connection parameters. The values below recovered a 1 CPU / 2 GiB instance whose sessions were at the limit. On a larger instance, set `max_connections` above the current `SHOW max_connections` value and raise memory with it, keeping `shared_buffers` within the instance memory.

   > **Warning:** Only when the error is `too many clients already (SQLSTATE 53300)`, the session count is at `max_connections`, and Notary is not restarting on an expired certificate. Impact: patching `spec.resources` and `spec.postgresql.parameters` makes the PostgreSQL operator restart the database Pods; Harbor cannot connect until they are Ready. Precondition: a maintenance window and the copy saved in step 1. Rollback: patch the previous `resources` and `parameters` values back.

   ```bash
   kubectl -n "$PG_NS" patch postgresql <cluster> --type=merge -p '{
     "spec": {
       "resources": {
         "requests": {"cpu": "2", "memory": "4Gi"},
         "limits": {"cpu": "2", "memory": "4Gi"}
       },
       "postgresql": {
         "parameters": {
           "max_connections": "200",
           "shared_buffers": "1GB",
           "work_mem": "64MB",
           "effective_cache_size": "2GB"
         }
       }
     }
   }'
   kubectl -n "$PG_NS" get postgresql <cluster> -o jsonpath='{.status.PostgresClusterStatus}{"\n"}'
   ```

3. When `PostgresClusterStatus` is `Running` and `SHOW max_connections` returns the new value, run GC again.

## Diagnostic Steps

1. Read the log of the failed GC run through the Harbor API:

   ```bash
   curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/system/gc?page=1&page_size=10'
   curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/system/gc/<gc-id>/log'
   ```

   Expected for this cause: `too many clients already (SQLSTATE 53300)`.

2. Compare the session count with the limit (step 1 of the Resolution). Expected: the total is at `max_connections`. If it is well below the limit, this is not the cause.

3. Check Notary:

   ```bash
   kubectl -n <harbor-namespace> logs deploy/<harbor-notary-server-deployment> --tail=100 | grep -i x509
   ```

   Expected for this cause: no `certificate has expired` lines.

4. If `psql` inside the Pod asks for a password, the admin password is in the Secret `postgres.<cluster>.credentials.postgresql.acid.zalan.do`, key `password`:

   ```bash
   kubectl -n "$PG_NS" get secret "postgres.<cluster>.credentials.postgresql.acid.zalan.do" \
     -o jsonpath='{.data.password}' | base64 -d; echo
   ```

| What you see | Where to go |
| --- | --- |
| `SQLSTATE 53300`, database Pod Running, Notary healthy | Cause 1 here |
| GC fails at the mark phase with `write: broken pipe` on port 5432, no `SQLSTATE 53300` | Harbor GC broken pipe article above: restart `harbor-jobservice` |
| Notary log has `certificate has expired`, sessions climb after each Notary restart | Notary certificate article above |
| Database Pod missing, Pending, or not starting | Harbor PostgreSQL database Pod never starts article above |
