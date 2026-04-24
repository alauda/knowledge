---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Windows guest migrated from an external hypervisor into the cluster's KubeVirt-based virtualization stack boots, but Device Manager shows a stack of unknown devices and several virtio drivers (network, balloon, serial) never finish installing. The setupapi log on the guest fingerprints the failure cleanly:

```text
[Device Install (DiInstallDevice) - PCI\VEN_1AF4&DEV_1043&...]
   sto: {Setup Import Driver Package: c:\windows\drivers\virtio\vioser.inf}
!!! sto: Failed to call to import driver package. Error = 0xE0000223 (0x32)
!!! ndv: Driver package import failed for device.
!!! ndv: Error 0xe0000223: The Plug and Play service is not available on the
        remote machine.
!!! ndv: Installing NULL driver.
```

The same error trips the balloon driver install (`PnPutil -i -a balloon.inf` returning `0xE0000223`). Because the install script silently moves on, the guest finishes its first boot with a degraded device set that operators only notice when the network adapter or memory ballooning is missing.

## Root Cause

`Error 0xE0000223 — "The Plug and Play service is not available on the remote machine"` is Windows telling the install script that PnP is **not yet up** at the moment the script tries to import a driver package. The first-boot driver install routine racing the PnP service is a well-known pattern: the first time the migrated guest boots, autologon kicks off a `firstboot.bat` that runs `PnPutil` for every virtio INF; on a slower VM (cold start, slow disk) `PnPutil` can run before PnP has finished initialising.

The migration tooling that wraps this — the workflow that lifts a VMware guest into the cluster — drops a copy of `firstboot.bat` into the guest. In some toolchain versions that copy was an older revision that did not wait for PnP to be ready. The result is a deterministic race: `firstboot.bat` runs, hits PnP-not-ready, all drivers installed in that pass land as `NULL driver`, and the script exits successfully.

## Resolution

### Preferred: ACP Virtualization Migration Workflow

In ACP the VMware-to-cluster lift is owned by the `virtualization` capability ("Migrate Virtual Machines from VMware"). That workflow is maintained inside this repo by the same area owner, so the right move when a Windows guest reproduces the symptom above is:

1. Confirm the guest was lifted by the ACP virtualization migration workflow (not a hand-rolled `virt-v2v` invocation).
2. Re-run the migration with the *current* version of the workflow — the fix that sequences `firstboot.bat` after PnP is part of the platform-shipped scripts and lands automatically on a fresh migration.
3. If a re-migration is not possible (production cut-over already done), apply the manual workaround below to the live guest.

The ACP virtualization page also exposes guest-tools images that include matching virtio drivers; pinning the migrated VM to that image after the lift removes the dependency on whatever virtio package shipped with the source image.

### Manual Workaround on a Live Guest

Operators sitting on a guest that already booted in the broken state can install the missing drivers by hand without re-migrating:

1. Attach the virtio-win driver image to the guest as a CD-ROM (the cluster's virtualization workflow exposes it as a bootable device or a side-loaded data volume).
2. Inside the guest, install each driver explicitly through `PnPutil`, which **does** wait for PnP at this point because the guest is fully booted:

   ```text
   pnputil /add-driver D:\virtio-win\vioser.inf  /install
   pnputil /add-driver D:\virtio-win\netkvm.inf  /install
   pnputil /add-driver D:\virtio-win\viostor.inf /install
   pnputil /add-driver D:\virtio-win\balloon.inf /install
   ```

3. Reboot the guest once at the end. Open Device Manager and confirm there are no remaining unknown devices under **Other devices**.

### Validate Before Bulk Migration

When a migration wave is planned, qualify it on a single test guest first:

- Run the migration end-to-end against one Windows guest.
- Boot it and inspect `%SystemRoot%\inf\setupapi.dev.log` for any `0xE0000223`.
- If the log is clean, the toolchain is on a build that paces `firstboot.bat` correctly and the wave can proceed; if it is dirty, escalate the toolchain version before any further guests are migrated.

## Diagnostic Steps

The setupapi log is the authoritative source on the guest side:

```text
%SystemRoot%\inf\setupapi.dev.log
```

Search it for `0xE0000223`. Every occurrence corresponds to one driver that was *attempted* and failed; a non-empty list maps directly to the missing devices in Device Manager.

Cross-check device presence from inside the guest:

```text
pnputil /enum-devices /problem
```

Devices reported with problem code `28` (driver not installed) are the candidates the manual workaround above will fix.

From the cluster side, check that the guest is using a virtio bus and not an emulated controller (the latter would not need virtio drivers at all and is a sign the migration produced the wrong device profile):

```bash
kubectl get vmi <vmi-name> -o jsonpath='{.spec.domain.devices}' | jq .
```

A healthy migrated Windows guest should show `disks[*].disk.bus = "virtio"` and a virtio NIC. If the bus is `sata` or `e1000`, the migration mapped the device set to an emulated profile — re-run the migration choosing the virtio profile instead of patching drivers in.
