---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A virtual machine needs an ISO image mounted as a CD-ROM — for installer media, driver bundles, or a one-shot configuration payload. The common attempts fail in predictable ways:

- Adding a `CD-ROM`-type volume while the VM is in `Running` state is rejected by the web console (the `CD-ROM` choice is greyed out or refuses to save).
- Uploading the ISO to a location that is not a `PersistentVolumeClaim` (e.g. a local directory on the node) yields no mountable device from the VM's perspective.
- Attempting hot-plug insertion of a CD-ROM into an already-running VM fails on most ACP Virtualization generations because the feature was historically a reboot-only operation.

## Root Cause

KubeVirt (the engine under ACP Virtualization) models a VM disk as a `Volume` backed by a storage resource. For a CD-ROM, the backing resource is a `PersistentVolumeClaim` that holds the ISO bytes — usually populated via a CDI `DataVolume` upload. Two mechanics then drive the user-visible behaviour:

- **CD-ROM vs Disk is a bus decision, not a storage decision.** The `Disk` definition in the VM spec chooses `cdrom:` as the device type, pointing at a `bus` (typically `sata`). This decision is baked into the VM template at launch time.
- **Adding a CD-ROM device to a running VM requires a hot-plug path.** For most generations of the virtualization stack, hot-plugging a *fresh* CD-ROM into a running VM is unsupported; the device must exist in the VM spec at boot. A reboot is therefore required to introduce the CD-ROM the first time.

A later generation of KubeVirt introduced a Technology Preview capability that splits these two concerns: the first setup still requires a VM restart to register the CD-ROM drive, but *after* that initial setup the drive can be emptied and re-filled (ISO inserted or ejected) while the VM keeps running. That is the "insert / eject in a running VM" flow; it is not the same as full CD-ROM hot-plug.

## Resolution

### Canonical flow — prepare the PVC and attach the CD-ROM at boot

This works on every generation and is what the VMware-migration workflow reuses internally when shipping an ISO alongside a VM.

1. Upload the ISO into a `PersistentVolumeClaim` in the same namespace as the VM. The ACP Virtualization "Image" area documents the CDI-backed upload path; the short version is:

   ```yaml
   apiVersion: cdi.kubevirt.io/v1beta1
   kind: DataVolume
   metadata:
     name: my-iso
     namespace: <vm-ns>
   spec:
     source:
       http:
         url: https://<internal-mirror>/images/myinstaller.iso
     pvc:
       accessModes: [ReadWriteOnce]
       resources:
         requests:
           storage: 5Gi
   ```

   `DataVolume` creates the backing PVC and a short-lived importer pod that downloads the ISO.

2. Add the CD-ROM entry to the VM spec. In the web console this is done through *Storage → Add → Volume*, selecting the PVC and choosing **Type: CD-ROM**. On the YAML path, the two shapes that matter are the volume reference and the disk device:

   ```yaml
   spec:
     template:
       spec:
         domain:
           devices:
             disks:
               - name: installer-iso
                 cdrom:
                   bus: sata
         volumes:
           - name: installer-iso
             persistentVolumeClaim:
               claimName: my-iso
   ```

3. Restart the VM at the virtualization level so the CD-ROM is declared by libvirt at boot:

   ```bash
   kubectl -n <vm-ns> virtctl restart <vm-name>
   ```

   The restart is required because the CD-ROM did not exist in the VM's device tree while it was running.

### Insert / eject while running — Technology Preview path

On stack generations where the insert-while-running capability is available, the sequence becomes:

1. Perform the canonical flow above once: create the CD-ROM drive, reboot the VM, confirm the drive is visible to the guest.
2. With the drive now registered, switching the ISO no longer requires a reboot. Replace the underlying PVC (upload a new ISO or swap the claim reference) and the guest sees the media change as a normal disk-tray event. If your deployment exposes `virtctl` insert / eject subcommands, use them to manipulate the drive content; otherwise re-apply the VM spec with the new PVC name.

Treat this mode as experimental until the capability leaves Technology Preview in your deployment: the ability to insert / eject is guarded by a feature gate on the virtualization CR, and the gate may not be enabled in every environment.

### OSS fallback — raw KubeVirt without the web console

If the ACP Virtualization UI flow is not available (for example, a headless automation context), the same result is achieved by `kubectl apply`-ing the `DataVolume` + the VM patch shown above. KubeVirt's `VirtualMachine` CR is the source of truth; the web console only wraps it.

## Diagnostic Steps

1. Confirm the PVC is populated and bound before touching the VM:

   ```bash
   kubectl -n <vm-ns> get pvc my-iso
   kubectl -n <vm-ns> get datavolume my-iso -o jsonpath='{.status.phase}{"\n"}'
   ```

   A `Bound` PVC and a `Succeeded` DataVolume phase mean the ISO is ready. A `Pending` PVC indicates the storage class failed to provision — fix that first.

2. Check what the VM spec currently declares:

   ```bash
   kubectl -n <vm-ns> get vm <vm-name> -o jsonpath='{.spec.template.spec.domain.devices.disks}{"\n"}'
   kubectl -n <vm-ns> get vm <vm-name> -o jsonpath='{.spec.template.spec.volumes}{"\n"}'
   ```

   The CD-ROM disk and the matching PVC-backed volume must both appear. If the web console added the volume but not the device, the VM will boot but the guest OS will see no media.

3. After restart, verify the guest sees the drive:

   ```bash
   kubectl -n <vm-ns> virtctl console <vm-name>
   # inside the guest
   lsblk | grep sr
   # or, on Windows
   wmic cdrom list brief
   ```

4. If the web console refuses to add a CD-ROM while the VM is `Running`, the path forward is either (a) stop the VM and repeat, or (b) verify the Technology Preview hot-insert capability is enabled on this cluster. Do not try to hand-edit the libvirt XML at runtime — the change will be reverted by virt-handler.

When all three steps match the expected output, the ISO is accessible to the guest and the resolution is complete.
