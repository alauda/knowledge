---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM Migration Stuck at virt-v2v "Operation not permitted" on Immutable /etc/resolv.conf
## Issue

A VM migration into ACP Virtualization — typically from VMware through the migration toolkit's `virt-v2v` conversion step — fails at the guest-configuration phase. The migration pipeline leaves one or more conversion pods in `Error` state. The `virt-v2v` log ends with a message like:

```text
renaming /sysroot/etc/resolv.conf to /sysroot/etc/resolv.conf.XXXXXX
guestfsd: error: rename: /sysroot/etc/resolv.conf to /sysroot/etc/resolv.conf.XXXXXX:
  Operation not permitted
commandrvf: umount /sysroot/sys
libguestfs: trace: v2v: sh_out = -1 (error)
virt-v2v: error: libguestfs error: sh_out: rename:
  /sysroot/etc/resolv.conf to /sysroot/etc/resolv.conf.XXXXXX: Operation not permitted
```

The source VM disk imported cleanly, libguestfs mounted the source filesystem at `/sysroot`, and `virt-v2v` reached the point of rewriting `/etc/resolv.conf` — the step that adjusts the guest for its new network environment. The rename then fails with `Operation not permitted`, not `Permission denied` — a hint that regular Unix permissions are not the cause.

## Root Cause

Linux ext/xfs filesystems support a per-inode **immutable** attribute (`chattr +i`). When set, the kernel refuses every operation that would modify the file, including rename, write, truncate, and unlink. The attribute is enforced by the filesystem layer, so neither root nor any capability set in a helper VM can bypass it.

Source VMs on VMware sometimes have `/etc/resolv.conf` marked immutable — an operational pattern used to stop the in-guest DNS server list from being rewritten by `NetworkManager` or cloud-init. When the guest runs in place on VMware the immutable flag is invisible; DNS works, `NetworkManager` logs a harmless warning about being unable to update the file, and nothing else notices.

`virt-v2v` renames `/etc/resolv.conf` during its post-conversion guest rewrite so it can substitute a fresh copy tailored to the destination network. The rename hits the immutable attribute, fails with `EPERM`, and `virt-v2v` aborts — there is no "skip" fallback because a half-rewritten guest is worse than an aborted migration.

## Resolution

The fix is on the **source** VM, not on the target cluster or on the migration toolkit. Clear the immutable attribute on `/etc/resolv.conf` before re-running the migration.

### Clear the immutable bit on the source VM

While the source VM is still running on its original hypervisor, connect to it and remove the attribute:

```bash
# Inspect the attribute first. An "i" in the output flags it.
lsattr /etc/resolv.conf
# ----i---------- /etc/resolv.conf

# Remove the immutable attribute.
sudo chattr -i /etc/resolv.conf

# Confirm.
lsattr /etc/resolv.conf
# ---------------- /etc/resolv.conf
```

Retry the migration. The `virt-v2v` step now completes the rename and the VM reaches the destination cluster.

### Scan for other immutable files before retrying

`virt-v2v` rewrites several guest files besides `/etc/resolv.conf` — `/etc/hosts`, `/etc/nsswitch.conf`, `/etc/fstab`, the bootloader configuration, among others. If `/etc/resolv.conf` was set immutable as part of a broader hardening policy, other files may be too. Scan for any immutable files in `/etc` and clear the ones that `virt-v2v` will touch:

```bash
# Find every immutable file under /etc on the source VM.
sudo lsattr -R /etc 2>/dev/null | awk '$1 ~ /i/ { print }'
```

Review the list, and clear the attribute with `chattr -i` on any file in that set that is part of the system's guest-facing configuration. Files that need to stay immutable for legitimate security reasons (audit trails, compliance lockfiles owned by a specific application) can be left as-is if `virt-v2v` does not touch them — but note that the migration pipeline's list of rewritten files grows over time, so the safest posture before migration is "no immutable files under `/etc`".

### If the source VM is no longer accessible

If the VM was shut down before the migration started and cannot be powered back on to run `chattr`, mount the source disk image directly (on any Linux host) and clear the attribute from there:

```bash
# Mount the source disk; use qemu-nbd or kpartx for non-raw images.
sudo mount -o loop /path/to/source.img /mnt/src

# Clear the attribute on the mounted filesystem.
sudo chattr -i /mnt/src/etc/resolv.conf

sudo umount /mnt/src
```

Re-run the migration against the modified image.

### Post-migration — let the new guest manage /etc/resolv.conf

Once the VM runs on ACP Virtualization, the destination network typically wants `NetworkManager` (or whatever the guest uses) to manage `/etc/resolv.conf` dynamically. Keeping the immutable attribute off lets DNS servers be reconfigured through cloud-init, DHCP, or a configuration management system without manual intervention. If there is a genuine reason to lock the file after migration, re-apply `chattr +i` on the destination only after the guest has fully stabilised.

## Diagnostic Steps

Identify the pod that failed the conversion:

```bash
kubectl -n <migration-ns> get pod \
  -l app=virt-v2v --field-selector=status.phase=Failed \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,REASON:.status.reason,STARTED:.status.startTime'
```

Read the pod's log and search for the `rename` / `Operation not permitted` signature. The log line includes the specific file that could not be renamed, which is the one whose immutable attribute needs clearing:

```bash
kubectl -n <migration-ns> logs <virt-v2v-pod> \
  | grep -E 'rename.*Operation not permitted|virt-v2v: error'
```

When the failing file is something other than `/etc/resolv.conf` (for example `/etc/hosts` or `/etc/fstab`), the fix is still to clear the immutable attribute on that specific file on the source. Repeat for every such file surfaced by the logs.

After the migration succeeds, inspect the destination VM's `/etc/resolv.conf` to confirm `virt-v2v` wrote the expected content (destination-network DNS servers, not the source's):

```bash
# From inside the migrated guest.
cat /etc/resolv.conf
lsattr /etc/resolv.conf
```

Absence of the `i` flag in `lsattr` output confirms the attribute was cleared. The DNS servers should reflect the destination network's resolvers, which means `virt-v2v` completed its rewrite cleanly.
