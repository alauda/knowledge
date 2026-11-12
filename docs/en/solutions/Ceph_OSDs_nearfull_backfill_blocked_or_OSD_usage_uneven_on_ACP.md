---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.2.x
  - 4.3.x
---

# Ceph OSDs nearfull, backfill blocked, or OSD usage uneven on ACP

## Issue

Ceph distributed storage on Alauda Container Platform raises a capacity or distribution alert, and some OSDs really are fuller than others. Typical shapes:

- `HEALTH_WARN` with `backfillfull` / `nearfull` OSDs and pools, OSD usage alerts above 75% or 80% for several OSDs of one device class and for the cluster, and an application on Ceph that fails when it restarts.
- `1 nearfull osd(s)` and `2 pool(s) nearfull`, with spare disks already in the servers.
- `PG_BACKFILL_FULL`, `backfill_toofull` PGs, and `nearfull` pools right after a disk was added on the Device Class page.
- A PG-distribution alert: one OSD's PG count differs from the average by more than 30%, the cluster is otherwise usable, and the disks are not the same size.
- A device-class usage alert says an OSD is over 75% while a Ceph upgrade is waiting.
- A small OSD sits near 80% while newly added large OSDs are at 8–10%, and `ceph osd reweight <id> 2` fails with `Invalid command: 2.0 not in range [0.0, 1.0]`.
- An S3 client finds the bucket and then fails with `Unable to execute HTTP request: Read timed out` when setting a bucket policy or CORS rules.

Environment: toolbox `deploy/rook-ceph-tools` and cluster object `CephCluster` in namespace `rook-ceph`. `ceph osd reweight` takes a value from 0.0 to 1.0. `ceph osd crush reweight` sets the size-based CRUSH weight, which Rook sets from the disk size when the OSD is created.

## Root Cause

### Cause 1: the whole device class is full

`ceph osd df tree` shows the OSDs of one class at similar `%USE` with `VAR` near 1: the class is full, not skewed. `ceph health detail` lists `nearfull` and `backfillfull` OSDs and pools (for example `osd.2` at backfillfull and `osd.5` at nearfull, with pools such as `.mgr`, `cephfs-metadata`, and `cephfs-data0` unable to backfill). Workloads whose PVCs are on that class can fail when they restart. Reweighting moves data inside the class and frees nothing.

### Cause 2: PG_BACKFILL_FULL after a device add dropped an existing disk from CephCluster

On the ACP 4.3.1 Device Class page, the page did not show the disks a node already had. Submitting a new disk for that node (for example `sde` next to an existing `sdd`) rewrote `CephCluster` `spec.storage` without the old device. The old OSD kept running, but the CR no longer declared its disk. That OSD then sat near full (for example about 80% with a large omap object) and backfill could not finish. A deep scrub of the affected PGs found no object corruption.

### Cause 3: ceph_osd_numpg differs from the average by more than 0.3

The alert compares `ceph_osd_numpg` with the per-job average and fires above `0.3`. With OSDs of different sizes, the PG counts are naturally skewed against a 30% threshold. Ceph usage itself is normal. This is not the same fault as a nearfull OSD.

### Cause 4: device-class usage over 75% while a Ceph upgrade is waiting

An alert says an OSD in a device class (for example `nvme`) is over 75% and advises freeing space or expanding the class. When this happened on ACP 3.18.2 before Ceph itself was upgraded, the Ceph service was disrupted and recovered once capacity was expanded. The upgrade was held until the service recovered.

### Cause 5: one nearfull OSD and nearfull pools, with spare disks not yet added

One device class crossed the nearfull threshold while the cluster as a whole was not full. For example, `ceph osd df` showed the six OSDs of a custom class far above the rest (one at `86.68` %USE with `VAR 3.72`), overall usage at `23.29`%, and `MIN/MAX VAR: 0/3.72`; `ceph osd tree` showed every OSD `up` with REWEIGHT `1.00000`. Spare disks were on the nodes but not yet OSDs.

### Cause 6: a small OSD stays near full after large OSDs were added

