---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Windows VM running on the platform's KubeVirt-based virtualization stack uses paravirtualized devices (virtio-blk, virtio-scsi, virtio-net, virtio-balloon, virtio-serial). When troubleshooting performance, compatibility, or migration questions, the running version of each virtio driver inside the guest is needed — both to confirm that a planned host-side change matches the guest's driver level, and to attach in support correspondence. The driver bundle ships under the `virtio-win` umbrella; each subordinate device exposes its own `DriverVersion` and `DriverDate`.

## Resolution

Two paths cover the common workflows: a scriptable PowerShell query for batch inventory, and a GUI walkthrough for one-off investigation.

### From PowerShell

Open a PowerShell session on the guest (Administrator is not required for this query) and list every signed PnP driver, filtered to those whose vendor string identifies the virtio bundle:

```text
Get-CimInstance Win32_PnPSignedDriver |
  Where-Object { $_.DeviceName -match 'VirtIO|QEMU' } |
  Select-Object DeviceName, DriverVersion, DriverDate |
  Format-Table -AutoSize
```

Sample output (a guest with the current bundle installed) looks like:

```text
DeviceName                                      DriverVersion         DriverDate
----------                                      -------------         ----------
QEMU FwCfg Device                               100.100.104.27100     1/13/2025 3:00:00 AM
VirtIO Input Driver                             100.101.104.28400     7/8/2025 3:00:00 AM
VirtIO Balloon Driver                           100.102.104.29400     12/8/2025 3:00:00 AM
VirtIO SCSI controller                          100.102.104.29500     1/21/2026 3:00:00 AM
VirtIO Serial Driver                            100.101.104.28400     7/8/2025 3:00:00 AM
VirtIO Ethernet Adapter                         100.102.104.29400     12/8/2025 3:00:00 AM
```

The original query in legacy documentation filters on the `Manufacturer` string. That filter is fragile across signing-vendor renames; `DeviceName` matching `VirtIO|QEMU` is more durable and gives the same answer.

### From the Windows GUI

When PowerShell access is not practical (for example, console-only triage of an unresponsive guest), the same versions are visible per-device in Device Manager:

1. Open **Device Manager** (`devmgmt.msc`).
2. Expand the relevant category — Storage controllers (`virtio-blk`/`virtio-scsi`), Network adapters (`virtio-net`), System devices (`virtio-balloon`, `virtio-serial`, `QEMU FwCfg`).
3. Double-click the device, switch to the **Driver** tab; the **Driver Version** and **Driver Date** fields hold the same values returned by the PowerShell query.

### Mapping driver names to virtio device types

The Windows-side device names map one-to-one to the QEMU device backends configured on the VM:

| Windows device name | QEMU backend |
|---|---|
| `VirtIO SCSI controller` | `virtio-blk-pci` |
| `VirtIO SCSI pass-through controller` | `virtio-scsi-pci` |
| `VirtIO Ethernet Adapter` | `virtio-net-pci` |
| `VirtIO Balloon Driver` | `virtio-balloon-pci` |
| `VirtIO Serial Driver` | `virtio-serial-pci` |
| `VirtIO Input Driver` | `virtio-input-pci` (HID — keyboard/mouse, tablet) |

Confirming the in-guest driver against the platform's `VirtualMachine` spec — specifically `spec.template.spec.domain.devices.{disks,interfaces}` — establishes that the host attached a virtio-class device for which a driver is actually loaded. A backend of `virtio` paired with a missing or stale guest driver is the most common cause of "the disk shows up as IDE" or "the NIC negotiates 100 Mbps" symptoms after a clean install.
