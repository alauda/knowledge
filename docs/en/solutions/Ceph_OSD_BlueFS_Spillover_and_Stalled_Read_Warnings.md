---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Ceph cluster backing the ACP Storage layer reports one or more of the following health warnings in `ceph health detail`, possibly simultaneously:

```text
HEALTH_WARN 11 OSD(s) experiencing BlueFS spillover;
            8 OSD(s) experiencing slow operations in BlueStore;
            9 OSD(s) experiencing stalled read in db device of BlueFS
[WRN] BLUEFS_SPILLOVER: osd.<n> spilled over 8.7 GiB metadata from 'db'
      device (87 MiB used of 124 GiB) to slow device
[WRN] BLUESTORE_SLOW_OP_ALERT: osd.<n> observed slow operation indications in BlueStore
[WRN] DB_DEVICE_STALLED_READ_ALERT: osd.<n> observed stalled read indications in DB device
```

Client I/O is typically not affected — RBD and CephFS workloads on top of the cluster continue to meet their latency SLOs — but the warnings are loud and persistent, and the operator reasonably wants them to clear.

## Root Cause

These are three related alerts surfaced by the Ceph cluster that package the same underlying primitives. They fall into two distinct buckets.

### Bucket 1 — stalled read / slow operation in BlueStore or BlueFS DB

These two alerts were added in Ceph 8.1 and their triggering logic is extremely asymmetric: the OSD tracks every read against the RocksDB / BlueFS DB device, and if *one* read breaches the slow or stalled threshold, the alert fires and holds the device in `slow` or `stalled` state for the next 24 hours regardless of how many millions of subsequent reads complete normally. A single outlier read — from a transient queue spike, a scrub kick-off, or a device firmware-level hiccup — is enough to light the warning for a day.

As a result, the alert correlates only weakly with a real client-facing performance problem. It is best read as "one read was slow once in the last 24 hours", not "the DB device is currently unhealthy". This is why the workaround for it is to dial the alert's lifetime down rather than to chase per-OSD latency symptoms.

### Bucket 2 — BlueFS spillover

This is a distinct, unrelated issue. BlueFS (the filesystem underneath RocksDB inside each OSD) can end up reporting "spilled metadata to slow device" even when the DB device has essentially unused capacity — the example output shows `87 MiB used of 124 GiB` alongside a claim of 8.7 GiB spillover, which is self-contradictory. The root cause is a bookkeeping bug in how BlueFS accounts for spillover across its file set. A double offline compaction of the affected OSD rewrites those files and reconciles the accounting.

## Resolution

### Preferred: ACP Ceph storage (`storage/storagesystem_ceph`)

When Ceph is deployed through ACP Storage (`storage/storagesystem_ceph`), the OSD daemons run as rook-managed StatefulSets / Deployments in a dedicated storage namespace. All commands below assume that namespace — typically `cpaas-system` or the namespace chosen for the storage system — and that the Rook toolbox (or an equivalent pod with `ceph` / `rados` clients) is available.

#### Clear the stalled-read / slow-op warnings (Bucket 1)

Shorten the alert's lifetime so that a single outlier read does not hold the warning for 24 hours. Zero disables the hold entirely:

```bash
ceph config set global bdev_stalled_read_warn_lifetime 0
ceph config set global bluestore_slow_ops_warn_lifetime 0
```

Setting this globally is safe because the alerts are advisory; neither flag throttles I/O or disables the counters, it only controls how long a single event keeps the cluster in `HEALTH_WARN`.

#### Clear the BlueFS spillover warnings (Bucket 2) — double offline compaction

For each affected OSD, run a two-pass `osd_compact_on_start` cycle. The example uses `osd.3`; repeat for every OSD listed in the warning.

1. **Enable compaction on the next OSD start and record the current BlueFS usage for comparison.**

   ```bash
   ceph config set osd.3 osd_compact_on_start true
   ceph tell osd.3 perf dump | awk '/\"bluefs\"/,/^ +}/' | head -n 12
   ```

   Keep the `db_used_bytes` and `slow_used_bytes` values for comparison.

