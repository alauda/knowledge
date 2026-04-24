---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Virtual machines that declare a persistent UEFI-variables store or a persistent vTPM (for example, Windows guests that require Virtualization-Based Security) fail to start on clusters backed by a **block-mode** CSI driver. The symptom shows up in multiple places depending on the entry point:

- A VM migration from vSphere (or another hypervisor) gets stuck. The import pipeline cannot provision the small persistent-state PVCs that KubeVirt's firmware needs.
- Creating a fresh VM from a template that includes `firmware.bootloader.efi.persistent: true` or `devices.tpm.persistent: true` never reaches `Ready`. The VM's `virt-launcher` pod sits pending on one or more PVCs in `Pending` state.
- `virt-launcher` or the CSI `NodeStageVolume` path logs a filesystem-creation failure that names a minimum-block-count error:

  ```text
  format of disk "/dev/dm-XX" failed: type:("xfs") ...
  size 2560 of data subvolume is too small, minimum 4096 blocks
  ```

The cluster is healthy; other PVCs provisioned against the same CSI driver work. Only the persistent-state PVCs that KubeVirt itself creates fail.

## Root Cause

KubeVirt stores UEFI variables and vTPM state in very small persistent volumes. Historically these PVCs default to **10 MiB**, which is more than the underlying raw byte count UEFI or vTPM actually need. The default was calibrated for file-mode PVCs — the filesystem sits on top of a file, and the minimum viable size is whatever the kernel's `mkfs.xfs` accepts for a single-byte payload.

On a **block-mode** CSI driver, CDI provisions a raw block device and formats it directly. XFS has a hard minimum block count (typically 4096 blocks, so ~16 MiB for 4 KiB blocks). When CDI asks the CSI driver for 10 MiB, the driver allocates a 10 MiB block device, `mkfs.xfs` tries to format it, and fails with the minimum-block-count error. The PVC stays in `Pending` forever, and any VM that depends on it cannot start.

The fix is to raise the default size CDI asks for on that specific CSI driver's `StorageProfile` — CDI will then provision a PVC big enough to satisfy XFS's minimum, and the filesystem format succeeds.

## Resolution

CDI exposes a per-driver annotation on its `StorageProfile` objects that overrides the default persistent-state PVC size. Raising it to 100 MiB (or any value above 16 MiB) unblocks every VM using that driver.

### Identify the affected StorageProfile

`StorageProfile` objects exist one-to-one with `StorageClass` objects, and CDI manages them automatically. Find the profile for the problematic CSI driver:

```bash
kubectl get storageprofile
```

Match the `NAME` column (which mirrors the `StorageClass` name) with the storage class the failing VM's PVC is pointing at:

```bash
kubectl get pvc -A --field-selector=status.phase=Pending \
  -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,SC:.spec.storageClassName,MODE:.spec.volumeMode'
```

Pending PVCs with `MODE=Block` (or unset, when the driver defaults to block) on a `StorageClass` that the affected VM references are the targets.

### Apply the override annotation

Annotate the `StorageProfile` to widen the minimum persistent-state PVC size:

```bash
kubectl annotate storageprofile <profile-name> \
  cdi.kubevirt.io/minimumSupportedPvcSize=100Mi --overwrite
```

100 MiB is a common safe value — comfortably above XFS's 16 MiB floor and still small enough that dozens of VMs on the same cluster do not add meaningful storage cost. Pick a value appropriate to the CSI driver's allocation granularity (some drivers round up to 1 GiB regardless; in that case, the annotation only affects what CDI *requests*, not what the driver actually allocates).

Verify the annotation is on the object:

```bash
kubectl get storageprofile <profile-name> -o jsonpath='{.metadata.annotations}{"\n"}' | jq
```

### Re-create the failing PVC / VM

The annotation affects **new** PVCs. Existing pending PVCs keep their 10 MiB request and continue to fail; delete and recreate them so CDI re-provisions at the larger size:

```bash
# Identify the failing PVCs.
kubectl -n <ns> get pvc | grep Pending

# Delete (CDI / the VM will re-create them at the larger size).
kubectl -n <ns> delete pvc <name>
```

For a VM created through KubeVirt, deleting the VMI is usually enough — the VM controller recreates the PVC on the next reconcile:

```bash
kubectl -n <ns> delete vmi <vm-name>
kubectl -n <ns> get pvc -w
```

The new PVC binds, `mkfs.xfs` succeeds, and the VMI reaches `Running`. For migration imports, re-trigger the import pipeline once the storage profile annotation is in place; the persistent-state PVCs it creates on the next attempt will be sized correctly.

### Which CSI drivers are affected

Any **block-mode** CSI driver where XFS's minimum-block-count is higher than the 10 MiB default can exhibit this. IBM block storage, on-prem SAN-backed drivers, and some cloud block-volume drivers are common examples. File-mode drivers (NFS, CephFS, any "file-backed" storage class) are not affected, because the filesystem sits on a pre-existing filesystem and has no minimum-block-count floor.

The annotation is safe to apply on file-mode profiles as well — it has no effect there — so a blanket apply across every `StorageProfile` on the cluster is a fine defensive posture if it is not obvious which drivers are block-mode.

## Diagnostic Steps

Inspect the failing PVC's events to confirm the filesystem-format failure is the actual blocker (rather than a different provisioning issue):

```bash
kubectl -n <ns> describe pvc <name>
```

Look under `Events` for a message from the CSI driver that includes `mkfs.xfs` output or a minimum-block error. If instead the events show quota rejections, provisioner timeouts, or missing `StorageClass`, that is a different problem and the annotation will not help.

Read the effective size CDI requested for the PVC:

```bash
kubectl -n <ns> get pvc <name> -o jsonpath='{.spec.resources.requests.storage}{"\n"}'
```

If the value is `10Mi` (or similar), CDI's default is in effect and the annotation has not yet propagated. Confirm by reading the `StorageProfile`:

```bash
kubectl get storageprofile <profile-name> -o jsonpath='{.metadata.annotations.cdi\.kubevirt\.io/minimumSupportedPvcSize}{"\n"}'
```

It should print the annotated value (`100Mi`). If it prints empty, the annotation did not apply; re-run the `kubectl annotate` command and confirm against the object.

Confirm the VM's firmware spec actually requests persistent state (only then does CDI create these small PVCs):

```bash
kubectl -n <ns> get vm <name> \
  -o jsonpath='{.spec.template.spec.domain.firmware}{"\n"}{.spec.template.spec.domain.devices.tpm}{"\n"}'
```

`efi.persistent: true` and/or `tpm.persistent: true` trigger the UEFI / vTPM PVCs that this note addresses. A VM without either does not need the override.
