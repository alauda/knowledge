---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A warm migration of a Windows VM from VMware into the cluster's virtualization stack fails during the **inspection** phase — before any disk-conversion work has started. The inspector pod (the one that runs `virt-v2v-inspector` on a snapshot of the source disk) reports that the NTFS filesystem could only be mounted read-only:

```text
command: mount '/dev/sdb3' '/sysroot/'
The disk contains an unclean file system (0, 0).
Metadata kept in Windows
libguestfs: trace: v2v: touch = -1 (error)
virt-v2v-inspector: error: filesystem was mounted read-only, even though we
   asked for it to be mounted read-write. This usually means that the
   filesystem was not cleanly unmounted.
Original error message: touch: open: /sw4nm7p3: Read-only file system
```

The same VM may have been migrated successfully before, or a different VM on the same vCenter goes through cleanly — the failure is per-source-VM, not per-cluster.

## Root Cause

A warm migration starts by asking VMware to take a *quiesced* snapshot of the source disk. Quiescing means VMware Tools inside the guest is asked to flush all in-memory writes to disk and pause new writes momentarily, so the snapshot captures a self-consistent NTFS state. The component on the Windows side that performs the quiesce is the **VMware Snapshot Provider** service. Without it, vCenter cannot drive a quiesced snapshot — it falls back to a **crash-consistent** snapshot, which is logically identical to pulling the power cord on a running Windows machine.

A crash-consistent NTFS snapshot has the *dirty bit* set: the filesystem was running, the journal has uncommitted entries, the in-memory metadata was not flushed. When the migration's inspector mounts that disk, libguestfs sees the dirty NTFS, refuses to mount it read-write to avoid corrupting the metadata, and falls back to read-only. The inspector then tries to write a small tracking file (`touch /sw4nm7p3` etc.) and fails with `Read-only file system`.

The ultimate cause is therefore on the source side: **VMware Snapshot Provider is disabled, missing, or not running** on the source Windows VM.

## Resolution

Make sure the snapshot provider service is up on the source VM, then restart the migration. The cluster-side configuration does not need to change.

### 1. Enable VMware Snapshot Provider on the source

On the source Windows VM (still on its original hypervisor):

1. Open `Services.msc`.
2. Locate **VMware Snapshot Provider**.
3. Confirm the *Startup type* is **Manual** (the default) or **Automatic**.
4. If the service is stopped, click **Start**. The service runs only briefly when a snapshot is taken; *Manual* with the binary present is the supported steady state — it does not need to keep running idle.

If the service is missing entirely from `Services.msc`, VMware Tools is incomplete or has been damaged. Reinstall (or repair) VMware Tools on the source guest; the snapshot provider service is part of the standard package.

### 2. (Optional but useful) test a quiesced snapshot manually

From the vSphere Client, take a manual snapshot of the source VM with **Snapshot the virtual machine's memory** disabled and **Quiesce guest file system** *enabled*. The snapshot should complete with no warnings. If vCenter reports `Quiesce operation timed out` or `Cannot quiesce the guest`, the service is enabled but cannot complete its work — investigate the VMware Tools logs in the guest before re-running the migration.

If the manual quiesced snapshot succeeds, delete it (the inspector will take its own) and proceed.

### 3. Restart the migration

In the migration toolkit, archive the failed plan and restart it. With the snapshot provider running, the snapshot the inspector mounts comes through clean, libguestfs mounts read-write, the inspection completes, and the migration moves into the conversion phase.

### Hardening — pre-flight check

For a fleet migration, add a pre-flight that lists the VMware Snapshot Provider service state on each source VM. The fix is per-source and cheap, but only if it is caught **before** the migration window:

```text
Get-Service VMTools, "VMware Snapshot Provider" | Format-Table Name, Status, StartType
```

A `StartType: Disabled` or a missing service is the warning sign.

## Diagnostic Steps

1. Confirm the failure mode is the dirty-NTFS / read-only one and not a different libguestfs failure (encrypted disk, missing kernel modules, broken symlinks). The fingerprint phrase is `filesystem was mounted read-only, even though we asked for it to be mounted read-write`. Anything else is a different problem.

2. Read the inspector log around the failing `touch`:

   ```bash
   kubectl logs -n <virt-namespace> <inspector-pod> -c <converter-container> \
     | grep -E 'unclean|read-only|filesystem|touch'
   ```

3. On the source VM, verify the service:

   ```text
   Get-Service "VMware Snapshot Provider" | Format-Table Name, Status, StartType
   ```

   Anything other than `Manual`/`Automatic` is the cause.

4. If the service is enabled but the failure still reproduces, look at the VMware Tools log on the guest (`%ProgramData%\VMware\VMware Tools\vmware-vmusr.log` and `vmware-tools-daemon.log`) for the most recent quiesce attempt. Errors like `freeze handler timed out` or `vss_writer_failed` mean the snapshot provider is up but a Windows VSS writer (SQL, Exchange, IIS, etc.) is refusing to quiesce — fix the VSS writer's configuration, then re-try.

5. After a successful migration, verify the destination guest's NTFS came up clean. From a debug shell into the migrated VM (or from inside the guest), run `chkdsk C: /scan` once. Any uncorrected errors here mean the source snapshot was still dirty going into conversion; treat that as a signal to investigate the source guest's VSS health before migrating the next VM.
