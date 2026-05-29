---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500583
---

# Inter-cluster VM disk export lands as a tar archive when source PVC lacks the CDI content-type annotation

## Issue

On Alauda Container Platform with KubeVirt installed (namespace `kubevirt`, HCO `v1.17.0`, `virt-exportproxy v1.7.0-alauda.2`, `cdi-controller v1.64.0-alauda.2`), exporting a VM disk from a filesystem-backed PVC to another cluster can produce a destination disk that the new VM cannot boot from. The trigger is a source PVC whose disk image is *not* tagged with the CDI content-type annotation: when that annotation is absent, the export server publishes the volume through its `tar.gz` format URL (the `status.links.{internal,external}.volumes[].formats[].format` surface on the `VirtualMachineExport` CR exposes both `disk_image` and `archive` form factors per volume, and the choice between them is driven by the source PVC metadata).

On the destination side, when CDI on `cdi.kubevirt.io/v1beta1` consumes that stream into a PVC that is owned by a `VirtualMachine` (and not by a `DataVolume`) and whose annotations do not include `cdi.kubevirt.io/storage.contentType`, the controller writes the incoming bytes through to the target device without unpacking the tar wrapper, leaving the destination volume as a literal POSIX tar archive instead of a raw disk image.

## Root Cause

A tar archive on a block or file backend has no MBR/GPT, no bootloader, and no filesystem the guest firmware can hand off to — it is a sequence of header+payload records, not a disk. A VM that points at such a volume therefore cannot complete firmware-to-kernel handoff and fails to boot.

The behavior on the destination cluster is governed entirely by the source PVC's CDI metadata: with the annotation missing and the ownerReference pointing at a `VirtualMachine`, the upstream-stable `cdi.kubevirt.io/v1beta1` reconciliation path treats the inbound bytes as opaque archive content rather than a disk image to extract, so the wrapping survives all the way onto the destination volume.

## Resolution

Set the CDI content-type annotation on the source PVC before triggering the export, so the export server selects the disk-image format rather than the archive format and the destination CDI controller treats the inbound stream as a raw disk:

```bash
kubectl annotate pvc -n <source-ns> <source-pvc> \
  cdi.kubevirt.io/storage.contentType=kubevirt
```

Re-run the export and the downstream import after the annotation is in place; the destination volume then lands as a real disk image and the VM created against it boots normally. The same annotation key (`cdi.kubevirt.io/storage.contentType`) is interpreted identically by the cluster's `cdi-controller v1.64.0-alauda.2` because the group/version `cdi.kubevirt.io/v1beta1` is upstream-stable, so this workaround applies to any forklift-style cross-cluster VM migration workflow that round-trips disks through a `VirtualMachineExport` plus a CDI import.

## Diagnostic Steps

Confirm the destination PVC is actually a tar archive (and not a corrupted-but-still-disk image) by sampling the first megabyte of the volume from inside the VM's `virt-launcher` pod in the `kubevirt` namespace and running `file` against the captured bytes:

```bash
kubectl exec -n <vm-ns> <virt-launcher-pod> -- \
  dd if=/dev/vol-0 bs=1M count=1 > vol-0.out
file vol-0.out
```

A response of `POSIX tar archive (GNU)` confirms the destination disk was written as a tar wrapper rather than an unpacked disk image, which matches the failure mode described above and points back at the missing `cdi.kubevirt.io/storage.contentType` annotation on the source PVC as the root cause.

Locate the `virt-launcher` pod for the affected VM via the standard KubeVirt pod label, which is honored on this cluster:

```bash
kubectl get pod -n <vm-ns> -l kubevirt.io=virt-launcher
```
