---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Migrating VMware VMs With Raw Device Mapping (RDM) Disks Is Not Supported
## Overview

Operators planning a lift-and-shift of virtual machines out of vSphere into the ACP virtualization stack (KubeVirt-based, documented under `virtualization`) sometimes ask whether VMs whose disks are presented as **Raw Device Mapping** (RDM) — i.e. a vSphere construct that lets a guest address a SAN LUN directly, bypassing the VMFS abstraction — can be migrated through the platform's "migrate from VMware" workflow. The short answer is no: RDM-backed disks cannot be carried across by the migration pipeline that the platform exposes for VMware sources.

This article documents the limitation and the supported alternative.

## Root Cause

The migration workflow on ACP for VMware sources is built on the same OSS lineage as the upstream MTV/Forklift project. Its disk-transfer phase relies on `virt-v2v` (cold migration) or VMware VDDK-based streaming (warm migration) to read the source disk through the vSphere API and write it as a `DataVolume` against the destination cluster's storage. Both paths assume the disk is a regular VMDK file backed by a VMFS or vSAN datastore.

RDM disks break that assumption. The vSphere API exposes them as a passthrough mapping to a raw SCSI LUN, not as a VMDK file the transfer machinery can read sequentially. Neither `virt-v2v` nor the warm-migration streamer has a code path for serialising raw SAN LUNs through the standard transfer mechanism, so the migration plan rejects (or silently skips) the disk.

The result is that even if the rest of the VM (config, NICs, OS disk) migrates cleanly, any RDM-backed disk is left behind. The destination VM either cannot start (its config references a disk that does not exist) or starts in a degraded state with the RDM device gone.

## Resolution

There is no in-pipeline option to convert an RDM disk into a regular `DataVolume` automatically. The supported approach is to remove the RDM dependency from the source VM **before** migrating it:

1. **Detach the RDM disk in the source environment.** From vSphere, edit the source VM and remove the RDM device. Do this with the VM either powered off or after a clean shutdown of the workload that owns the data on that LUN, so no in-flight writes are lost.

2. **Carry the data across by another path.** The data on the SAN LUN is not migrated by the platform pipeline. Move it through whichever channel is appropriate for the workload:

   - **File-system-level copy** (preferred when the LUN holds an application file system): mount the LUN on a temporary host, `rsync`/`tar` the contents to a fresh `PersistentVolumeClaim` provisioned on the destination cluster, then attach that PVC to the migrated VM.
   - **Block-level export** (preferred when the LUN holds a raw database volume or any payload that is sensitive to file-system semantics): use a block-aware imager (`dd` to a sparse image, or the storage array's own export tool) to produce a disk image, upload it via the platform's `image` surface (under `virtualization/image`), and create a new disk on the destination VM from that image.
   - **Application-native replication** (preferred when downtime budget is tight): rely on the application's own replication or backup-restore procedure (database log shipping, object-store sync, MQ broker mirroring) so the destination VM picks up an already-replicated copy of the data and the original LUN can be retired in place.

3. **Run the standard migration plan against the now-RDM-free source VM.** With only VMDK disks left on the source, the platform's "migrate from VMware" workflow processes the VM end-to-end: the OS disk and any remaining data disks become `DataVolume` objects, the VM definition is recreated, and the workload boots on the destination cluster.

4. **Attach the new data volume to the migrated VM** and validate. If the data was carried as a PVC, add it to the destination VM's `spec.template.spec.volumes` and `spec.template.spec.domain.devices.disks` blocks; if it was uploaded as an image, create a `DataVolume` from that source and reference the resulting PVC. Boot the VM and confirm the workload sees the disk at the expected path or device.

5. **Retire the source RDM.** After the destination workload is verified healthy, decommission the source VM and reclaim the SAN LUN — leaving an RDM dangling in the source environment after the cutover invites accidental writes from the wrong side of the migration.

## Diagnostic Steps

Before planning the migration, identify which VMs in the source inventory carry RDM disks. From a host with vSphere CLI access:

```text
govc vm.info -dc <datacenter> -vm.path '<source-folder>/*' -e | \
  awk '/Path:/ && /\.vmdk/ {print} /CompatibilityMode|RawDiskMappingVer1BackingInfo/'
```

Any line containing `RawDiskMappingVer1BackingInfo` flags an RDM disk on the VM directly above it. Build the list of impacted VMs ahead of time so the migration plan does not surprise the operator at run time.

After the migration completes, confirm the destination VM's disks are all PVC-backed:

```bash
kubectl -n <vm-namespace> get vm <vm-name> -o jsonpath='{.spec.template.spec.volumes}{"\n"}' | \
  jq '.[] | {name: .name, type: (keys | map(select(. != "name"))[0])}'
```

Every entry should be `dataVolume` or `persistentVolumeClaim`. A volume of type `hostDisk` or anything pointing at a host-mounted device indicates the migration left a passthrough behind, which is not portable and should be re-modelled as a PVC before the VM is considered cut-over.
