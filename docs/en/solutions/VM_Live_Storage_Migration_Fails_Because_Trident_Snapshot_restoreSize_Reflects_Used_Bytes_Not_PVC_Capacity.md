---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VM Live Storage Migration Fails Because Trident Snapshot restoreSize Reflects Used Bytes, Not PVC Capacity
## Issue

A virtual machine is created from an Instance Type or from a VM snapshot whose data source is backed by a **volume snapshot on NetApp Trident**. Trying to relocate that VM's disk to a different StorageClass — either with **Live Storage Migration** in-cluster, or with a cross-cluster migration — fails. Two distinct error shapes appear:

In-cluster Live Storage Migration returns a `qemu-kvm` error describing a geometry mismatch:

```text
exited while connecting to monitor: qemu-kvm: -blockdev
  {"driver":"raw","file":"libvirt-2-storage","offset":0,"size":32211206144,
   "node-name":"libvirt-2-slice-sto","read-only":false,"discard":"unmap",
   "cache":{"direct":true,"no-flush":false}}:
  The sum of offset (0) and size (0) has to be smaller or equal to the actual
  size of the containing file (1914699776)
```

Cross-cluster migration of the same VM fails inside the data importer:

```text
'Unable to process data: Unable to convert source data to target format:
 virtual image size 32211206144 is larger than the reported available storage
 12064915456. A larger PVC is required'
```

In both cases the reported "containing file" / "available storage" is a couple of gigabytes, while the guest image thinks it owns tens of gigabytes.

## Root Cause

Inspecting the objects involved reveals the layering:

- The VM spec references a `DataSource` (via an Instance Type) that points at a cluster `linux9` DataSource object in the image-library namespace.
- That DataSource's `source.snapshot` points at a `VolumeSnapshot` (for example, `linux9-ab4ec16077fe`).
- The `VolumeSnapshot` is sitting on a **NetApp Trident**-managed StorageClass.

A snapshot on a Trident volume records a `restoreSize` that reflects the **used** bytes of the PVC at snapshot time, **not** the **provisioned** capacity of the originating PVC. When the virtualization stack creates a new PVC from that snapshot, it sizes the new PVC off `restoreSize`. The resulting target PVC therefore carries a request like `2030693254` bytes (≈ the used data), while the original PVC was provisioned at `34144990004` bytes (≈ 32 GiB) and the VM image inside it assumes that larger geometry.

Two concrete consequences:

1. **Live Storage Migration** writes the image into a destination PVC of the smaller size; `qemu` then refuses to attach because the block device is smaller than the image geometry (`actual size of the containing file (1914699776)` < `size 32211206144`).
2. **Cross-cluster migration** runs the CDI importer on the destination, which converts the source into the target PVC. The importer sees a target PVC that is far smaller than the reported virtual image size and aborts with `A larger PVC is required`.

The ACP virtualization stack expects `VolumeSnapshot.status.restoreSize` to equal the provisioned capacity of the source PVC. That is the CSI convention most drivers implement; Trident's behaviour of reporting used bytes is a CSI-driver choice on the NetApp side, not a bug in the virtualization operator.

## Resolution

### Preferred: expand the destination PVC to match the source PVC capacity, then re-run the migration

Until the CSI driver side reports `restoreSize` that matches provisioned capacity, the operator-level workaround is to resize the destination PVC up to the source PVC's capacity and let the migration retry.

1. Capture the source PVC's provisioned capacity (what the VM actually sees):

   ```bash
   NS=test
   SRC_PVC=linux-vm-94-volume

   kubectl -n "$NS" get pvc "$SRC_PVC" \
     -o jsonpath='{.status.capacity.storage}'
   # e.g.: 34144990004
   ```

2. Find the destination PVC created by the migration (its name carries a `-mig-` suffix and a short random tag):

   ```bash
   kubectl -n "$NS" get pvc | grep -E 'mig-'
   # linux-vm-94-volume-mig-gosjnb-mig-wvmw   Bound   ...   RWX   sc-nas-3   ...
   ```

3. Edit the destination PVC and raise `spec.resources.requests.storage` to match the source capacity. The destination StorageClass must have `allowVolumeExpansion: true` for this to take effect online:

   ```bash
   DST_PVC=linux-vm-94-volume-mig-gosjnb-mig-wvmw
   kubectl -n "$NS" patch pvc "$DST_PVC" --type=merge \
     -p '{"spec":{"resources":{"requests":{"storage":"34144990004"}}}}'
   ```