`ceph osd df` shows mixed sizes: small OSDs (for example 1.1 TiB, CRUSH WEIGHT `1.09059`) with one at about 80% (`VAR 3.91`), and new large OSDs (7.3 TiB, CRUSH WEIGHT `7.27689`) at 8–10%. The small OSD held a lot of data historically, and that usage does not come down by itself. The large OSDs already have a CRUSH weight that matches their size. `ceph osd reweight` accepts only 0 to 1, so setting the large OSDs to 2 is not valid:

```text
Invalid command: 2.0 not in range [0.0, 1.0]
osd reweight <id|osd.id> <weight:float> :  reweight osd to 0.0 < <weight> < 1.0
Error EINVAL: invalid command
```

### Cause 7: S3 Read timed out because Ceph usage is at its storage limit

The bucket exists, but later S3 calls (for example setting a public-read policy or CORS rules) fail with `Unable to execute HTTP request: Read timed out`. Ceph usage had reached the configured storage limit. It is not a bad access key.

## Resolution

Save the current values before changing anything:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd dump | grep -E 'full_ratio|nearfull|backfillfull'
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config get osd osd_max_backfills
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd df tree
```

### Cause 1: the whole device class is full

1. Check whether the storage nodes have disks that are not yet OSDs (`lsblk` on each node), and how much each pool uses (`ceph df`).
2. Add capacity: add disks to that device class on the existing storage nodes, in a maintenance window, so the new OSDs join the class the full pools use. Or delete business data from the pools on that class.
3. If no disk can be added right away, raise the thresholds temporarily, following the product documentation topic "Setting Ceph OSD Full Thresholds". Raise `backfillfull` above the fullest OSD's usage so backfill can run.

> **Warning:** Raising `nearfull`, `backfillfull`, and `full` lets Ceph fill disks closer to 100%; an OSD that reaches 100% stops IO and leaves no room to recover. Precondition: the current values are saved, the order `nearfull` < `backfillfull` < `full` is kept, and the increase is as small as possible. Rollback: set the saved values back once capacity is added or data is removed. This is not a substitute for adding disks.

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set-nearfull-ratio 0.88
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set-backfillfull-ratio 0.92
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set-full-ratio 0.96
```

To keep the values from being reconciled back, set them in the `CephCluster` CR (`spec.storage.nearFullRatio`, `backfillFullRatio`, `fullRatio`):

```bash
kubectl patch cephcluster <cephcluster-name> -n rook-ceph --type merge \
  -p '{"spec":{"storage":{"nearFullRatio":0.88,"backfillFullRatio":0.92,"fullRatio":0.96}}}'
```

4. Before restarting an affected workload, check that its PVC still exists:

```bash
kubectl -n <namespace> get pvc
kubectl -n <namespace> rollout restart deploy/<workload>
```

### Cause 2: PG_BACKFILL_FULL after a device add dropped an existing disk from CephCluster

If the OSD is still `up` and you have the `CephCluster` YAML from before the submit, put the dropped device path back under that node's `spec.storage.nodes` with `kubectl -n rook-ceph edit cephcluster <name>`.

If the OSD has to be rebuilt instead:

> **Warning:** Relaxing the full ratios, raising `osd_max_backfills`, or lowering a CRUSH weight lets Ceph place data closer to a full disk. Precondition: every value you change is saved, and you are in a maintenance window. Rollback: restore the saved values when `ceph -s` is `HEALTH_OK`, including `ceph osd crush reweight osd.<id> <saved-weight>`.

1. Lower the stuck OSD's CRUSH weight (for example to `0.6`) and set temporary values only as high as backfill needs:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush reweight osd.<id> 0.6
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_max_backfills <temporary-max>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set-backfillfull-ratio <temporary-ratio>
```

> **Warning:** `ceph osd out`, `crush remove`, `auth del`, and `osd rm` drop this OSD id. PGs whose only remaining copy is on it are lost. Precondition: `ceph pg dump` shows another `up` copy for its PGs, and the `CephCluster` YAML is saved. Rollback: re-add the disk and let backfill copy data back; Ceph does not undo `osd rm`.

2. Remove the OSD from the toolbox:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd out osd.<id>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush remove osd.<id>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph auth del osd.<id>
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd rm osd.<id>
```

> **Warning:** `wipefs -af` and `sgdisk --zap-all` erase the disk. Run them on the node, not in the toolbox. Precondition: `lsblk` and the OSD metadata agree this is the disk you just removed, not the OS disk and not another OSD. Rollback: none.

