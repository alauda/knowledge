---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Slow Backfill and Scrub Under the Ceph mClock OSD Scheduler
## Issue

A Ceph cluster running the mClock I/O scheduler shows symptoms that look like resource starvation on background work:

- backfill progress stalls or runs an order of magnitude slower than the cluster has historically delivered,
- regular scrubs and deep-scrubs lag behind their schedule and the `not scrubbed in time` warning starts firing,
- snaptrim activity drains slowly after large object deletes.

A `ceph config dump` reveals per-OSD `osd_mclock_max_capacity_iops_hdd` or `osd_mclock_max_capacity_iops_ssd` values that look implausible — fractions of an IOP, or several thousand IOPS for a spinner — sitting alongside OSDs whose values look sensible. The cluster integrates with ACP through the platform's Ceph storage system (`storage/storagesystem_ceph`); the platform surface manages capacity and pools, but mClock tuning happens at the Ceph layer and is what this article is about.

## Root Cause

mClock allocates I/O budget across client traffic, recovery, backfill, scrub and snaptrim using a per-OSD ceiling: the maximum IOPS the OSD claims it can sustain at a 4 KiB block size. When that ceiling is wrong, the proportional reservations downstream are wrong as well.

The ceiling is set on each OSD's first start by a short benchmark inside the OSD process. The benchmark is sensitive to host load at start time, to drives mis-classified between rotational and solid-state, and to controllers that hide caches behind the kernel. When the benchmark records `0.2` IOPS for a healthy SSD, mClock treats that OSD as a near-zero capacity device and starves it. When it records `2.9` IOPS, the same. Inflated values cause the opposite problem — mClock aggressively schedules background work and client I/O suffers.

A second, distinct cause affects rotational devices specifically. On older Ceph releases the per-OSD shard counters (`osd_op_num_shards_hdd`, `osd_op_num_threads_per_shard_hdd`) defaulted to values that cap throughput on real HDDs. Newer releases ship corrected defaults; on older clusters the values must be set by hand.

## Resolution

Walk the layers in order: profile, then capacity, then HDD shards. Skipping ahead misses the cheap wins.

1. **Inspect and choose an mClock profile that matches the operational priority.** The default `balanced` profile gives client and background work an even split. `high_recovery_ops` favours recovery and backfill for the duration of an incident; `high_client_ops` does the opposite. Switch only for as long as needed.

   ```bash
   ceph config get osd osd_mclock_profile
   ceph config set osd osd_mclock_profile high_recovery_ops
   ```

2. **Identify OSDs whose benchmark capacity is unrealistic.** Dump the per-OSD overrides and look for outliers — sub-1 IOPS values are a sure sign of a failed benchmark, three-digit values for SSDs are a sign the device class is wrong, and four-digit values for HDDs are similarly suspicious.

   ```bash
   ceph config dump | grep -E "WHO|mclock_max_capacity"
   ```

3. **Re-benchmark each OSD honestly, off the production hot path.** Drop the cache first, then run the benchmark and read out the IOPS line. The script below iterates every OSD; pass an explicit list when the cluster is too large to bench all at once.

   ```bash
   for X in $(ceph osd ls); do
     printf "osd.%s: " "$X"
     ceph tell osd.${X} cache drop
     ceph tell osd.${X} bench 12288000 4096 4194304 100 2>&1 | grep iops
   done
   ```

4. **Apply the resulting capacity per device class.** Round HDD results up by 100 (typical sustained 4 KiB random write capacity for a healthy spinner is well under 800), round SSD results up by 5000. Clear any per-OSD overrides first so the cluster-wide value takes effect, then set the cluster-wide ceiling.

   ```bash
   for OSD in $(ceph osd ls); do
     ceph config rm osd.${OSD} osd_mclock_max_capacity_iops_hdd
     ceph config rm osd.${OSD} osd_mclock_max_capacity_iops_ssd
   done
   ceph config set osd osd_mclock_max_capacity_iops_hdd 600
   ceph config set osd osd_mclock_max_capacity_iops_ssd 25000
   ```

   For a single OSD whose benchmark is known-good, set the per-OSD value instead and leave the rest on the cluster-wide default:

   ```bash
   ceph config set osd.<OSD-ID> osd_mclock_max_capacity_iops_ssd <SSD_MAX_IOPS>
   ```

5. **For HDD-backed OSDs only, raise the shard counters and restart.** This change must not be applied to SSDs or to drives that the OS has misclassified as rotational; verify the device class first.

   ```bash
   ceph config set osd osd_op_num_shards_hdd 1
   ceph config set osd osd_op_num_threads_per_shard_hdd 5
   ```

   The OSD must restart to pick up the shard configuration. Drain and recycle one OSD at a time to keep the cluster healthy during the change.

6. **If recovery and client I/O still need rebalancing, allow the operator overrides.** Setting `osd_mclock_override_recovery_settings: true` re-enables `osd_max_backfills` and `osd_recovery_max_active_*` so the rate can be tuned manually. Use this when mClock's profile-based shape does not match the workload.

7. **Distinguish recovery from backfill before declaring "slow".** A recovery (data is at risk, e.g. failed disk) is intentionally faster than a backfill (data is not at risk, e.g. PG re-balance). The same cluster will look "slow" if a backfill is benchmarked against the recovery rate seen the previous week. Verify which kind of work is actually running before tuning further.

## Diagnostic Steps

Confirm the device-class detection matches the underlying hardware. A drive labelled `hdd` here will receive HDD defaults regardless of what kind of media it really is.

```bash
ceph osd crush class ls-osd ssd | head
ceph osd crush class ls-osd hdd | head
```

Cross-check the runtime ceilings against the per-class defaults (HDD default ~315, SSD default ~21500):

```bash
ceph config help osd_mclock_max_capacity_iops_hdd
ceph config help osd_mclock_max_capacity_iops_ssd
ceph config dump | grep mclock
```

Watch backfill and recovery throughput before and after each change so the tuning effect is measurable rather than asserted:

```bash
ceph status
ceph -s -f json | jq '.pgmap | {recovering_objects_per_sec, recovering_bytes_per_sec, num_pgs}'
```

If the benchmark is still returning unrealistic values after `ceph tell osd.<id> cache drop` and a quiet host (low load average, no concurrent backfill), accept the current defaults instead of writing back the bad number. A wrong manual value is worse than the documented default. On clusters running the corrected releases the OSD will fall back to a sane default automatically when the benchmark detects an implausible result.
