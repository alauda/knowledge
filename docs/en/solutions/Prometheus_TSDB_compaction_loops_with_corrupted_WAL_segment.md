---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A monitoring `Prometheus` pod fails to compact its on-disk TSDB. The PersistentVolumeClaim that backs `/prometheus` keeps growing because uncompacted blocks never roll into the regular two-hour blocks. The pod log shows:

```text
caller=db.go:1014 level=error component=tsdb msg="compaction failed"
  err="WAL truncation in Compact: create checkpoint: read segments:
  corruption in segment /prometheus/wal/<NNN> at <off>: unexpected full record"
```

Restarting the pod or scaling the `StatefulSet` to zero and back to two replicas does not help — the corrupt segment is persisted on the volume, so the failure recurs immediately after the pod restarts.

## Root Cause

A Write-Ahead Log (WAL) segment under `/prometheus/wal/` has been corrupted. Because the WAL is a strictly sequential log, every later segment is unreconcilable until the corrupt one is removed: the compaction routine fails when it tries to checkpoint up to the affected offset and aborts before it can fold any in-memory block onto disk. Result: WAL keeps growing, on-disk blocks never roll, and PVC usage drifts up.

The HA pair (two `Prometheus` replicas) is what makes this safe to fix — the sibling replica continues to ingest, and the upper-layer query layer (Thanos) can dedup across the two streams while the corrupt instance is being repaired. Repair of one replica therefore does not blind the cluster to its monitoring data.

## Resolution

Remove the corrupted WAL segment from the affected pod and let TSDB reopen the database; compaction resumes from the next valid segment.

1. Identify which replica is failing and the segment number from the log:

   ```bash
   kubectl logs <prometheus-pod> -c prometheus -n <monitoring-ns> | grep "compaction failed"
   ```

   Note the failing pod (the one whose log emits the error) and the segment file (for example `00016500`). The healthy sibling continues to serve queries.

2. Open a shell into the **affected** pod and remove only the corrupt segment file. **Do not** delete the entire `/prometheus/wal/` directory — that would discard all not-yet-compacted samples on this replica:

   ```bash
   kubectl exec -it <prometheus-pod> -c prometheus -n <monitoring-ns> -- /bin/sh
   ls -lh /prometheus/wal/<NNN>
   rm /prometheus/wal/<NNN>
   exit
   ```

3. Restart the affected pod so TSDB reloads with the truncated WAL:

   ```bash
   kubectl delete pod <prometheus-pod> -n <monitoring-ns>
   ```

4. Wait for the pod to become `Ready`. Watch the log for `WAL replay completed`, then for normal `compact` lines (every two hours by default). PVC usage should plateau after the first successful compaction and gradually drop as old blocks are pruned by the configured retention.

   ```bash
   kubectl logs <prometheus-pod> -c prometheus -n <monitoring-ns> -f
   ```

5. The healthy sibling backfills the gap: queries through the upstream Thanos / store gateway dedup the two streams, so historical data for the truncation window remains available as long as one replica had it on disk.

### Underlying causes to investigate

WAL corruption is symptomatic; common root causes are:

- The PV ran out of space at the moment the WAL was being written (kernel returned a short write). Always run with at least the configured retention plus 30% headroom.
- The underlying block storage flushed a partial write (power loss on a node, storage outage, snapshot taken without quiescing).
- Filesystem-level fault on the node hosting the PV.

After applying the fix, capture the relevant volume's filesystem state and the storage class's snapshot/backup behaviour to prevent a recurrence.

## Diagnostic Steps

1. Confirm both replicas exist and identify the broken one:

   ```bash
   kubectl get pods -n <monitoring-ns> -l app.kubernetes.io/name=prometheus -o wide
   kubectl logs <prometheus-pod> -c prometheus -n <monitoring-ns> | grep -E "compaction failed|WAL"
   ```

2. Check that there is enough space on `/prometheus`; storage exhaustion is the most common WAL corruption trigger:

   ```bash
   kubectl exec -n <monitoring-ns> <prometheus-pod> -c prometheus -- df -h /prometheus
   ```

3. Inspect the WAL directory listing on the failing replica:

   ```bash
   kubectl exec -n <monitoring-ns> <prometheus-pod> -c prometheus -- ls -lh /prometheus/wal | tail -n 20
   ```

4. After the fix, verify ingestion is healthy by querying the deduplicated upstream Thanos endpoint or the Prometheus pod itself for `up{}` to confirm scrape continuity.
