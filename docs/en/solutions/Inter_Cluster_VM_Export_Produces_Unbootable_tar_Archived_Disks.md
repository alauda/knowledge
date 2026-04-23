---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A VirtualMachine exported from one cluster and imported into another fails to boot in the destination. The destination VM's disk shows up as a raw device that cannot be parsed by the bootloader. Inspecting the first MB of the disk reveals a **POSIX tar archive** rather than a filesystem or disk image.

```bash
kubectl exec -n <dst-ns> <virt-launcher-pod> -- dd if=/dev/vol-0 bs=1M count=1 > /tmp/disk.out
file /tmp/disk.out
# /tmp/disk.out: POSIX tar archive (GNU)
```

The source cluster reports the export completed successfully; the destination's CDI (Containerized Data Importer) reports the import completed successfully. Yet the bytes on disk are wrong.

## Root Cause

The export server picks an over-the-wire format based on the source PVC's metadata:

- PVCs owned by a **DataVolume** and carrying the annotation `cdi.kubevirt.io/storage.contentType: kubevirt` are exported as **raw disk streams** — CDI writes them verbatim into the destination volume and the guest boots.
- PVCs that lack both markers — typically those created directly by a VirtualMachine without going through a DataVolume, especially on filesystem-mode storage (NFS, filesystem CSI) — are exported as a **tar archive** containing `disk.img` inside. The destination CDI expects a raw stream, opens the target **block device** for sequential write, and dumps the entire tar file into it byte-for-byte. The tar bytes become the "disk content," and the bootloader sees garbage.

This is a bug in the export/import path when the annotation is missing and the PVC is owned by the VM directly. The fix is to mark the source PVC before initiating the export so the server picks the raw-disk path.

## Resolution

Annotate every source PVC that will be exported, then retry. The fix is non-destructive — it only adds metadata — and takes effect on the next export reconcile.

1. **Identify the source PVCs**. Each VirtualMachine's disk is a PVC referenced in `spec.template.spec.volumes`:

   ```bash
   kubectl -n <src-ns> get vm <vm> -o jsonpath='{range .spec.template.spec.volumes[*]}{.dataVolume.name}{.persistentVolumeClaim.claimName}{"\n"}{end}'
   ```

2. **Check owner and annotations before applying**:

   ```bash
   kubectl -n <src-ns> get pvc <pvc> \
     -o jsonpath='{"owner=\n"}{.metadata.ownerReferences}{"\nannotations=\n"}{.metadata.annotations}{"\n"}'
   ```

   The buggy pattern is: `ownerReferences` points at `kind: VirtualMachine` (not `DataVolume`) and `cdi.kubevirt.io/storage.contentType` is absent.

3. **Add the annotation** to every affected PVC. This is the single fix:

   ```bash
   kubectl -n <src-ns> annotate pvc <pvc> cdi.kubevirt.io/storage.contentType=kubevirt
   ```

   For a fleet, loop:

   ```bash
   for ns in <list-of-ns>; do
     kubectl -n "$ns" get pvc -l kubevirt.io/created-by=virtualmachine \
       --no-headers -o custom-columns=:.metadata.name \
     | xargs -I{} kubectl -n "$ns" annotate pvc {} cdi.kubevirt.io/storage.contentType=kubevirt --overwrite
   done
   ```

4. **Re-run the export/import workflow**. For a live migration plan, delete the failed destination VMI and re-trigger the plan:

   ```bash
   kubectl -n <dst-ns> delete vmi <vm>
   # then retrigger the migration plan or re-run the import
   ```

5. **Prevent recurrence.** For new VMs that will need exportability, create their PVCs as `DataVolume` spec members rather than standalone PVCs. DataVolumes set the content-type annotation automatically, and downstream tooling assumes the raw-stream export path.

## Diagnostic Steps

Confirm the on-disk corruption pattern before annotating anything — this keeps the fix reversible if the real issue turns out to be something else:

```bash
# From inside the destination virt-launcher
kubectl exec -n <dst-ns> <launcher-pod> -- \
  dd if=/dev/vol-0 bs=1M count=2 of=/tmp/disk-sample 2>/dev/null
kubectl exec -n <dst-ns> <launcher-pod> -- file /tmp/disk-sample
```

`POSIX tar archive` or `tar archive` confirms the pattern. `DOS/MBR boot sector` or `x86 boot sector` means the disk is written correctly and the boot failure is a different issue (UEFI/BIOS mismatch, missing drivers, guest-OS corruption).

Audit the annotation state across source PVCs to estimate exposure before the fleet-wide fix:

```bash
kubectl get pvc -A -o json \
  | jq -r '.items[]
      | select((.metadata.annotations."cdi.kubevirt.io/storage.contentType" // "") != "kubevirt")
      | select((.metadata.ownerReferences // [])[0].kind // "" != "DataVolume")
      | "\(.metadata.namespace)/\(.metadata.name)"'
```

Every line in that output is at risk of the same bug on next export; annotate pre-emptively.