2. **Restart the OSD pod.** The deployment name in ACP Ceph storage is `rook-ceph-osd-<id>`:

   ```bash
   NS=<storage-namespace>
   kubectl -n "$NS" scale deploy rook-ceph-osd-3 --replicas=0
   sleep 4
   kubectl -n "$NS" scale deploy rook-ceph-osd-3 --replicas=1
   ```

3. **Wait for the OSD to be fully `up` and `in`, then dump stats again.** The `ceph -s` output moves through `osd: X osds: X up ..., X-1 in` and settles at `X up, X in`:

   ```bash
   ceph -s | grep 'osd:'
   ceph tell osd.3 perf dump | awk '/\"bluefs\"/,/^ +}/' | head -n 12
   ```

4. **Repeat steps 2 and 3 one more time.** After the second restart, `slow_used_bytes` should be `0` and `db_used_bytes` should have shrunk as the compaction rewrites the BlueFS files.

5. **Remove the per-OSD override** once compaction is complete so the setting does not persist into future restarts:

   ```bash
   ceph config rm osd.3 osd_compact_on_start
   ```

6. **Iterate across the affected OSD set.** Do this serially, not in parallel — each restart briefly removes an OSD from the cluster, and compacting many simultaneously depresses recovery headroom. A simple loop wrapped around the same 5 steps, with a wait between OSDs for PGs to settle, is sufficient.

Do **not** open a support case for either bucket of warnings as a reflex. Both are cosmetic: the stalled-read / slow-op alerts are fixed by the lifetime setting and the spillover warning is fixed by double compaction. A support case should be escalated only if, after applying the workaround, the warning persists *or* client-side latency metrics are regressing in a way that maps to the affected OSDs.

### OSS fallback: self-managed Ceph / Rook

If Ceph is deployed directly (a Rook operator installation outside ACP Storage, or a stand-alone Ceph cluster), the commands are identical — `ceph config set`, `ceph tell osd.<n> perf dump`, `osd_compact_on_start` — and the OSD restart is either `kubectl scale deploy rook-ceph-osd-<n>` (Rook) or `ceph orch daemon restart osd.<n>` (cephadm).

## Diagnostic Steps

Before applying the workarounds, confirm the warnings map to one of the two buckets and capture evidence in case the workaround does not clear them.

1. **Enumerate the affected OSDs.**

   ```bash
   ceph health detail
   ```

   Note every `osd.<n>` listed per warning type.

2. **Collect per-OSD BlueFS stats for the "spillover" set** — these numbers are what will change after the double compaction and are worth capturing for later comparison:

   ```bash
   for osd in 71 79 80; do
     echo "== osd.$osd =="
     ceph tell osd.$osd perf dump | awk '/\"bluefs\"/,/^ +}/' | head -n 12
   done
   ```

3. **For stalled-read / slow-op warnings, pull the OSD log lines that triggered them.** On an ACP Ceph storage deployment, the OSD logs live on the host under a rook-managed path; `kubectl logs` on the OSD pod works as well:

   ```bash
   NS=<storage-namespace>
   kubectl -n "$NS" logs deploy/rook-ceph-osd-3 --tail=10000 \
     | grep -iE 'stalled read|slow operation|spillover'
   ```

   Expect to see only a small number of events — usually one or two — triggering the alert. A steady stream of slow-op events across many OSDs is a different problem (noisy neighbor, degraded hardware, network congestion) and needs to be investigated outside this runbook.

4. **Confirm client I/O is unaffected.** The warnings are advisory only when client latency is stable:

   ```bash
   ceph -s
   ceph osd perf
   ```

   `ceph osd perf` should show per-OSD commit and apply latencies in the low single-digit-millisecond range for HDD pools and sub-millisecond for SSD/NVMe pools. If latencies are climbing alongside the warnings, investigate the underlying devices before treating the alerts as cosmetic.
