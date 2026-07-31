---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM migration to KubeVirt fails with virt-v2v "no bootloader detected"
## Issue

A VM migration into the KubeVirt-based virtualization stack — typically from VMware via the platform's import workflow — fails during the disk conversion phase. The conversion pod in the migration namespace logs out the v2v trace and aborts:

```text
libguestfs: trace: v2v: find = ["/<distro>", "/<distro>/fonts",
                                "/<distro>/grubenv", "/<distro>/grubx64.efi"]
virt-v2v: error: no bootloader detected
```

The migration plan is left in `Failed`, the target DataVolume never lands, and the imported VM cannot be started. The source VM boots fine on the original hypervisor — the failure is purely in the conversion pipeline.

## Root Cause

`virt-v2v` (the converter that backs every KubeVirt VM-import workflow including Forklift / Migration Toolkit for Virtualization) walks the source disk's filesystems to detect the bootloader so it can rewrite the bootloader stanza for the target hypervisor (KVM/QEMU). For EFI-booted Linux guests the detection looks under `/boot/efi/EFI/<distro>/` for the GRUB EFI binary.

If the EFI System Partition (ESP) is **not mounted** at `/boot/efi` when the v2v probe runs, the EFI files are physically present on the disk but not visible at the expected path. The probe then sees an empty (or near-empty) `/boot/efi`, decides there is no bootloader, and aborts. The source VM still boots on the original hypervisor because firmware mounts the ESP directly at boot time without needing the OS to remount it later.

This typically happens when:

- The guest's `/etc/fstab` lists the ESP as `noauto` or omits it entirely (a manual partitioning shortcut left over from install).
- The source VM was rebuilt from a cloned image and the cloning process dropped the ESP entry.
- A custom kickstart never wrote the ESP to fstab even though the partition was created.

## Resolution

Fix the source VM so the ESP is automatically mounted at `/boot/efi` on every boot, then re-run the migration. The source VM has to be the one that gets fixed — there is no v2v-side workaround because the converter must observe the ESP through the filesystem path, not at the partition level.

### Step 1 — confirm the partition exists and is unmounted

On the source VM:

```bash
lsblk -fo NAME,FSTYPE,LABEL,UUID,MOUNTPOINT
```

Expect a `vfat` partition (commonly `/dev/sda1` or `/dev/sda2`) with no mount point listed. If the partition is missing entirely, the source VM is BIOS-booted (not EFI) and this article does not apply — the migration failure is a different cause.

### Step 2 — add the ESP to fstab and mount it

Capture the partition's UUID from the previous output and add the ESP mount to `/etc/fstab`:

```bash
ESP_UUID=$(lsblk -no UUID /dev/sda1)        # adjust device path as needed
echo "UUID=$ESP_UUID  /boot/efi  vfat  umask=0077,shortname=winnt  0 2" \
  | sudo tee -a /etc/fstab
sudo mkdir -p /boot/efi
sudo mount /boot/efi
ls -lh /boot/efi/EFI/                        # should now list the distro EFI dir
```

The exact mount options are distro-specific; the snippet above is the usual `vfat` invocation that respects EFI permissions.

### Step 3 — verify the bootloader is now visible

Confirm the EFI GRUB binary is reachable through the filesystem path:

```bash
find /boot/efi/EFI -maxdepth 3 -type f
# Expected to include something like:
# /boot/efi/EFI/<distro>/grubx64.efi
```

If the file is present here, the next v2v probe will detect the bootloader.

### Step 4 — re-run the migration plan

Trigger the migration plan from the platform's UI or by reapplying the migration CR. The conversion pod should progress past the bootloader-detection step:

```bash
kubectl -n cpaas-virt-migration logs -f -l job-name=copy-of-<vm-name>
```

Successful conversion ends with `virt-v2v: ... finished, result: <distro>` instead of the previous `no bootloader detected`. The DataVolume lands, the VM resource creates, and the imported VM is bootable on the target hypervisor.

## Diagnostic Steps

To replicate the v2v probe outside the migration plan and confirm the fix worked, mount the source disk image with `guestfish` from a debug pod that has libguestfs-tools:

```bash
guestfish --ro -a /path/to/source.vmdk
><fs> run
><fs> list-filesystems
><fs> mount /dev/sda3 /
><fs> mount /dev/sda1 /boot/efi
><fs> ls /boot/efi/EFI
```

A non-empty listing under `/boot/efi/EFI/<distro>` confirms the ESP holds the GRUB EFI files and that they are reachable through the conventional path. If `mount /dev/sda1 /boot/efi` fails inside guestfish, the source disk has a different layout than expected — typical for VMs converted from BIOS to EFI without re-partitioning.

For the live migration plan, watch the conversion container's logs in detail to spot at which step the failure recurs:

```bash
kubectl -n cpaas-virt-migration get pod -l role=conversion -w
kubectl -n cpaas-virt-migration logs -f <conversion-pod> --tail=200
```

Failures past the bootloader-detection step (e.g. `unable to install qemu-guest-agent`) point at separate causes — this article only covers the no-bootloader-detected variant. The post-bootloader steps each have their own remediation flows.

For systematic prevention across multiple guests scheduled for migration, add a pre-flight check to the source-side automation: any guest whose `mount` output does not list `/boot/efi` while EFI is enabled in firmware should be skipped for migration until fstab is corrected. The MTV / Forklift workflow does not currently enforce this pre-flight on the source side; flagging it in the migration plan's intake step saves the conversion pod from being scheduled and then aborting late.
