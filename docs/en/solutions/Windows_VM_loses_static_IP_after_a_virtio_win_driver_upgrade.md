---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Windows VM loses static IP after a virtio-win driver upgrade
## Issue

A Windows guest running on the cluster's virtualization stack has a manually configured static IP on its NIC. The guest's virtio-win driver package is upgraded in place — typically by mounting the new ISO and running the installer or via Windows Update — and after the upgrade the guest still boots, but the network interface no longer has the static IP. The interface either falls back to DHCP or has no IPv4 address at all.

In Device Manager, the affected NIC sometimes shows a yellow warning triangle. The Windows `setupapi.dev.log` records, around the time of the upgrade:

```text
Device pending start: Device has problem: 0x38 (CM_PROB_NEED_CLASS_CONFIG),
  problem status: 0x00000000.
```

## Root Cause

`CM_PROB_NEED_CLASS_CONFIG` (0x38) is Windows' way of saying *the Plug-and-Play class for this device has not been re-initialised since the driver in front of it changed*. When the virtio-win NIC driver is replaced while the device's previous instance is still in a half-installed state from an earlier driver update that never rebooted, the upgrade landing on top of it leaves the device entry without its class configuration. Windows then provisions a fresh NIC instance for the new driver, and the static IP — which was bound to the *previous* instance's persistent settings — is not carried across.

The trigger is therefore a missed reboot between two virtio-win driver updates, not the new driver itself. The first update left the NIC with a pending start; the second update on top of that pending state is what loses the per-instance configuration.

## Resolution

The right fix is to make sure no NIC is in a `pending` device state before the next virtio-win upgrade.

### Before the upgrade

1. Inside the Windows guest, open Device Manager.
2. Look for any device with a yellow warning triangle, especially under *Network adapters* and *System devices*. A warning sign means the device has an outstanding class configuration / pending start that needs a reboot to settle.
3. If any such device exists, reboot the VM first and let Windows complete the device install at boot. Verify the warning is gone before proceeding.
4. Only then run the new virtio-win installer.

After installing the new virtio-win drivers, reboot the VM one more time. This is the reboot that prevents the *next* upgrade from hitting the same `0x38` state.

### Recovering a guest that already lost its IP

If the upgrade has already happened and the NIC has come up with the wrong IP:

1. Reboot the guest. The pending device install completes during boot and the NIC settles into a healthy state.
2. Open the IPv4 properties of the new NIC instance and re-apply the static IP, mask, gateway, and DNS — the previous binding was on the old instance and does not carry over.
3. Confirm in Device Manager that no device has a yellow warning triangle. A second reboot at this point is harmless and is the clean baseline for any future driver update.

If the host has automated build-out of the guest network (cloud-init, sysprep, an in-house provisioning agent), re-running it is usually enough to re-bind the static IP without manual GUI work.

### Avoiding the trap going forward

Treat virtio-win upgrades the same as any kernel-level driver change: reboot before, install, reboot after. Doing both reboots reliably is what prevents the chained-upgrade case where one missed reboot poisons every subsequent driver update on the same NIC.

## Diagnostic Steps

1. From inside the guest, capture the relevant `setupapi` lines so the timestamp lines up with the upgrade window. The file is large; grep for the device problem code:

   ```text
   findstr /C:"CM_PROB_NEED_CLASS_CONFIG" C:\Windows\INF\setupapi.dev.log
   ```

   A hit confirms the failure mode is the missed-reboot pattern, not a virtio-win bug specific to one ISO version.

2. List every device that is currently in a non-`OK` state — a pre-upgrade check that catches the situation before it bites:

   ```text
   pnputil /enum-devices /problem
   ```

   Any device listed here will trip the next driver update; reboot until the list is empty before installing virtio-win.

3. Note the virtio-win driver version that was installed at each step. From Device Manager → NIC → *Driver* tab, or from PowerShell:

   ```text
   Get-WmiObject Win32_PnPSignedDriver `
     | Where-Object {$_.DeviceName -like "*VirtIO*Ethernet*"} `
     | Format-Table DeviceName, DriverVersion, DriverDate
   ```

   Pairing two driver versions (the one before the upgrade and the one after) with the time of the IP loss is what proves the issue is the version chain, not a single bad build.

4. From the cluster side, the VM and its NIC are unchanged — there is nothing to fix on the VirtualMachine spec or on the `NetworkAttachmentDefinition`. The fault is entirely inside the guest's PnP database and resolves with a reboot plus re-applied static IP.
