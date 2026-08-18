---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM Migration Fails with "Multipath Device in Use" on FC-Backed PVCs
## Issue

A live-migration of a virtual machine — from one worker node to another — fails with the VMI reporting `FailedMapVolume` and the CSI layer refusing to release a multipath device on the source node. The event shows up on the target pod as:

```text
Warning  FailedMapVolume  15s (x3 over 54s)  kubelet
MapVolume.SetUpDevice failed for volume "pvc-<uuid>":
  rpc error: code = Aborted desc = failed to delete device file:
  [HSPC0x00009026] the multipath device could not be deleted because the device is in use
```

The PVC is backed by a Fibre Channel LUN surfaced to the nodes as a multipath device, and the storage CSI driver (for example a Portworx / FC-aware driver) cannot tear the multipath map down because something on the host still holds it open. The VM stays pending on the target and cannot start until the source side releases the device.

## Root Cause

FC storage is typically presented to worker nodes via the kernel device-mapper multipath layer. Under normal operation the only consumers of a given multipath device are:

- The host itself (root disk, OS mounts).
- The CSI plugin when it maps a LUN into a pod as a block or mounted volume.

When an additional consumer appears on the host — almost always the host's **LVM stack** — the multipath device stays "in use" even after the CSI plugin has done its own release. The host's `lvm2` sees LVM metadata on the LUN (because the VM's guest operating system uses LVM inside the disk), scans it, and claims the underlying multipath device. The CSI driver then cannot remove the device because the kernel reports a non-zero holder count.

Two files are relevant:

- `/etc/lvm/devices/system.devices` — the host-side LVM "allow list" of devices to scan. It should only contain devices that the host itself or its storage-CSI owns, never VM-guest LUNs.
- `/etc/lvm/backup/*` — LVM metadata backups; they often record the creating host (as a pod name) and time, which confirms the leak.

If `system.devices` contains VM-internal LUNs, the host's LVM activates PVs inside those LUNs on boot or scan, which is what prevents teardown. The symptom is especially visible during VM migrations because the CSI teardown step runs exactly when the offending LVM claim is most active.

## Resolution

### Preferred path on ACP

ACP **virtualization** (`docs/en/virtualization/`) is KubeVirt-based and ACP **storage** (`docs/en/storage/`, including Ceph / MinIO / TopoLVM for cluster-managed storage) does not put VM-internal LUNs on the host LVM scan path. Where an external vendor-owned FC array is used instead, the operator must coordinate with the storage vendor to make sure the CSI driver's host-side configuration explicitly excludes VM-internal LUNs from host LVM.

On ACP clusters that use **TopoLVM** (`docs/en/storage/storagesystem_topolvm/`) the physical volumes managed by TopoLVM are accounted for explicitly — the node-level LVM configuration reflects only TopoLVM's own VG, and guest-internal LVM structures never reach `system.devices` because the guest's block device is the TopoLVM-backed LV, not a raw LUN.

### Underlying mechanics — keep the host LVM scan clean

1. **Scope the host's LVM device allow list.** Edit `/etc/lvm/devices/system.devices` on every worker node so it contains only:

   - The device(s) backing the node OS.
   - Any CSI-owned devices the node legitimately participates in (the specific list depends on the storage vendor; consult their on-node guidance).

   VM-internal LUNs (anything that shows a different LVM UUID created by a VM guest) must be excluded. The same applies to `/etc/lvm/lvm.conf` — the `devices { filter = [...] }` section should deny VM-internal LUN paths unless the vendor explicitly documents otherwise.

2. **Flush stale LVM backups if they reference VM metadata.** Inspect `/etc/lvm/backup/` and `/etc/lvm/archive/` for entries that point back to VM-guest PVs/VGs. These files are harmless on their own, but they hint at prior scans — removing them (after taking a copy) is sensible housekeeping.

3. **Engage the storage vendor.** The real fix is to stop the VM-internal LUNs from being presented to the host in a way that makes the host's LVM see them. Multipath and host LVM configuration for a given array is vendor-specific; the vendor's support channel is the source of truth for:

   - Multipath aliases / black-listing.
   - Per-LUN attributes that hint to the host to treat the LUN as opaque.
   - CSI driver knobs that place the LUN at a path excluded from the host LVM filter.

4. **Recover a stuck VM while the fix is rolled out.** If a VM is already paused on the target and the source still holds the multipath device, the operational steps are:

   - Identify the multipath alias on the source node: `multipath -ll | grep -B1 <lun-wwn>`.
   - List holders: `lsblk -o NAME,HOLDERS /dev/dm-<n>`. If the holder is a VG, deactivate the VG (`vgchange -an <vg-name>`) and re-try the migration; if the holder is a mounted filesystem, that must not be the case for a VM LUN and indicates a deeper misconfiguration.
   - Once the CSI teardown succeeds on the source, the VMI on the target transitions out of `FailedMapVolume` automatically on the next retry.

## Diagnostic Steps

On every worker hosting VMs backed by FC LUNs, capture the following from the host namespace:

```bash
kubectl debug node/<node> -- chroot /host bash -c '
  cat /etc/lvm/devices/system.devices;
  echo "--- backup ---";
  ls -l /etc/lvm/backup/;
  echo "--- multipath ---";
  multipath -ll;
  echo "--- blkid ---";
  blkid
'
```

The goal is to confirm two things:

- `system.devices` contains **only** host-owned and CSI-owned devices. Any line that names a LUN used as a VM disk is a red flag.
- `multipath -ll` shows the expected LUNs — one alias per FC LUN — and `blkid` does not surface guest-internal LVM signatures (`LVM2_member`) on a multipath device that should belong to a VM.

Map the failing PVC to its concrete multipath alias:

```bash
kubectl -n <ns> get pvc <pvc-name> -o jsonpath='{.spec.volumeName}{"\n"}'
kubectl get pv <pv-name> -o yaml | grep -E 'serial|volumeHandle|wwid|wwn'
```

Cross-check the alias on the source node with `multipath -ll | grep <wwid>` and its holders with `lsblk -o NAME,HOLDERS`. A holder that is not the CSI plugin confirms the leak.

For confirmation that the fix is durable, re-run the migration after the `system.devices` clean-up — the multipath device should now be released on the source as soon as the VMI hand-off begins, and the target pod should complete `MapVolume.SetUpDevice` on the first attempt.
