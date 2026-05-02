---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A VMware virtual machine being migrated into a KubeVirt-backed cluster
fails during inspection or conversion. The migration controller's
`virt-v2v` step exits with:

```text
virt-v2v-inspector: error: no installed kernel packages were found.
```

The migration is reproducible but intermittent: re-running the same
plan against the same VM sometimes succeeds, sometimes fails with the
same error. The VM in question has more than one bootable disk —
typically a primary system disk and a secondary disk that holds a
backup bootloader and `/boot` partition (an "alt-boot" layout used in
some operations practices for emergency recovery).

## Root Cause

`virt-v2v` inspects a VM by mounting its disks and walking the
filesystem to identify the operating system, locate kernel packages,
and rebuild the boot configuration for the target environment. The
inspection picks the boot partition based on disk enumeration order
returned by the underlying kernel — `/dev/sda`, `/dev/sdb`, etc.

For a single-boot VM the order is deterministic and the boot partition
is always the same one. For a multi-boot ("alt-boot") VM with a backup
boot partition on the secondary disk, the disk enumeration is **not
guaranteed**: depending on which disk the kernel discovers first the
inspector may end up mounting the secondary, backup partition as the
primary boot. The backup partition does not contain the live kernel
package, so `virt-v2v` reports "no installed kernel packages" and the
conversion fails.

A fix in the upstream migration controller (the workload-migration
provider's controller, which orchestrates the `virt-v2v` invocation)
makes the disk enumeration reliable for multi-boot layouts. Until the
fix is rolled into the deployed migration controller, the VM's own
fstab can also contribute: if the fstab references `/dev/sda` /
`/dev/sdb` instead of stable filesystem UUIDs, even a successful
inspection produces a converted VM that fails to boot in the target
environment because the device names do not match the new disk
layout.

## Resolution

Apply two corrections — one to the migration controller, one to the
VM being migrated:

### Migration controller

Upgrade the workload-migration provider to the version that fixes the
disk-enumeration ordering for multi-boot VMs (the upstream tracker is
`virt-v2v-inspector fails on detect_kernels() for dual boot VMs`). The
new controller pins the inspection to the primary boot partition and
the failure becomes deterministic.

After the upgrade, re-run the migration plan. The inspection succeeds
on every attempt for the multi-boot VM. Note: the conversion is still
performed on the **primary** boot partition only — the secondary
backup partition is preserved as data on the destination disk but is
not converted into a bootable target. If the destination must support
booting from either copy, the secondary partition has to be
re-bootstrapped after the migration as a separate maintenance task.

### Source VM (apply on the VMware side before migrating)

Convert the VM's `/etc/fstab` to use filesystem UUIDs rather than
device names:

```bash
# On the source VM
blkid                    # list filesystems and their UUIDs
# Replace each /dev/sda1, /dev/sdb1, etc. in /etc/fstab with its UUID
# UUID=11111111-2222-... /            ext4 defaults 0 1
# UUID=33333333-4444-... /home        ext4 defaults 0 2
# UUID=55555555-6666-... swap         swap defaults 0 0
```

UUIDs are stable across disk reordering, so the converted VM mounts
the right filesystems regardless of how the destination platform
enumerates the disks. This is good hygiene independent of the multi-
boot issue and removes a class of post-migration boot failures.

## Diagnostic Steps

1. Confirm the failure surfaces in `virt-v2v-inspector`:

   ```bash
   # On the migration controller / virt-v2v pod
   kubectl logs -n <migration-ns> <virt-v2v-pod> \
     | grep -i "no installed kernel"
   ```

2. Confirm the VM has more than one bootable disk on the source side.
   In the source platform's UI, list the VM's disks; an alt-boot
   layout typically has two disks each with a `/boot` partition.

3. Re-run the migration on the upgraded controller and confirm the
   inspection consistently picks the primary disk:

   ```bash
   kubectl logs -n <migration-ns> <virt-v2v-pod> \
     | grep -i "selected primary disk"
   ```

4. After conversion, boot the destination VM and confirm the kernel
   selected matches the source's primary boot. From the guest:

   ```bash
   uname -a
   cat /etc/fstab           # verify entries are UUID-based
   ```

5. If the destination VM fails to boot despite a clean inspection, the
   most likely follow-up is the fstab issue — apply the UUID
   conversion above, retake the source-side snapshot, and re-run the
   migration.
