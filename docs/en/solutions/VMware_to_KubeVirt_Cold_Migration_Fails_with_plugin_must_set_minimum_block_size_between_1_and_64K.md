---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VMware to KubeVirt Cold Migration Fails with "plugin must set minimum block size between 1 and 64K"
## Issue

A VM cold migration from VMware vSphere to platform virtualization aborts during the disk-transfer stage. The migration controller's conversion/transfer pod (virt-v2v over nbdkit) dies with:

```text
nbdkit: error: plugin must set minimum block size between 1 and 64K
```

The migration plan itself validates and starts; the failure is reached only once the per-disk conversion stream is about to open. All VMs destined for the same target storage class fail identically — the failure is not tied to a specific source VM, but to the target storage.

## Root Cause

nbdkit (the NBD server that virt-v2v streams guest-disk blocks through during migration) enforces that any plugin or backing device advertise a minimum IO size in the range `[1, 64 KiB]`. If the backing device of the target PersistentVolume advertises a `minimum_io_size` larger than 64 KiB, the nbdkit instance launched by the migration pod refuses to start and the migration aborts with the message above.

The usual culprit is LVM-backed storage whose thin-pool chunk size was set above 64 KiB — for example, a TopoLVM (or equivalent CSI-LVM) volume group whose thin pool was created with `--chunksize 128K` or `--chunksize 256K`. The LVM layer then propagates that chunk size up as `minimum_io_size` to any volume carved out of it, and the value exceeds what nbdkit is willing to accept. The same pattern has been observed on other storage layers that honestly report large optimal IO block sizes.

This is a defect in the nbdkit ↔ block-layer contract: nbdkit's internal limit is artificially low. The behavior is fixed by a downstream bump of the nbdkit build in the migration toolkit — once the newer migration-toolkit release is installed, the restriction is lifted and migrations to thin-pool backed PVCs complete normally.

## Resolution

### Preferred: upgrade the platform VM-migration toolkit

Upgrade the platform's "migrate VMs from VMware" operator (the Forklift-based migration toolkit shipped as part of the platform virtualization surface) to a point release that bundles the fixed nbdkit. After the upgrade, start the migration plan again; the conversion/transfer pods pick up the new nbdkit image and no longer reject the target volumes' minimum IO size. Consult the migration-toolkit change log for the point release that mentions `nbdkit` / `minimum block size` under fixes.

### Workaround: migrate to a storage class that advertises ≤ 64 KiB

While the upgrade is being scheduled, route the migration to a different storage class whose backing devices advertise a `minimum_io_size` within the nbdkit range. After the VMs are migrated and running on the platform, they can be moved to the preferred storage class by cloning their disks to a new PVC on the target storage class and swapping the disk references — this is a standard KubeVirt volume operation and does not require re-running the migration plan.

### Workaround: resize the thin-pool chunk size (disruptive)

If the target storage is a TopoLVM-style CSI-LVM provisioner and the thin pool was just created, the thin pool itself can be re-created with a `--chunksize` of 64 KiB or smaller. This is disruptive — all volumes on the pool must be re-provisioned — so it is only viable before the pool has real workloads on it. It is typically used during initial cluster buildout, not as a remedy for an in-flight migration.

### OSS fallback

On any Kubernetes cluster running upstream Forklift/KubeVirt without the platform migration toolkit, the same fix applies: pull a Forklift release whose `virt-v2v-*` / `nbdkit` images correspond to an nbdkit build that does not reject large advertised minimum IO sizes, or steer the target DataVolume to a storage class whose block layer advertises a minimum IO size in the accepted range.

## Diagnostic Steps

Isolate the failure to the nbdkit minimum-IO check rather than to VM definition or network.

1. Confirm the failure is in the transfer / conversion stage. The migration plan's VM status will be stuck in the transfer step with a pod in `Error` or `CrashLoopBackOff`:

   ```bash
   kubectl -n <migration-ns> get pods -l migration=<plan-name>
   kubectl -n <migration-ns> logs <conversion-pod> --all-containers --tail=200
   ```

   The nbdkit line `plugin must set minimum block size between 1 and 64K` will appear in the logs of the `virt-v2v-conversion` (or equivalently named) container.

2. Identify the target storage class the migration is provisioning against and check the advertised minimum IO size on the backing device. On the node where a PVC from that storage class has been mounted (or where a test VM is running on the same class), read from sysfs for each relevant block device:

   ```bash
   # Replace <blk> with the device node of the backing LV / disk
   cat /sys/block/<blk>/queue/minimum_io_size
   ```

   A value greater than 65536 confirms the root cause.

3. Cross-check by provisioning a small test PVC on a different storage class and inspecting the same `minimum_io_size` value. The migration will succeed against any class that reports ≤ 64 KiB, even before the migration-toolkit upgrade.

4. For LVM-backed storage specifically, inspect the thin-pool chunk size on the node's volume group. A chunk size of 128 KiB or larger directly explains the sysfs reading above. This is a one-liner in `lvs` output when run from the node's admin shell (via a node-debug pod).
