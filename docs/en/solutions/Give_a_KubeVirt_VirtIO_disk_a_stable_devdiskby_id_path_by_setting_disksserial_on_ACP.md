---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500717
---

# Give a KubeVirt VirtIO disk a stable /dev/disk/by-id path by setting disks[].serial on ACP

## Issue

A guest application or in-VM configuration that pins a disk by its `/dev/disk/by-id/` path cannot find a VirtIO disk attached to a `virtualmachines.kubevirt.io`. The block device is present at the kernel level (for example `/dev/vdb`), but the `/dev/disk/by-id/` directory has no `virtio-*` symlink for it — sometimes the directory is empty altogether. Pinning a filesystem mount, an LVM PV, a database data dir, or a Kubernetes CSI raw-block consumer to a by-id path therefore fails immediately after a VM reboot or after the device-letter ordering shifts.

## Root Cause

By default the KubeVirt VirtIO disk model does not present a hardware serial number to the guest. Guest udev builds the `/dev/disk/by-id/virtio-<serial>` symlinks from the disk's hardware-level identifier, so when the device exposes no serial, udev has nothing to anchor a `by-id` entry on, even though the block device itself is fully usable.

This was directly observed on Alauda Container Platform with `kubevirt-operator` (KubeVirt `v1.7.0-alauda.2`, HyperConverged singleton `kubevirt-kubevirt-hyperconverged` in the `kubevirt` namespace, `PHASE=Deployed`, Kubernetes `v1.34.5-1`). A CentOS 7.9 guest with three VirtIO disks where only the data disk carried `disks[].serial=my-stable-disk-01` showed exactly one entry under `/dev/disk/by-id/` — the one for the disk that had a serial — while the two disks without a serial appeared only under `/dev/disk/by-path/`.

## Resolution

Set `spec.template.spec.domain.devices.disks[].serial` to a unique alphanumeric string on every VirtIO disk that the guest needs to address by a stable name, then restart the VM. The serial is propagated through the libvirt domain XML to QEMU, and guest udev exposes the disk at `/dev/disk/by-id/virtio-<serial>`.

The `serial` field is defined on the upstream KubeVirt VirtualMachine CRD shipped on ACP at `spec.template.spec.domain.devices.disks[].serial <string>` with the description `Serial provides the ability to specify a serial number for the disk device.` The surrounding shape is upstream: `disks <[]Object>` (disks, cdroms, and luns) and `disk.bus <string>` with supported values `virtio`, `sata`, `scsi`, `usb`.

Patch the VM template so that each disk needing a stable path carries a unique serial:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: <vm-name>
  namespace: <vm-namespace>
spec:
  template:
    spec:
      domain:
        devices:
          disks:
          - name: rootdisk
            disk:
              bus: virtio
          - name: data-disk
            disk:
              bus: virtio
            serial: my-stable-disk-01
```

Apply the same field with `kubectl patch` if the VM already exists:

```bash
kubectl -n <vm-namespace> patch vm <vm-name> --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/domain/devices/disks/1/serial","value":"my-stable-disk-01"}]'
```

Then restart the VM so the new template materializes into a fresh VMI:

```bash
kubectl -n <vm-namespace> delete vmi <vm-name>
```

(`runStrategy: Always` recreates the VMI automatically.) After the guest is back up the new path is visible:

```text
/dev/disk/by-id/virtio-my-stable-disk-01 -> ../../vdb
```

Guest applications, `/etc/fstab` entries, LVM filters, and similar consumers can now address the disk through that path, and the path is invariant across reboots and device-letter reshuffles.

## Diagnostic Steps

Confirm the CRD shape on the cluster — the `serial` field must be present on the upstream `kubevirt.io/v1` VirtualMachine CRD:

```bash
kubectl explain virtualmachine.spec.template.spec.domain.devices.disks.serial
```

Expected output describes `FIELD: serial <string>` with the description `Serial provides the ability to specify a serial number for the disk device.`.

For a running VM where the by-id symlink is missing, read the current VMI to see which disks actually carry a serial:

```bash
kubectl -n <vm-namespace> get vmi <vm-name> \
  -o jsonpath='{range .spec.domain.devices.disks[*]}{.name}{"  serial="}{.serial}{"\n"}{end}'
```

Disks listed with an empty `serial=` value will have no `/dev/disk/by-id/virtio-*` entry inside the guest, regardless of how the guest OS is configured.

From inside the guest, confirm the udev attribute. A disk that has a serial carries an `ID_SERIAL` property and a `DEVLINKS` entry under `/dev/disk/by-id/`; a disk that has no serial carries neither and only shows `by-path` devlinks:

```bash
udevadm info --query=property --name=/dev/vdb | grep -E 'ID_SERIAL|DEVLINKS'
```

A serial mutation does not propagate to a live VMI. The KubeVirt API rejects direct VMI updates (`update of VMI object is restricted`), and patching the VM template only updates the staged template — the running VMI keeps the previous serial until the next restart. Always plan for a VM restart when changing a disk serial.

```bash
kubectl -n <vm-namespace> get vm  <vm-name> -o jsonpath='{.spec.template.spec.domain.devices.disks[*].serial}{"\n"}'
kubectl -n <vm-namespace> get vmi <vm-name> -o jsonpath='{.spec.domain.devices.disks[*].serial}{"\n"}'
```

If the two outputs differ, the VM template is ahead of the live VMI and a restart is required for the new `/dev/disk/by-id/virtio-<serial>` path to appear in the guest.
