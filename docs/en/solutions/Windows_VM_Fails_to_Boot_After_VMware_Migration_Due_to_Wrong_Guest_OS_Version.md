---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Windows VM migrated from VMware — for example Windows Server 2019 — completes conversion successfully but fails to boot in the destination cluster. The VM console shows `INACCESSIBLE_BOOT_DEVICE`, `0x0000007B`, or hangs on the Windows boot logo. Other migrated Linux VMs and other modern Windows VMs on the same plan boot normally.

## Root Cause

The VMware-migration conversion tool (`virt-v2v` inside the conversion pod) installs VirtIO storage/network drivers into the Windows image during cutover, so the guest can find its now-VirtIO boot disk on the destination hypervisor. It picks which VirtIO driver ISO to attach based on the **guestId / Guest OS Version** advertised by the source hypervisor inventory (vCenter), not by what is actually installed inside the VM.

When vCenter carries an outdated or wrong Guest OS Version — a common residue of P2V imports, long-lived VMs upgraded in-place, or cloning templates — the converter maps an ISO that doesn't ship drivers for the real OS:

| vCenter Guest OS Version | ISO mapped | Works for |
|---|---|---|
| Windows Server 2019 (`windows2019srv_64Guest`) | modern VirtIO ISO | Windows 10/11, Server 2016+ |
| Windows 7 (`windows7Server64Guest`) | legacy VirtIO ISO | Windows 7 / Server 2008 R2 only |
| Windows Server 2008 (`windows8Server64Guest`) | legacy VirtIO ISO | Windows 8 / Server 2012 and older |

A Server 2019 VM tagged as "Windows 7" in vCenter therefore gets the **legacy** VirtIO ISO, which has no Server 2019 drivers. After cutover, Windows cannot load `viostor.sys`, cannot find the boot disk, and blue-screens.

## Resolution

Fix the vCenter-side tag **before** starting the migration. The conversion tool reads the inventory at migration time; updating after the plan has completed does not retroactively swap the injected drivers.

1. **Correct the Guest OS Version in vCenter.** In the vSphere Client:

   - Right-click the VM → **Edit Settings** → **VM Options** → **General Options**.
   - Set *Guest OS Family* to `Windows`.
   - Set *Guest OS Version* to the actual installed OS (e.g. `Microsoft Windows Server 2019 (64-bit)` for Server 2019; match the underlying OS exactly).
   - Save.

   This is a metadata-only change; the VM does not need to power-cycle.

2. **Re-run the migration plan.** If the VM has already been (badly) migrated to the destination, delete the destination VM and its PVCs before re-running; the next run of virt-v2v will now map the correct ISO and inject the right drivers.

3. **For fleet-scale moves**, audit vCenter tags in bulk before the migration wave. A common script uses PowerCLI:

   ```powershell
   Get-VM | Select Name, @{N='GuestOS';E={$_.ExtensionData.Config.GuestFullName}}, @{N='ConfiguredOS';E={$_.ExtensionData.Config.GuestId}}
   ```

   Any row where the two don't agree is a candidate for the above fix before migration.

4. **Recovery path for already-migrated broken VMs.** If you can't re-run the migration (time pressure, no access to vCenter):

   - Boot the Windows VM from a recovery ISO that includes the modern VirtIO drivers (public VirtIO ISOs are fine for this step).
   - Load the VirtIO storage driver manually via `drvload` at the WinRE command prompt.
   - Boot normally; the right `viostor.sys` is now loaded and Windows can continue.
   - Follow up with a driver refresh (Device Manager → update all VirtIO devices) so the correct drivers persist across reboots.

## Diagnostic Steps

Confirm the conversion picked the legacy ISO by inspecting the conversion pod's environment and logs — this is conclusive evidence of the failure mode:

```bash
kubectl -n <target-ns> get pod -l forklift.konveyor.io/plan -o wide
kubectl -n <target-ns> logs <conversion-pod> -c virt-v2v --tail=200 \
  | grep -iE 'virtio|iso|guest.*id'
kubectl -n <target-ns> exec <conversion-pod> -c virt-v2v -- printenv VIRTIO_WIN
```

`VIRTIO_WIN=/usr/local/virtio-win-legacy.iso` combined with a Server 2019 (or newer) guest is the signature. If the VIRTIO_WIN env points at the modern ISO but Windows still BSODs, you're looking at a different driver injection issue — check virt-v2v's log for driver install errors rather than re-running the mapping.

Confirm the boot failure mode on the destination VM:

- Attach a VNC / console viewer.
- Windows bluescreen reporting `0x0000007B INACCESSIBLE_BOOT_DEVICE` confirms missing storage driver.
- `0x0000007E` or different codes point at different root causes — don't assume this article applies.

After the vCenter fix + re-migration, the VM should boot directly into Windows with all VirtIO devices initialised; Device Manager should show the VirtIO controller drivers loaded and the disks under the `VirtIO SCSI controller` node.
