---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VirtIO Disks in VMs Are Missing Stable /dev/disk/by-id Symlinks Until a Serial Is Set
## Issue

Inside a VM running on ACP Virtualization (KubeVirt under the hood), applications and system configurations that rely on stable device paths under `/dev/disk/by-id/` — for example, `/etc/fstab` entries keyed by `by-id`, Oracle ASM disk groups, LVM scans with explicit device filters — fail to find their VirtIO disks. The block devices themselves are present (`/dev/vda`, `/dev/vdb`, …), but `/dev/disk/by-id/` either has no entries for them or has only partial ones. `/dev/disk/by-uuid/` works for filesystem-formatted volumes but is not suitable for raw block devices.

The symptom shows up on any guest OS whose udev rules generate `by-id` symlinks from a hardware serial number (the common case for recent Linux distributions and Windows alike). The guest is working correctly — it is reporting what the hypervisor gives it, and the hypervisor is giving it a VirtIO disk with no serial.

## Root Cause

A VirtIO disk, unlike an emulated SCSI or SATA disk, does not carry an intrinsic hardware serial number. The guest's udev subsystem constructs `/dev/disk/by-id/virtio-<serial>` symlinks only when a serial is actually exposed on the `virtio_blk` device; with no serial, udev has no stable identifier to name the link by.

KubeVirt does not, by default, synthesise a serial for each VirtIO disk. The disk's `.spec.domain.devices.disks[].serial` field is optional and defaults to empty. When left empty, the running guest sees a VirtIO disk with no `ID_SERIAL` attribute, and the `by-id` symlink is never created.

## Resolution

Define an explicit, unique, alphanumeric serial on each VirtIO disk in the VM spec. The serial is passed verbatim to the guest as the VirtIO device's serial attribute, and the guest's udev rules then create the corresponding `by-id` entry.

### 1. Patch the VM manifest

Add `serial` on each disk that needs a stable `by-id`. The value is a free-form alphanumeric token — pick something descriptive and collision-free (disk role + instance is a safe convention). Do not reuse the same serial across multiple disks on the same VM; doing so lets the guest map both links to one device and is confusing when debugging.

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: app-vm
spec:
  template:
    spec:
      domain:
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: virtio
              serial: app-root-01
            - name: data-disk
              disk:
                bus: virtio
              serial: app-data-01
        ...
```

Apply the change, then restart the VM — the serial is passed at libvirt domain-definition time, so a live change is not picked up until the virt-launcher pod is recreated:

```bash
kubectl apply -f app-vm.yaml
virtctl restart app-vm -n <vm-namespace>
```

For a VM that is currently off, a start is sufficient:

```bash
virtctl start app-vm -n <vm-namespace>
```

### 2. Confirm the serial arrives in the guest

Once the guest boots, the device paths show up under `/dev/disk/by-id/` with the `virtio-` prefix:

```bash
# From inside the guest
ls -l /dev/disk/by-id/ | grep virtio
# lrwxrwxrwx ... virtio-app-root-01 -> ../../vda
# lrwxrwxrwx ... virtio-app-data-01 -> ../../vdb
```

Update `/etc/fstab`, LVM filters, ASM disk strings, and any other consumer to reference the `by-id` path rather than `vda` / `vdb`. The `by-id` link is now stable across VM restarts and across live migrations, because the serial is a property of the VM spec and not of the host device the guest happens to land on.

### 3. Backfill existing VMs

For a fleet of VMs already running without serials, this is best handled as a rolling maintenance activity: patch each VM, schedule a restart window, and verify the post-restart `by-id` mapping before moving to the next. The patch itself is cheap — it does not modify the disk contents — but it requires a restart to apply, which is a scheduling concern rather than a data concern.

A small patch script is enough for bulk work:

```bash
for VM in vm-a vm-b vm-c; do
  kubectl patch vm "$VM" --type json -p '[
    {"op":"add","path":"/spec/template/spec/domain/devices/disks/0/serial",
     "value":"'"${VM}"'-root"},
    {"op":"add","path":"/spec/template/spec/domain/devices/disks/1/serial",
     "value":"'"${VM}"'-data"}
  ]'
  virtctl restart "$VM"
done
```

## Diagnostic Steps

Narrow the problem to "no serial on the VirtIO device" before patching anything.

Inside the guest, enumerate what udev actually saw for the VirtIO block devices:

```bash
udevadm info --query=property --name=/dev/vdb | grep -E 'ID_SERIAL|ID_BUS'
```

On a VM whose disk has no serial the `ID_SERIAL` line is either absent or blank — that is the unambiguous signature. On a VM whose disk has a serial (either because the VM spec already sets one or because the disk is attached via a bus that carries one natively, e.g. SCSI) `ID_SERIAL` contains the expected value and the `by-id` symlink exists.

From the cluster side, inspect the VM spec to confirm the field is really missing rather than silently stripped:

```bash
kubectl -n <vm-namespace> get vm app-vm -o yaml \
  | yq '.spec.template.spec.domain.devices.disks[] | {name, serial}'
```

If `serial` is `null` or absent on the disks of interest, the fix is the patch above. If `serial` is populated but the guest still does not see it, the VM has not been restarted since the spec change — `virtctl restart` is the remaining step.

For VMs where switching disk bus from VirtIO to SCSI is on the table (for example, because the guest OS needs WWN-style `by-id` paths that only SCSI emulation provides), changing `disk.bus` from `virtio` to `scsi` is a larger change with performance and driver implications and should not be done merely to get a `by-id` symlink — setting a serial on the VirtIO disk covers the stable-naming requirement without trading VirtIO's performance characteristics.
