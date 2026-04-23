---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A running VirtualMachine is being migrated between storage classes. Both the source and destination PersistentVolumeClaims request the same capacity, yet the migration fails in QEMU with a size-mismatch error surfaced in the `virt-launcher` pod log:

```text
-blockdev {"driver":"raw","file":"libvirt-1-storage","offset":0,"size":17482664378368,...}:
  The sum of offset (0) and size (0) has to be smaller or equal
  to the actual size of the containing file (17482235510784)
```

The numbers suggest the target block device is slightly smaller (~400 MiB, in this example) than the source. The PVC objects themselves look identical, so a quick `kubectl describe pvc` does not reveal the discrepancy.

## Root Cause

PVC `resources.requests.storage` is a *floor*, not an exact size. The Kubernetes storage contract lets a provisioner hand back a PV that is at least the requested size but is permitted to be larger. Different storage backends round differently:

- Some backends snap to their allocation unit (e.g. 4 GiB, 1 GiB, 128 MiB) and return the rounded-up size on the PV.
- Some backends return exactly the requested bytes.

For a VM running with `volumeMode: Block`, the QEMU process sees the **raw block device** — its byte count is the PV's actual size, not the PVC's request. When the source backend provisioned a PV slightly larger than requested (e.g. 16.00 TiB because its allocation unit is 1 GiB) and the target backend provisioned exactly the requested amount (15.999 TiB), the source disk address space extends past the end of the target device. QEMU's safety check in the `raw` block driver refuses to import data into a smaller device and aborts with the `offset + size` error.

In filesystem-mode PVs this problem is hidden by the filesystem layer: the disk image file just ends where the data ends. Block mode has no such buffer.

## Resolution

Align the destination PV's **actual** byte count with the source's actual byte count, not just the PVC request. There are three options, in order of preference.

1. **Request the source's actual size on the target PVC.** Read the source PV's byte capacity and set the target PVC request to at least that many bytes:

   ```bash
   SRC_PV=$(kubectl get pvc -n <ns> <src-pvc> -o jsonpath='{.spec.volumeName}')
   kubectl get pv "$SRC_PV" \
     -o jsonpath='{.spec.capacity.storage}{"\n"}'
   # -> "16297Gi" (example)
   ```

   Patch the destination PVC to request the same (or larger):

   ```bash
   kubectl -n <ns> patch pvc <dst-pvc> --type=merge \
     -p '{"spec":{"resources":{"requests":{"storage":"17482664378368"}}}}'
   ```

   If the target StorageClass supports online expansion (most do), the provisioner will grow the PV and the live migration resumes on the next reconcile.

2. **Pick a target StorageClass whose allocation unit matches the source.** If you are doing a bulk migration, this is more predictable than patching every PVC individually. Consult the StorageClass parameters or the driver docs to determine its rounding behaviour, then provision a target whose unit is ≥ the source's.

3. **Convert to filesystem mode for the migration, then back.** Only viable for downtime-tolerant VMs; involves a cold migration through a filesystem-backed intermediate PVC. Use this only when neither of the above is possible.

As a forward-looking prevention: when you know your storage plan in advance, always round the PVC request up to a multiple of the target backend's allocation unit. Asking for `17T` on a backend that allocates in 1 GiB blocks is fine; asking for `17482235510784` bytes on one backend and migrating to another that rounds differently is an accident waiting to happen.

## Diagnostic Steps

Identify the actual byte count on each side:

```bash
SRC_PVC=<source-pvc>; DST_PVC=<dest-pvc>; NS=<ns>
SRC_PV=$(kubectl -n $NS get pvc $SRC_PVC -o jsonpath='{.spec.volumeName}')
DST_PV=$(kubectl -n $NS get pvc $DST_PVC -o jsonpath='{.spec.volumeName}')

kubectl get pv $SRC_PV -o jsonpath='{.spec.capacity.storage}{"\n"}'
kubectl get pv $DST_PV -o jsonpath='{.spec.capacity.storage}{"\n"}'
```

For block-mode PVs, confirm the raw device size visible to the virt-launcher pod:

```bash
LAUNCHER=$(kubectl -n $NS get pod -l kubevirt.io=virt-launcher \
             -o jsonpath='{.items[0].metadata.name}')
kubectl -n $NS exec $LAUNCHER -- \
  sh -c 'for d in /dev/disk; do blockdev --getsize64 "$d" 2>/dev/null || true; done'
```

Inspect the QEMU error in context:

```bash
kubectl -n $NS logs $LAUNCHER -c compute | grep -A3 'offset (0) and size (0)'
```

Confirm the target StorageClass permits expansion (some CSI drivers do not):

```bash
kubectl get storageclass $(kubectl get pv $DST_PV -o jsonpath='{.spec.storageClassName}') \
  -o jsonpath='{.allowVolumeExpansion}{"\n"}'
```

If expansion is not allowed, you must delete and recreate the target PVC at the correct size; in-place expansion will not happen.
