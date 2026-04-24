---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After upgrading ACP Virtualization from a previous minor release to one that introduces PCI-slot reservation for hotplug support, existing VMs experience a one-time disk-layout shuffle on the first guest reboot:

- **Windows VMs** come back up with non-OS disks (D:, E:, and so on) flagged as **Offline** in the guest Disk Management pane. The OS disk is unaffected, so the VM still boots, but any drive letter backed by a secondary disk goes dark and the applications that depend on them fail.
- **Linux VMs** that mount secondary volumes by PCI path (`/etc/fstab` entries of the form `/dev/disk/by-path/pci-0000:XX:YY.Z-...`) fail to mount those entries, drop into emergency shell, or bring the service up without the expected data directory.

The VM itself is not corrupted — the underlying PVCs are still bound and the data is intact — but the guest perceives its disk inventory as changed because the virtual PCI addresses have moved.

## Root Cause

The upgraded virtualization stack introduces a PCI-address reservation policy: a block of slots (typically six) is set aside at the front of the hotplug bus so that disks hot-attached later have stable, predictable coordinates. Any pre-existing VM that had previously been assigned a disk inside that reserved range gets its disks shifted upward on the first post-upgrade boot — for example, the first data disk that used to sit at PCI slot `0x07` now sits at `0x0a` to make room for the reservation.

Because the virtual machine firmware reports a different slot to the guest, the guest sees "new hardware":

- On Windows, the default **SAN Policy** is `OfflineShared`, which brings any newly discovered, non-OS disk online only after explicit administrator action. From Windows' point of view the moved disk is new hardware, so it is kept offline.
- On Linux, `fstab` entries that pin to `/dev/disk/by-path/` resolve to a different path after the move, and `mount` reports "no such device" for the old name. `by-uuid` and `by-label` entries are not affected, because they resolve from the filesystem superblock rather than the PCI topology.

A fix has been released in a later patch version of the virtualization stack that preserves the existing PCI layout for pre-upgrade disks.

## Resolution

### Quick recovery — bring the disk online in the guest

Nothing on the hypervisor side needs to change; the data is intact. The one-shot recovery is done inside the guest:

- **Windows.** Open Disk Management (or `diskpart`) as Administrator and bring the offline disks online. Drive letter assignments are preserved once the disk is back online.
- **Linux.** Re-mount manually (`mount -a` after correcting `fstab`) or update the mount entries to use `UUID=` or `LABEL=` rather than `/dev/disk/by-path/...`.

### Durable mitigation on Windows — change the SAN policy to `OnlineAll`

Windows' default `OfflineShared` policy is protective against accidental shared-disk corruption on clustered servers; it is not the right default for a single-owner VM where every disk is private. Switching the policy makes future hardware-topology changes transparent:

```text
C:\> diskpart

DISKPART> SAN
SAN Policy: Offline Shared

DISKPART> SAN POLICY=OnlineAll

DISKPART> SAN
SAN Policy: Online All
```

**Caveat.** Do not apply `OnlineAll` on a Windows guest that participates in a clustered application sharing disks with another host — the policy exists to prevent both nodes from writing to the same LUN. The guidance here is for single-owner VMs only; in a Windows Failover Cluster, leave the policy at `OfflineShared` and handle disk onboarding through the cluster manager.

### Durable mitigation on Linux — move fstab to stable identifiers

Replace `/dev/disk/by-path/` entries with `UUID=` or `LABEL=` in `/etc/fstab`. PCI-address paths change whenever the virtual bus is reshuffled (hotplug, migration, firmware update); filesystem identifiers do not.

Inspect the current identifiers for a block device inside the guest:

```bash
blkid
lsblk -o NAME,UUID,LABEL,MOUNTPOINT
```

Rewrite the `fstab` entry:

```text
# old, fragile:
/dev/disk/by-path/pci-0000:0a:00.0-part1  /data  xfs  defaults  0  2
# new, stable:
UUID=<the-filesystem-uuid>                /data  xfs  defaults  0  2
```

Run `systemctl daemon-reload && mount -a` to verify.

### Permanent fix — upgrade to a version that keeps legacy PCI slots in place

The correct long-term answer is to roll to a virtualization stack patch version that preserves pre-existing disk PCI layouts on upgrade. Once the fix is on the cluster, migrating or rebooting a VM no longer shifts any disk slot, and neither the Windows offline state nor the Linux path-based mount failure will reproduce on subsequent reboots.

## Diagnostic Steps

- Capture the before/after PCI layout of the affected VM — most easily by looking at the running launcher pod's domain XML (or the VMI status) both before and after the upgrade. The disk `<address type="pci" ... slot="0xNN" ...>` tuples move upward by the reservation size:

  ```bash
  kubectl -n <ns> get vmi <vm-name> -o jsonpath='{.spec.domain.devices.disks}'
  ```

- On Windows, confirm the disks are flagged offline rather than missing:

  ```text
  DISKPART> LIST DISK
  ```

  An offline disk still appears in the list with its size; a missing disk does not show up at all.

- On Linux, match the `journalctl -b` boot log for `systemd[1]: Mounting /data...` failures that cite `/dev/disk/by-path/...` names — those confirm the symlink target has changed.

- Cross-check which VMs will be affected by listing VMs created before the upgrade that use `by-path` mounts or non-OS disks relied on by user services:

  ```bash
  kubectl get vm -A -o custom-columns=NAME:.metadata.name,NS:.metadata.namespace,CREATED:.metadata.creationTimestamp
  ```

  VMs created **after** the upgrade are already laid out around the reservation and will not shift on reboot.
