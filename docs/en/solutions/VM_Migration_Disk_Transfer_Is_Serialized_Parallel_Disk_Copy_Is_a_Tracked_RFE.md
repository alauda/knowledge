---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM Migration Disk Transfer Is Serialized — Parallel Disk Copy Is a Tracked RFE
## Overview

When migrating a multi-disk VM from VMware (or another source hypervisor) into ACP Virtualization through the migration toolkit, operators observe that the disk transfers happen **sequentially** — one disk at a time. For a VM with several large disks, this sets the total migration time at the sum of per-disk copy times, rather than the maximum of them.

The question is whether the toolkit supports parallel disk copy to shorten that wall-clock time.

## Current Behaviour

The migration toolkit's disk-transfer orchestration invokes the underlying v2v converter per disk in sequence. Specifically:

1. The toolkit reads the source VM's disk list.
2. For each disk, the toolkit starts a v2v transfer, waits for it to complete, then moves to the next.
3. The VM's migration cannot complete until every disk has transferred.

A VM with four 500 GiB disks therefore migrates in roughly four times the per-disk transfer duration, not in the fastest-disk's duration.

The underlying `virt-v2v` converter itself has gained support for parallel disk copy in recent versions. The toolkit's orchestration layer, however, does not yet drive that parallelism — the integration work to pipeline multiple disks through v2v concurrently is a separate concern and is still in development. The ability to parallelise is therefore latent in the stack but not yet exposed through the toolkit's Plan / Migration flow.

This limitation is tracked as a Request for Enhancement (RFE) against the migration toolkit. Future toolkit releases will expose a `spec.diskTransferConcurrency` (or similarly named) field on the `Plan` or `Migration` CR; the v2v engine's existing parallel path will be activated from there.

## What to Do Today

Until parallel disk copy is exposed, the practical options are:

### 1. Parallelise at the VM level, not the disk level

Migrate multiple VMs **concurrently** rather than expecting a single VM to finish faster. The toolkit already runs multiple VM migrations in parallel (governed by the Plan's worker concurrency and the cluster's available CDI importer pods). A batch of many small VMs finishes faster than the wall-clock time the same total data would take on a serialised-per-disk single-VM migration.

Practical tuning:

- Set the Plan's concurrency to a reasonable multiple of available network bandwidth / CDI importer capacity.
- Group VMs in batches such that the sum of their largest disks fits under the cluster's transfer bandwidth budget; prioritise batches that parallelise well.

### 2. Start with cold migration for large multi-disk VMs

A cold migration (VM is stopped at the source, disks are transferred in full, VM is restarted at the destination) also runs disks serially, but each disk's transfer is faster — no warm-migration overhead (no snapshot chains, no dirty-page tracking). For very large VMs, the absolute wall-clock time of a cold migration with serial transfers can still beat the warm-migration alternative.

### 3. Pre-seed the destination through storage-level replication

If the source and destination share a storage platform that supports block-level replication (e.g. same storage array with replication between source VMware datastore and destination ACP storage class), replicate the disks out-of-band before the migration runs. The toolkit's migration then mostly serves as the metadata swap — the disk transfer is a no-op because the blocks are already in place.

This is storage-platform-specific and not available on every backend. Where it is available, it can cut migration time for the largest VMs by an order of magnitude.

### 4. Wait for the RFE

For non-urgent migrations, wait for the toolkit release that exposes parallel disk copy. The RFE is tracked internally; check the platform's release notes when new operator versions become available. Once the feature ships, a single config field on the Plan will unlock the existing parallelism in `virt-v2v`.

## What Not to Do

- **Do not manually split a multi-disk VM into single-disk VMs before migration.** The split changes the VM's identity (PCI layout, disk order), breaks in-guest references (`/etc/fstab`, drive letters on Windows), and often requires guest-side reconfiguration on the destination.
- **Do not edit the toolkit's pod templates to force concurrent v2v invocations.** The orchestration layer synchronises disk transfers for correctness (one completed disk before the next starts); running v2v twice against the same source VM can corrupt the snapshot chain the toolkit is relying on.

## Diagnostic Steps

Confirm that disks are indeed transferring serially in your case:

```bash
MIG_NS=<forklift-ns>
PLAN=<plan-name>

# List the VMs in the plan and their progress.
kubectl -n "$MIG_NS" get plan "$PLAN" -o json | \
  jq '.status.migration.vms[] | {name, phase, progress: (.disks // [])}'
```

The `disks` array records per-disk state. At any moment, at most one disk per VM is `Copying`; the others are either `Pending` (not yet started) or `Completed`.

Track per-disk start and completion times:

```bash
kubectl -n "$MIG_NS" get plan "$PLAN" -o json | \
  jq '.status.migration.vms[].disks[] |
      {name, phase, startedAt: .startedAt, finishedAt: .finishedAt}'
```

Measure the gaps between one disk finishing and the next starting — should be small (seconds). A very long gap indicates something beyond the "serial" design is happening (transfer pod failed to schedule, importer pod stuck, etc.) and is worth investigating separately.

For total migration time estimation: sum the per-disk transfer durations and add a small orchestration overhead. That product is the wall-clock time to plan for until the parallel-copy feature ships. Budgeting migrations around that number lets operations teams stagger batches across maintenance windows appropriately.
