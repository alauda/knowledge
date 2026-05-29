---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500695
---

# Recover an ACP virtualization VM whose root disk was detached on a Running VM

## Issue

On Alauda Container Platform with the virtualization bundle installed (`HyperConverged` singleton `kubevirt-hyperconverged` in namespace `kubevirt`, observed `KubeVirt` version `v1.7.0-alauda.2` with HCO operator `1.17.0`, and `CDI` singleton `cdi-kubevirt-hyperconverged` Deployed), a persistent root disk on a `VirtualMachine` is modelled as a pair: a `spec.template.spec.volumes[]` entry of type `persistentVolumeClaim` (with the required `claimName` pointing at the boot PVC) and a `spec.template.spec.domain.devices.disks[]` entry that gives that volume a device name and an integer `bootOrder` (the lever that marks the disk bootable).

When a request to remove the root disk is issued against a Running VM — either by deleting the `disks[]` entry, deleting the matching `volumes[]` entry, or both — the change is rejected as a live update. The `VirtualMachineInstance` keeps running with its existing rootdisk attached, but the `VirtualMachine` controller records the diff and surfaces a `RestartRequired` condition on `.status.conditions[]` with the message `a non-live-updatable field was changed in the template spec`. The change only takes effect on the next cold restart cycle; if the VM is restarted in that state the new VMI launches without the rootdisk and cannot find a bootable device.

## Root Cause

The boot/origin disk of a VM is non-live-updatable. Hotplug attach and detach against a `VirtualMachineInstance` are driven through the `subresources.kubevirt.io/v1` endpoints `virtualmachineinstances/addvolume` and `virtualmachineinstances/removevolume`, which mutate the VMI through `.status.volumeRequests` and are explicitly described as `hotplug on an active running VMI`; these only apply to volumes flagged for hotplug (`spec.template.spec.volumes[].persistentVolumeClaim.hotpluggable=true`). The persistent rootdisk volume — the one paired with the bootable `disks[]` entry — is not on that path. Edits to the `disks[]`/`volumes[]` entries that define it are template-spec changes, so KubeVirt's webhook holds them as pending and the VMI's `target` (for example `vda`) keeps mirroring the original PVC until a stop/start applies the diff.

The PVC itself is unaffected. Even when the rootdisk's `volumes[]` entry and the owning `dataVolumeTemplates[]` block are both removed from the VM spec, the underlying PVC stays in `STATUS=Bound` — detaching does not delete the backing storage, so the data is intact and available for the recovery step.

## Resolution

The fix is to put the rootdisk reference back into the VM spec with a `bootOrder` and then cold-restart the VM. KubeVirt exposes lifecycle subresources at `subresources.kubevirt.io/v1` (`virtualmachines/start`, `virtualmachines/stop`, `virtualmachines/restart`), so the recovery is a generic `kubectl`-driven sequence even when no UI control is involved.

Confirm the rootdisk's backing PVC is still `Bound` (this is the prerequisite that makes recovery possible — the same PVC can be re-attached without losing data):

```bash
kubectl -n <vm-namespace> get pvc <rootdisk-pvc-name>
```

Stop the VM, patch the VM spec to re-add the rootdisk both as a volume and as a bootable disk, then start the VM again:

```bash
kubectl -n <vm-namespace> patch vm <vm-name> \
  --type merge \
  -p '{"spec":{"runStrategy":"Halted"}}'
```

```bash
kubectl -n <vm-namespace> patch vm <vm-name> --type=json -p='[
  {"op":"add","path":"/spec/template/spec/domain/devices/disks","value":[
    {"name":"rootdisk","bootOrder":1,"disk":{"bus":"virtio"}}
  ]},
  {"op":"add","path":"/spec/template/spec/volumes","value":[
    {"name":"rootdisk","persistentVolumeClaim":{"claimName":"<rootdisk-pvc-name>"}}
  ]}
]'
```

```bash
kubectl -n <vm-namespace> patch vm <vm-name> \
  --type merge \
  -p '{"spec":{"runStrategy":"Always"}}'
```

If the existing spec already has a `disks[]` or `volumes[]` array (for example a network disk that is still attached), use `add` at `/spec/template/spec/domain/devices/disks/-` and `/spec/template/spec/volumes/-` to append the rootdisk entries instead of replacing the arrays. The `bootOrder: 1` on the disk entry is what marks the volume as the bootable device; an integer `bootOrder > 0` on a disk takes precedence over disks without a bootOrder, so it is the explicit lever the recovery depends on.

Once the VMI is back to `Running` after the restart, the rootdisk shows up again on the new VMI's `spec.domain.devices.disks` (as `virtio` with `bootOrder: 1`) and the `RestartRequired` condition is no longer present on the `VirtualMachine` — the pending change has been applied and the VM is booting from the same PVC as before.

## Diagnostic Steps

Identify the PVC that the rootdisk volume points at by reading the `virt-launcher` pod's `spec.volumes` section, which mirrors the persistent volumes mounted into the VMI — the rootdisk entry surfaces as `{name: rootdisk, persistentVolumeClaim: {claimName: <pvc-name>}}`:

```bash
kubectl -n <vm-namespace> get pod \
  -l kubevirt.io/vm=<vm-name> \
  -o jsonpath='{.items[0].spec.volumes}'
```

Confirm that the PVC behind it is still `Bound` — if the rootdisk was simply detached at the spec level, this remains true and the data is intact for the recovery; if the PVC is missing or in `Terminating`, the recovery cannot reuse it:

```bash
kubectl -n <vm-namespace> get pvc <rootdisk-pvc-name>
```

Read the `RestartRequired` condition to verify that the detach is genuinely held as a pending non-live-updatable change rather than something else (for example a controller-level error). The `.status.conditions[]` `type` field is a free string, so the filter is exact:

```bash
kubectl -n <vm-namespace> get vm <vm-name> \
  -o jsonpath='{.status.conditions[?(@.type=="RestartRequired")]}'
```

When the condition is present the message reads `a non-live-updatable field was changed in the template spec`, which is the explicit signal that the spec change has been queued for the next restart and the current VMI still runs on the previous template. Cross-check the VMI to confirm it is still on the old template — `spec.domain.devices.disks` still lists the rootdisk and `status.volumeStatus[].persistentVolumeClaimInfo.claimName` still points at the boot PVC:

```bash
kubectl -n <vm-namespace> get vmi <vm-name> \
  -o jsonpath='{.spec.domain.devices.disks}'
kubectl -n <vm-namespace> get vmi <vm-name> \
  -o jsonpath='{.status.volumeStatus}'
```

If a restart has already been triggered while the detach was pending, the new VMI launches with the rootdisk removed: `spec.domain.devices.disks` is empty, `status.volumeStatus` is empty, and the libvirt domain has zero `<disk>` elements — qemu has no `-blockdev` entry for storage even though the boot order is set, so the guest cannot find a bootable device. In that state the same recovery procedure (re-add the rootdisk entries and restart) brings the VM back, because the underlying PVC is still `Bound`.
