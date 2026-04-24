---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A virtual machine running on the platform's KubeVirt-based virtualization stack unexpectedly pauses and does not resume immediately. The VM may eventually recover on its own after a delay, but the symptom repeats.

The `VirtualMachineInstance` status reports:

```text
message: VMI was paused, low-level IO error detected
reason: PausedIOError
```

On inspection, the cluster and the backing storage system report plenty of free space, and the VM's other disks (PVCs) look healthy. Only one specific PVC is stuck, and that is the one the guest reports I/O errors against.

## Root Cause

The backing PVC itself is not full in the Kubernetes sense — its `spec.resources.requests.storage` still reports capacity available — but the underlying storage-array volume has run out of **snapshot reserve** space. On systems like ONTAP-backed storage provisioned through Trident (`csi.trident.netapp.io`), each FlexVol carves a portion of its capacity into a dedicated snapshot reserve. When that reserve fills up:

- New writes cannot complete until the snapshot reserve has room.
- The writes that are already in flight fail with a low-level I/O error.
- QEMU / libvirt in `virt-launcher` sees the write error and pauses the guest to protect its disk consistency — hence `PausedIOError` in the VMI status.

Typical contributors to snapshot-reserve exhaustion:

- A rapid churn inside the guest that generates many changed blocks, while frequent external snapshots are retained.
- A VM disk whose data area happens to match its configured size — the reserve was sized based on an assumption that turned out to be wrong.
- Array-side snapshots retained by a separate backup policy (outside the platform) that the cluster operator is not aware of.

## Resolution

### Preferred path on ACP

ACP virtualization (`docs/en/virtualization/`) mirrors the upstream KubeVirt model — the VM object refers to PVCs (via `DataVolume` or existing PVCs), and the backing storage is any CSI driver configured in the cluster. When a VM reports `PausedIOError` caused by backing-volume exhaustion, the remediation is to act on the CSI layer and the storage array, not on the VM object — the VM will automatically resume once the underlying I/O path recovers.

Storage-level backup and snapshot lifecycle should be managed centrally through ACP **`configure/backup`** (Velero-based) when the array itself is not authoritative, so that snapshot retention policies applied at Kubernetes level are accounted for alongside any native array snapshots.

### Underlying mechanics — recovering a paused VM

1. **Free the snapshot reserve.** The most direct fix is to delete snapshots that are no longer needed. If the snapshots are managed on the storage array directly, delete them from the array's management interface. If they were created through the platform's Volume Snapshot objects, delete the corresponding `VolumeSnapshot`:

   ```bash
   kubectl -n <ns> get volumesnapshot
   kubectl -n <ns> delete volumesnapshot <snapshot-name>
   ```

   Wait for the storage system to reclaim the reserve before proceeding.

2. **Expand the PVC.** Increasing the PVC size grows both the data area and the snapshot reserve proportionally (for backends where the reserve is a fixed percentage):

   ```bash
   kubectl -n <ns> patch pvc <pvc-name> \
     --type=merge -p '{"spec":{"resources":{"requests":{"storage":"<new-size>"}}}}'
   ```

   This is a quick unblock but, on its own, only postpones the recurrence — the workload's snapshot-generation rate has not changed.

3. **Resize the snapshot reserve or enable auto-grow on the array.** For ONTAP-backed volumes, either:

   - **Raise the snapshot reserve** on the volume (consult the storage vendor's documentation for the exact management command set; options typically include `volume modify -snapshot-policy` and `volume modify -percent-snapshot-space` on ONTAP).
   - **Enable automatic volume expansion** in the CSI driver so that the volume grows when usage reaches a threshold — on Trident this is surfaced as a backend-level `autoGrow` / `snapshotReserve` configuration. Validate this against the vendor's current documentation, as the exact parameter names evolve.

4. **Resume the VM.** Once the I/O path recovers the VM resumes automatically. Verify by watching its status:

   ```bash
   kubectl -n <ns> get vmi <vm-name> -o jsonpath='{.status.phase}{"\t"}{.status.conditions[?(@.type=="Paused")].reason}{"\n"}'
   ```

   A healthy VM returns to `Running` with no `Paused` condition. If it stays paused after the storage recovers, force-unpause it at the KubeVirt layer:

   ```bash
   kubectl -n <ns> patch vmi <vm-name> --type=merge \
     -p '{"spec":{"conditions":[{"type":"Paused","status":"False"}]}}'
   ```

   Prefer a clean resume over restart — a restart round-trips through the libvirt domain and can itself require new I/O against the still-recovering volume.

## Diagnostic Steps

Identify the exact PVC the paused VM is blocked on:

```bash
kubectl -n <ns> get vmi <vm-name> -o yaml | grep -E 'volumeName|claimName'
kubectl -n <ns> describe pvc <pvc-name>
```

Confirm the VMI state and the pause reason:

```bash
kubectl -n <ns> get vmi <vm-name> \
  -o jsonpath='{range .status.conditions[*]}{.type}={.status} ({.reason}){"\n"}{end}'
```

Inspect the virt-launcher pod log for the I/O error as QEMU reported it:

```bash
kubectl -n <ns> logs <virt-launcher-pod> -c compute | grep -i -E 'error|paused'
```

The guest itself will also report block-layer errors — on Linux guests, `dmesg` shows lines such as `Buffer I/O error on device vdX` or `blk_update_request: critical target error`.

On the storage array side, collect the PVC/LUN identifier (usually the Kubernetes PV name) and map it to the backend volume. Snapshot-reserve utilisation is visible at that level; a snapshot-reserve figure at 100 % confirms the hypothesis. If the reserve is not the root cause (for example, the underlying volume itself is full), treat it as a different capacity problem and expand the volume accordingly.
