---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Mount an ISO image to a KubeVirt VM via a PVC-backed CD-ROM on ACP

## Overview

Alauda Container Platform ships KubeVirt-based virtualization through the `kubevirt-operator`; on the verified cluster the `kubevirts.kubevirt.io` singleton `kubevirt-kubevirt-hyperconverged` lives in the `kubevirt` namespace and reports `status.observedKubeVirtVersion=v1.7.0-alauda.2`, `PHASE=Deployed`. The data-plane workloads (`virt-operator`, `virt-api`) carry the matching `build-harbor.alauda.cn/3rdparty/kubevirt/...:v1.7.0-alauda.2` image tag. The `virtualmachines.kubevirt.io` CRD is the upstream KubeVirt CRD (group `kubevirt.io`, served versions `v1` and `v1alpha3`) — unmodified shape, no platform-specific renaming.

Container Data Importer (CDI) is delivered alongside KubeVirt by the same operator; on the verified cluster `cdis.cdi.kubevirt.io/cdi-kubevirt-hyperconverged` is `Deployed`, and the CDI CRDs `datavolumes.cdi.kubevirt.io`, `volumeimportsources.cdi.kubevirt.io`, and `volumeuploadsources.cdi.kubevirt.io` are all served. CDI is the generic KubeVirt-native path for populating a `persistentvolumeclaims` (core/v1) with an ISO image — by HTTP/registry import, by `virtctl image-upload`, or via a `DataVolume` source.

## Issue

A user wants to attach an ISO image as a CD-ROM device to a `virtualmachines.kubevirt.io` running on ACP, either at create time so the VM boots from the ISO, or to make installation media available to the guest. The supported path uses a `persistentvolumeclaims` populated with the ISO bytes via CDI and referenced from the VM spec as a CD-ROM disk.

## Resolution

**Step 1 — Populate a PVC with the ISO.** Create a `persistentvolumeclaims` in the same namespace as the VM and populate it with the ISO bytes. The default `topolvm-hdd` `StorageClass` on the verified cluster is the binding target for the CDI ISO PVC. The simplest path is `virtctl image-upload`, which drives the `volumeuploadsources.cdi.kubevirt.io` flow:

```bash
virtctl image-upload pvc iso-disk \
  --namespace <vm-namespace> \
  --size 1Gi \
  --image-path /local/path/to/installer.iso \
  --storage-class topolvm-hdd \
  --access-mode ReadWriteOnce
```

Alternatively, create a `DataVolume` (`datavolumes.cdi.kubevirt.io`) with an `http` / `registry` / `upload` source so CDI imports the ISO into the resulting PVC. Either path produces an ordinary `persistentvolumeclaims` in the VM's namespace whose contents are the ISO image.

**Step 2 — Declare the CD-ROM disk and PVC volume on the VirtualMachine.** A CD-ROM disk on the upstream KubeVirt CRD is declared as a `spec.template.spec.domain.devices.disks[]` entry with a `cdrom` object. The `cdrom` object carries three fields: `bus` (allowed values `virtio`, `sata`, `scsi`), `readonly` (boolean, defaults `true`), and `tray` (`open` or `closed`, defaults `closed`). The disk entry's `name` field is the device name, and the disk is matched to its backing volume by the same `name` on a `spec.template.spec.volumes[]` entry.

The PVC carrying the ISO is referenced from a `spec.template.spec.volumes[]` entry of kind `persistentVolumeClaim`. The volume's `persistentVolumeClaim.claimName` (required) names the PVC in the same namespace as the VM. Matching `name=iso-cdrom` on both the disk and the volume binds the CD-ROM device to the ISO PVC:

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: <vm-name>
  namespace: <vm-namespace>
spec:
  runStrategy: Halted
  template:
    spec:
      domain:
        devices:
          disks:
          - name: iso-cdrom
            cdrom:
              bus: sata
              readonly: true
        resources:
          requests:
            memory: 2Gi
      volumes:
      - name: iso-cdrom
        persistentVolumeClaim:
          claimName: iso-disk
```

The verified cluster admitted this exact `disks[].cdrom` + `volumes[].persistentVolumeClaim` shape unmodified — the API accepts the upstream KubeVirt recipe verbatim.

**Step 3 — Start (or restart) the VM.** The CD-ROM volume becomes visible to the guest only after the VM is (re)started. The verified KubeVirt build `v1.7.0-alauda.2` exposes the running-VM hotplug subresources `virtualmachineinstances/addvolume` and `virtualmachineinstances/removevolume` only — there is no CD-ROM-specific insert/eject subresource served by `subresources.kubevirt.io/v1`, and there is no corresponding feature gate enabled on the `kubevirts.kubevirt.io` CR. The active feature-gate set on the verified cluster is `CPUManager, Snapshot, ExpandDisks, HostDevices, VMExport, KubevirtSeccompProfile, WithHostModelCPU, HypervStrictCheck, VideoConfig, HotplugVolumes`; only `HotplugVolumes` governs hotplug, and it targets disk-class volumes rather than CD-ROMs. So a CD-ROM declared on a `Running` VM does not take effect until the VM is restarted, and a CD-ROM cannot be added to an already-running VM through the hotplug subresources.

Set `spec.runStrategy: Always` (or use `virtctl start <vm>`) to bring the VM up with the CD-ROM mounted. If the VM was already `Running` when the CD-ROM disk was added, restart it:

```bash
virtctl restart <vm-name> -n <vm-namespace>
```

The recreated `virt-launcher-<vm>-<hash>` pod attaches the ISO PVC, and the guest sees the CD-ROM device on the configured bus.

## Verification

After the VM reaches `Running`, the CD-ROM is visible at the KubeVirt API surface as the named disk on the VMI:

```bash
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.domain.devices.disks[?(@.name=="iso-cdrom")]}{"\n"}'
kubectl get vmi <vm-name> -n <vm-namespace> \
  -o jsonpath='{.spec.volumes[?(@.name=="iso-cdrom")]}{"\n"}'
```

Inside the guest, the CD-ROM appears on the bus selected by `cdrom.bus` (commonly `/dev/sr0` for `sata`/`scsi`). The PVC is the source of truth for the ISO bytes; rotating the media means populating a new PVC and updating the volume reference, then restarting the VM.
