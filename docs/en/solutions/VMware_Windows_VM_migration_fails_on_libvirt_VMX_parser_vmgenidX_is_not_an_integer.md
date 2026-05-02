---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A migration plan for a Windows VM coming from VMware fails during the *ImageConversion* phase. The conversion pod emits a libvirt-side error from the VMX parser:

```text
virt-v2v: error: exception: libvirt: VIR_ERR_INTERNAL_ERROR: VIR_FROM_NONE:
   internal error: Config entry 'vm.genidX' must represent an integer value
Failed to execute virt-v2v command exit status 1
```

The migration was working previously for other Windows VMs from the same vCenter; only this one VM (or a small subset of VMs) fails the same way.

## Root Cause

`vm.genid` and `vm.genidX` are advanced configuration entries in a VMware VMX file that store the VM Generation ID — a 64-bit identifier modern Windows guests use to detect when they have been cloned (sealing/unsealing AD-joined state, replication-aware services). VMware writes the entries as integer values; modern Windows reads them on boot to decide whether the guest is the same instance it was last shutdown.

The libvirt VMX parser that the migration toolkit's converter (`virt-v2v` running through libguestfs) uses is **strictly typed** for these two entries. They must parse as 64-bit integers; anything else (`true`/`false`, hex strings without the right format, empty values, accidental quoted strings) is rejected and the conversion aborts at parse time.

In the field, the entries end up non-integer for a few reasons:

- Someone hand-edited the VMX (or used an automation tool that did) and assigned `TRUE` or `FALSE` to `vm.genid`/`vm.genidX` instead of the auto-generated integer.
- The VM was templated from a snapshot that lost the integer value during cloning.
- The vSphere upgrade path that introduced the genid feature wrote a placeholder string for VMs that had not yet seen a power-cycle on the new host.

In every case, `virt-v2v` cannot continue past the inspection step. The bytes on disk are fine; only the metadata in the VMX is malformed.

## Resolution

Fix the VMX entries on the VMware side, then re-run the migration. There is nothing on the destination cluster to change.

### 1. Power off the source VM

The advanced configuration is editable only on a powered-off VM. From the vSphere Client:

1. Power off the source VM. Use a graceful guest shutdown if possible (Windows commits any pending updates and writes its own VM-genid on the next boot).

### 2. Edit the advanced VMX configuration

1. Select the VM → **Edit Settings**.
2. Open the **VM Options** tab.
3. Expand **Advanced** → click **Edit Configuration**.
4. Locate the keys `vm.genid` and `vm.genidX`.
5. **Delete both keys** (`Remove` next to each entry). Saving without them is what makes vSphere regenerate fresh integer values the next time the VM is processed.
6. Click **OK** to apply the configuration change.

Alternative if your vSphere build does not let you remove the keys interactively: replace each key's value with a valid 64-bit integer literal (e.g. zero) — the safest path is to remove and let vSphere regenerate, but a manual integer also works.

### 3. (Optional) confirm by powering the VM on briefly

Power the VM on for a moment; vSphere writes a fresh `vm.genid` and `vm.genidX` integer pair as it boots. Power it back off when you see the integers reappear. This is optional — `virt-v2v` is happy as long as the keys are integers or absent.

### 4. Restart the migration

In the migration toolkit's UI:

1. **Archive** the failed migration plan.
2. **Restart** the plan against the corrected source VM.

The conversion pod's libvirt VMX parser now sees integer values (or no values at all) for both keys, the migration progresses through inspection and conversion, and the VM lands on the destination with valid metadata.

### Hardening — fleet pre-flight check

A pre-flight check that lists `vm.genid` and `vm.genidX` for every source VM and warns on non-integer values is the cheapest way to keep the same trap from biting in a fleet migration. From a script that can call the vCenter API:

```text
for each VM:
  for each entry in extraConfig:
    if entry.key in {"vm.genid", "vm.genidX"}:
      assert entry.value parses as int64 OR is empty
```

VMs that fail this check are pre-flagged and edited before the migration window.

## Diagnostic Steps

1. Confirm the failure message is the exact libvirt VMX-parser one. Different errors at the same conversion stage have superficially similar shapes (encrypted disk failures, broken symlinks, missing kernel modules) and require different fixes:

   ```bash
   kubectl logs -n <virt-namespace> <conversion-pod> -c <converter-container> \
     | grep -E "Config entry|vm\.genid|VIR_ERR_INTERNAL_ERROR"
   ```

   The `Config entry 'vm.genidX' must represent an integer value` line is the fingerprint.

2. From vCenter, read the source VM's advanced configuration and identify the offending values:

   - vSphere Client → VM → **Edit Settings** → **VM Options** → **Advanced** → **Edit Configuration**.
   - Find `vm.genid` and `vm.genidX`. Anything other than a numeric literal is a candidate (`TRUE`/`FALSE` is the most-frequent flavour; `0x...` style hex is sometimes accepted by VMware itself but tripped libvirt; empty is accepted by VMware as "regenerate").

3. After the fix, re-read the entries and confirm they are integers (or absent). If you took the optional step 3 above, you should see two fresh integer values; if you took the deletion-only path, the keys should be gone from the list.

4. Watch the next migration run's conversion pod logs through the inspection step. A run that gets past `Config entry 'vm.genidX'` and into the disk-conversion phase has cleared this issue; subsequent failures (if any) are unrelated and need their own diagnosis.
