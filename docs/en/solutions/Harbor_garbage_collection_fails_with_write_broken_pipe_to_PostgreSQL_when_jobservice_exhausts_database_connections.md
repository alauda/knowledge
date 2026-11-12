---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion: []
---

# Harbor garbage collection fails with write broken pipe to PostgreSQL when jobservice exhausts database connections

## Issue

Harbor garbage collection (GC) no longer frees storage. In the GC history every recent run, with trigger type **Schedule** and **Manual** alike, is in the **Error** state. The GC job log stops in the mark phase with a `broken pipe` on the connection to the Harbor database on port 5432:

```text
[INFO] [/jobservice/job/impl/gc/garbage_collection.go:144]: Garbage Collection parameters: [delete_untagged: false, dry_run: false, time_window: 2]
[INFO] [/jobservice/job/impl/gc/garbage_collection.go:154]: start to run gc in job.
[ERROR] [/jobservice/job/impl/gc/garbage_collection.go:181]: failed to get deleted Artifacts in gc job, with error: write tcp <jobservice-ip>:<port>-><database-ip>:5432: write: broken pipe
[ERROR] [/jobservice/job/impl/gc/garbage_collection.go:158]: failed to execute GC job at mark phase, error: write tcp <jobservice-ip>:<port>-><database-ip>:5432: write: broken pipe
```

The `harbor-jobservice` Pod log itself can look healthy, with only periodic `reap outdated job stats` lines, and the database Pod is `Running`.

## Root Cause

### Cause 1: jobs launched by jobservice hold all PostgreSQL connections

Tasks launched by `harbor-jobservice` have piled up, failed and unfinished ones alike, and the connections they hold have used up the PostgreSQL connection limit. PostgreSQL then resets the connections of jobservice, so the GC job, which runs inside jobservice, loses its database connection while reading artifacts in the mark phase and fails with `write: broken pipe`. Every new GC run fails the same way as long as the connections are not released.

Restarting `harbor-jobservice` closes the connections it holds and GC can run again.

## Resolution

### Cause 1

1. Find the jobservice Deployment in the Harbor namespace:

   ```bash
   kubectl -n <harbor-namespace> get deployment | grep jobservice
   ```

2. Restart it to release its database connections.

   > **Warning:** Jobs running in jobservice at that moment (replication, scans, GC, retention) are interrupted and must be triggered again. Image push and pull are served by other Harbor components. Do this only when the GC log shows `write: broken pipe` to port 5432 and the database connections are exhausted (see Diagnostic Steps). A restart has nothing to roll back.

   ```bash
   kubectl -n <harbor-namespace> rollout restart deployment/<harbor-jobservice-deployment>
   kubectl -n <harbor-namespace> rollout status deployment/<harbor-jobservice-deployment>
   ```

3. Run GC manually from **Administration > Clean Up** (**Garbage Collection**) in the Harbor portal and confirm that it finishes as `Success`. The scheduled runs then succeed again. Use **Dry Run** first to see what a real run would delete.

   > **Warning:** A GC run that is not a dry run permanently deletes blobs that no artifact references, and with **Allow garbage collection on untagged artifacts** enabled it also deletes untagged artifacts. Use the same options as the scheduled job unless the registry owner has agreed to other values. Deleted blobs cannot be recovered from Harbor.

## Diagnostic Steps

1. List recent GC runs and read the log of a failed one through the Harbor API:

   ```bash
   curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/system/gc?page=1&page_size=10'
   curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/system/gc/<gc-id>/log'
   ```

   Expected for this cause: `failed to execute GC job at mark phase` with `write: broken pipe` towards port 5432. A different error in the GC log is a different problem. If the GC log shows `too many clients already (SQLSTATE 53300)` instead, the database refused a new session and restarting jobservice is not the fix; see [Harbor PostgreSQL rejects sessions with too many clients already (SQLSTATE 53300)](Harbor_PostgreSQL_rejects_sessions_with_too_many_clients_already_SQLSTATE_53300.md).

2. Check the database Pod and its log:

   ```bash
   kubectl get pod -A | grep -E 'harbor-database|harbor-pg'
   kubectl -n <harbor-namespace> logs <harbor-database-pod> --tail=300
   ```

   Look for connection-limit errors such as `FATAL: sorry, too many clients already`, `remaining connection slots are reserved`, or `SQLSTATE 53300`. Messages such as `database system was not properly shut down; automatic recovery in progress` followed by `database system is ready to accept connections` show a past database restart; they explain an earlier interruption but not a GC failure that repeats on every run.

3. Count the open connections against the limit:

   ```bash
   kubectl -n <harbor-namespace> exec <harbor-database-pod> -- psql -U postgres -c 'SHOW max_connections;'
   kubectl -n <harbor-namespace> exec <harbor-database-pod> -- psql -U postgres \
     -c "SELECT usename, client_addr, state, count(*) FROM pg_stat_activity GROUP BY 1,2,3 ORDER BY 4 DESC;"
   ```

   Expected for this cause: the total is at or near `max_connections`, and most connections come from the jobservice Pod IP. If the count is well below the limit, the broken pipe has another source, for example a database restart or a network interruption at the time of the GC run.

4. After restarting jobservice, run step 3 again: the number of connections from jobservice drops, and a manual GC run completes.
