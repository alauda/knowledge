---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# VMware-to-KubeVirt VM migration fails with destination smaller than source on encrypted Ceph RBD
## Issue

A VMware virtual-machine migration into a KubeVirt-backed cluster fails
during the disk-transfer phase with:

```text
nbdcopy: error: destination size (32195477504) is smaller than
  source size (32212254720)
virt-v2v: error: nbdcopy exited with non-zero error code 1
```

The destination PVC has been provisioned at the same size as the source
disk but the data copy stops short. The size deficit is small in
absolute terms (under 20 MiB) but it is enough for `nbdcopy` to refuse
to start the transfer.

## Root Cause

The destination StorageClass uses encrypted Ceph RBD volumes:

```yaml
parameters:
  clusterID: <ceph-cluster-id>
  encrypted: "true"
  pool: <rbd-pool>
```

When Ceph creates an encrypted RBD image, it stores encryption metadata
(the LUKS header and key slots) inside the image itself. The metadata
consumes a fixed slice of the image's allocated capacity. The effective
**usable** size of an encrypted RBD device is therefore the requested
capacity minus the encryption header — roughly 16 MiB in the typical
LUKS layout, sometimes more depending on the cipher and key-slot
configuration.

The migration controller provisions the destination PVC at exactly the
source disk's size — for a 30 GiB source it requests a 30 GiB PVC. After
Ceph carves out the encryption header, the usable block device is
slightly smaller than 30 GiB. `nbdcopy` measures the destination size at
the block-device layer (after the header) and refuses to write a 30 GiB
source into the slightly-smaller destination because the trailing bytes
would be lost.

The same shape happens on any encrypted CSI volume with non-zero
on-disk encryption overhead. Ceph RBD is the most visible case because
its overhead is documented and consistent; other encryption modes
(per-volume LUKS, vendor-managed encryption with reserved metadata
sectors) reproduce the issue with different numeric overheads.

## Resolution

Tell the workload-migration provider to pad the destination PVC by a
small amount on top of the source disk size. The provider exposes a
controller-side knob (`controller_block_overhead`) that adds a buffer
to every provisioned destination volume:

```bash
kubectl patch <provider-controller-cr> -n <migration-ns> \
  --type=merge \
  -p '{"spec":{"controller_block_overhead": "500Mi"}}'
```

`500Mi` is the recommended setting for encrypted Ceph RBD — it covers
the LUKS header with comfortable headroom, and the storage cost per
migrated VM is negligible. Adjust upward if the destination uses a
different encrypted-storage layout that reserves more space.

After the patch, the controller pod restarts and subsequent migrations
provision destination PVCs with the buffer included. `nbdcopy` sees a
destination block device larger than the source and the transfer
completes.

For an in-flight failed migration:

1. Roll the controller change first (so the override is in effect).
2. Delete the failed migration plan's destination PVCs (they are
   undersized and unusable).
3. Re-issue the migration. The new PVCs are correctly sized and the
   transfer succeeds.

If the destination StorageClass is **not** encrypted, the buffer is
unnecessary and adds slight allocation overhead per VM with no
functional benefit. For environments that mix encrypted and
unencrypted destinations, set the buffer at the controller level and
accept the small allocation cost — the alternative (per-plan overrides)
is operationally fragile.

## Diagnostic Steps

1. Confirm the destination StorageClass uses encrypted RBD:

   ```bash
   kubectl get storageclass <class> -o yaml | yq '.parameters.encrypted'
   ```

   `"true"` confirms the encryption overhead is in play.

2. Confirm the destination PVC's reported size against the source
   disk:

   ```bash
   kubectl get pvc -n <ns> <pvc> -o jsonpath='{.spec.resources.requests.storage}'
   ```

3. Inspect the `virt-v2v` / `nbdcopy` log for the size mismatch
   message:

   ```bash
   kubectl logs -n <ns> <virt-v2v-pod> | grep -i "destination size"
   ```

   The numbers should differ by roughly 16 MiB (the LUKS header).

4. After applying the controller patch, verify the override took
   effect on the controller pod:

   ```bash
   kubectl exec -n <migration-ns> <controller-pod> -- env \
     | grep -i overhead
   ```

5. Re-run the migration plan and confirm the destination PVC is
   provisioned with the buffer:

   ```bash
   kubectl get pvc -n <ns> -l plan=<plan-name> \
     -o custom-columns=NAME:.metadata.name,SIZE:.spec.resources.requests.storage
   ```

   Each PVC should report a size equal to the source disk plus the
   configured overhead.