4. Wait for the expansion to report success:

   ```bash
   kubectl -n "$NS" get pvc "$DST_PVC" -o wide -w
   ```

   The `CAPACITY` column should rise to the source value.

5. Re-trigger the migration:
   - For in-cluster **Live Storage Migration**, start a new migration job from the virtualization UI against the same VM and target StorageClass — the pre-existing destination PVC is reused.
   - For **cross-cluster migration**, restart the migration Plan (the previous run left an undersized target behind — it must be retried so the importer can write into the now-resized PVC).

The source VM is not touched by any of this; the workaround only operates on the target side.

### Fallback: fix at the data-source layer before the VM is ever created

If the affected VM has not yet been created, or a fleet of future VMs should avoid the trap, repack the DataSource so it no longer depends on a `VolumeSnapshot` whose `restoreSize` under-reports capacity. Two shapes work:

- **Use a PVC-backed DataSource instead of a snapshot-backed one.** Populate a PVC from the golden image at the desired provisioned capacity, then point the DataSource at that PVC (`spec.source.pvc`). PVC-backed clones report the full provisioned capacity.
- **Pre-clone the snapshot to a PVC of the correct size** in the image-library namespace, and use that PVC as the DataSource's backing reference. This is the same as the previous option but preserves the snapshot workflow for other tools that still need it.

Separately, this is worth raising with the CSI-driver vendor: the convention across most CSI implementations is that `VolumeSnapshot.status.restoreSize` equals the provisioned capacity of the source PVC. Whether the driver exposes a configuration knob to align with that convention is a vendor-side question; track it outside this runbook.

## Diagnostic Steps

Confirm the DataSource shape that the failing VM was created from:

```bash
VM_NS=test
VM_NAME=linux-vm-94

kubectl -n "$VM_NS" get virtualmachine "$VM_NAME" -o yaml \
  | yq '.spec.dataVolumeTemplates,.spec.template.spec.volumes'
```

Look for a `sourceRef` that points at a `DataSource` rather than at a `PVC` — this is the shape affected by the snapshot-sizing mismatch:

```yaml
spec:
  dataVolumeTemplates:
    - spec:
        sourceRef:
          kind: DataSource
          name: linux9
          namespace: cpaas-virtualization-os-images
```

Inspect the DataSource and confirm it is snapshot-backed:

```bash
kubectl -n cpaas-virtualization-os-images get datasources.cdi.kubevirt.io linux9 -o yaml \
  | yq '.spec.source'
# snapshot:
#   name: linux9-ab4ec16077fe
#   namespace: cpaas-virtualization-os-images
```

Inspect the VolumeSnapshot and record its `restoreSize`:

```bash
kubectl -n cpaas-virtualization-os-images get volumesnapshot linux9-ab4ec16077fe -o yaml \
  | yq '.status.restoreSize'
# "1869896Ki"
```

Compare against the capacity the VM actually sees on the source PVC:

```bash
kubectl -n "$VM_NS" get pvc linux-vm-94-volume \
  -o yaml | yq '.spec.resources.requests'
# storage: "2030693254"

kubectl -n "$VM_NS" get pvc linux-vm-94-volume \
  -o yaml | yq '.status.capacity.storage'
# "34144990004"
```

If `status.capacity.storage` on the source is *much* larger than the destination PVC's capacity — and also much larger than the snapshot's `restoreSize` — the mismatch described above applies, and the resize workaround is the right next step.

Verify the destination StorageClass supports online expansion before attempting the patch:

```bash
kubectl get storageclass sc-nas-3 -o jsonpath='{.allowVolumeExpansion}{"\n"}'
# true
```

If it reports `false`, the PVC cannot be resized in place; the only remaining path is the data-source-layer fallback (pre-clone to a correctly sized PVC and use that as the DataSource).

Once the destination PVC has been resized and the migration retried, re-check the new PVC's capacity matches the source and confirm the VM boots on the destination disk:

```bash
kubectl -n "$VM_NS" get pvc "$DST_PVC" -o jsonpath='{.status.capacity.storage}{"\n"}'
# expect: same as source, 34144990004
kubectl -n "$VM_NS" get vmi "$VM_NAME"
# Phase: Running
```
