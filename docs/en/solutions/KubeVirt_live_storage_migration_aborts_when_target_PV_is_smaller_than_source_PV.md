---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# KubeVirt live storage migration aborts when target PV is smaller than source PV

## Issue

On Alauda Container Platform (Kubernetes `v1.34.5-1`, KubeVirt HyperConverged `kubevirt-kubevirt-hyperconverged` Phase `Deployed` in namespace `kubevirt`, `kubevirt-migration-controller` Running), a live storage migration of a virtual-machine disk fails inside the `virt-launcher` pod's QEMU process even though the source and target `PersistentVolumeClaim` requested identical storage capacity. The QEMU `-blockdev` initialization aborts with a message of the form:

```text
-blockdev {"driver":"raw","file":"libvirt-1-storage","offset":0,"size":<source-bytes>,...}:
The sum of offset (0) and size (0) has to be smaller or equal to the actual size of the
containing file (<target-bytes>)
```

The two byte values disagree by a fraction of a percent — for example, source `17,482,664,378,368` bytes vs. target `17,482,235,510,784` bytes (~409 MiB short) — despite the two PVCs sharing the same `.spec.resources.requests.storage` value.

## Root Cause

A dynamic storage provisioner must honour at least the requested PVC size, but is permitted to provision a `PersistentVolume` larger than the request. When the PVC uses `volumeMode: Block`, the bound `PersistentVolume` is mapped to the `virt-launcher` pod as a raw block device, and QEMU sees the **actual provisioned capacity of the PV**, not the requested PVC size. Live storage migration creates a fresh destination PVC (via the `VirtualMachineStorageMigrationPlan` CR's `targetMigrationPVCs[].destinationPVC`, where `volumeMode` is a first-class enum accepting `Block`). If the source PV was over-provisioned past the request by its provisioner while the destination PV was allocated more tightly, the destination's raw block device ends up smaller than the source's address space. QEMU detects this precondition violation before any data is copied and aborts the migration with the `offset (0) and size (0) has to be smaller or equal to the actual size of the containing file` error.

The over-provisioning is real on ACP's default storage. On a lab cluster the default `StorageClass` `topolvm-hdd` (provisioner `topolvm.cybozu.com`, LVM-backed, 4 MiB physical extents) was issued a `Block` PVC requesting `1610612737` bytes; the bound `PersistentVolume` reported `.spec.capacity.storage = 1540Mi = 1614807040` bytes, i.e. `+4194303` bytes (one full LVM extent) over the request. A second `Block` PVC issued against the same `StorageClass` with a request only two bytes smaller (`1610612735`) bound to a PV reporting `1536Mi = 1610612736` bytes — a `4 MiB` divergence in actual provisioned capacity between two PVs whose `.spec.resources.requests.storage` values are byte-for-byte identical at the `Quantity` level. The same mechanism scales up to the ~409 MiB gap seen in the field when source and target use differently-tuned provisioners.

## Diagnostic Steps

The discrepancy is invisible at the PVC layer. Both the source and the destination PVC will report identical `.spec.resources.requests.storage`, and a `kubectl describe pvc` comparison will look healthy. The actual provisioned capacity surfaces on the bound `PersistentVolume`, not on the PVC, so the comparison must be done at the PV layer.

Confirm the two PVCs requested the same storage:

```bash
kubectl -n <vm-namespace> get pvc <source-pvc> <target-pvc> \
  -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.spec.resources.requests.storage}{"\n"}{end}'
```

Then compare the actual capacity of the two bound PVs — this is where the mismatch becomes visible:

```bash
kubectl get pv \
  -o jsonpath='{range .items[*]}{.metadata.name}{" capacity="}{.spec.capacity.storage}{" claim="}{.spec.claimRef.namespace}/{.spec.claimRef.name}{"\n"}{end}' \
  | grep -E '<source-pvc>|<target-pvc>'
```

For `topolvm` specifically, the per-volume `LogicalVolume` CR exposes the underlying realized size and confirms how the request was rounded:

```bash
kubectl get logicalvolumes.topolvm.cybozu.com \
  -o jsonpath='{range .items[*]}{.metadata.name}{": spec.size="}{.spec.size}{" status.currentSize="}{.status.currentSize}{"\n"}{end}'
```

If the source PV's `.spec.capacity.storage` is greater than the destination PV's, the live storage migration will hit the QEMU precondition every time it is retried until the destination is grown past the source.

## Resolution

Expand the destination PVC's storage request to a value greater than or equal to the actual byte count of the source PV (not the source PVC's request). The destination `StorageClass` must have `allowVolumeExpansion: true`; the default `topolvm-hdd` on ACP satisfies this:

```bash
kubectl get sc topolvm-hdd -o jsonpath='{.allowVolumeExpansion}{"\n"}'
```

```text
true
```

Patch the destination PVC's `.spec.resources.requests.storage` to the source PV's actual byte count:

```bash
kubectl -n <vm-namespace> patch pvc <target-pvc> --type=merge \
  -p '{"spec":{"resources":{"requests":{"storage":"<source-PV-actual-bytes>"}}}}'
```

The provisioner expands the bound block device in place; this was confirmed on `topolvm-hdd`, where patching a PVC's request from `1610612735` to `1610612740` bytes grew the bound PV's `.spec.capacity.storage` from `1536Mi` to `1540Mi` without recreating the PVC. Once the destination PV's `.spec.capacity.storage` is at least the source PV's `.spec.capacity.storage`, retrying the live storage migration lets QEMU's `-blockdev` precondition pass and the migration proceeds.

Use the byte count taken from the source PV's `.spec.capacity.storage`, or from the QEMU error message itself (the `size` value in the failing `-blockdev` line) — not the value from the source PVC's request, which is what produced the mismatch in the first place.