3. Wipe the disk on the node:

```bash
wipefs -af /dev/<device>
sgdisk --zap-all /dev/<device>
```

4. Add the disk again through the device class, including every disk already declared for that node. After the new OSD is up, set its device class to the class the pool's CRUSH rule selects, using the id `ceph osd tree` shows:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush set-device-class <device-class> osd.<id>
```

5. When backfill has caught up and `ceph -s` is `HEALTH_OK`, restore the saved ratios, `osd_max_backfills`, and CRUSH weight.

### Cause 3: ceph_osd_numpg differs from the average by more than 0.3

1. Confirm the skew comes from disk size, not from a stuck balancer or a full OSD:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd df
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph balancer status
```

2. The long-term fix is to use disks of the same size. To stop the unnecessary alert meanwhile, save the alert's current threshold and raise it above the skew `ceph osd df` shows; restore it once the disks match. Find the rule in the console alert editor or with:

```bash
kubectl get prometheusrule -A -o json | grep -n ceph_osd_numpg
```

Changing the threshold only changes when the alert fires; it does not move PGs.

### Cause 4: device-class usage over 75% while a Ceph upgrade is waiting

Expand the device class, or free space in it, before starting the Ceph upgrade. After the expansion, check `ceph -s` and `ceph osd df tree` again, and start the upgrade only when Ceph is healthy.

### Cause 5: one nearfull OSD and nearfull pools, with spare disks not yet added

1. Find the device class of the nearfull OSDs. New disks relieve only the pools whose CRUSH rule selects the class the new OSDs join:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd df tree
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush class ls
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool ls detail
```

2. Add the spare disks to that device class in a maintenance window (for example in the evening), then watch the rebalance with `ceph -s`. If client latency is already high, leave the recovery and backfill speeds as they are; the rebalance finishes on its own.
3. If `ceph -s` shows `noscrub,nodeep-scrub flag(s) set` during the rebalance, scrubbing is paused for the whole cluster. When no PG is `backfilling` or `backfill_wait`, clear the flags:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset noscrub
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset nodeep-scrub
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
```

If `nearfull` is still listed for the same OSD afterwards, the new disks did not join the full class, or that OSD needs the override in Cause 6.

### Cause 6: a small OSD stays near full after large OSDs were added

Lower the override weight of the hot small OSD. Start mild (for example `0.95`) off-hours; a stronger value such as `0.5` moves much more data. Values above 1 are rejected.

> **Warning:** `ceph osd reweight` starts a rebalance away from that OSD, and client IO rises until PGs settle. Precondition: the hot OSD is the small historical one, the large OSDs are nearly empty, the current reweight (normally 1) is saved, and you are off-hours. Rollback: `ceph osd reweight <id> <saved-value>`.

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd reweight <id> 0.5
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

When `ceph osd df` shows the OSD well below the danger line and backfill is finished, restore the saved reweight.

### Cause 7: S3 Read timed out because Ceph usage is at its storage limit

Confirm that usage is at the configured limit (`ceph df`, `ceph health detail`). Raising the limit temporarily restores service; then add disks and clean up business data so usage stays below it. An `InvalidAccessKeyId` error is a credentials problem, not this cause.

## Diagnostic Steps

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd df tree
kubectl -n rook-ceph get cephcluster -o yaml > cephcluster-now.yaml
```

Read `%USE` and `VAR` per device class; a low overall `%RAW USED` does not rule out one full class.

- Every OSD of the class evenly high (`VAR` near 1): Cause 1. Add disks; do not reweight.
- `PG_BACKFILL_FULL` and a device path missing from `spec.storage.nodes` while the OSD still exists: Cause 2.
- PG-distribution alert above 0.3 with unequal disk sizes and normal usage: Cause 3.
- Usage alert over 75% before a Ceph upgrade: Cause 4.
- `nearfull osd` / `pools nearfull` with spare disks not yet in the device class: Cause 5.
- One small OSD near full, large OSDs nearly empty, or `Invalid command: 2.0 not in range [0.0, 1.0]`: Cause 6.
- S3 `Read timed out` after the bucket was found, with usage at the limit: Cause 7.
