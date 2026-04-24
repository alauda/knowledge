---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A cluster operator bumps the request on the monitoring stack's Prometheus PVC — for example from 100 GiB to 250 GiB — and the object is accepted without error. `kubectl describe pvc` reports the new capacity and the `Bound` condition stays green. Inside the Prometheus pod, however, `df -h /prometheus` still shows the original size:

```text
Filesystem      Size  Used Avail Use% Mounted on
/dev/rbd0       100G   99G    1G  99% /prometheus
```

The CSI node plugin logs look normal — they even report a successful `resizefs`:

```text
resizefs_linux.go:74  Device /dev/rbd0 resized successfully
resizefs_linux.go:156 Volume /dev/rbd0: device size=107374182400 filesystem size=107374182400
```

Both numbers equal the **old** capacity (100 GiB = 107374182400 bytes), which is the clue. The node-side filesystem grow was attempted but had nothing to grow onto, because the underlying Ceph RBD image was never expanded. Monitoring then fires near-full-disk alerts even though the user already "did the resize".

## Root Cause

Volume expansion on a Ceph RBD-backed PVC is driven by two cooperating controllers:

1. The **CSI external-resizer sidecar** (running alongside the RBD provisioner). It watches the PVC spec, calls `ControllerExpandVolume` against the CSI driver, and the driver in turn asks the Ceph MON/MGR to grow the RBD image.
2. The **CSI node plugin** on the node where the pod is mounted. Once step 1 reports success, the node plugin issues `NodeExpandVolume` to grow the on-disk filesystem (`xfs_growfs` or `resize2fs`) against the now-larger block device.

The failure pattern seen here is that the PVC object's `.status.capacity` is updated by the controller **before** the RBD image grow actually landed, or the `ControllerExpandVolume` call was dropped by the resizer and never retried. The node plugin then runs `NodeExpandVolume`, sees the block device at its old size, and dutifully "resizes" the filesystem to the size that it already is — hence the matching `device size == filesystem size` line at the old capacity, and no error. No subsequent expansion is scheduled because, from the API's point of view, the resize is done.

This is a RWO, single-replica workload like Prometheus, which makes the mismatch visible in a single pod. The ACP storage stack uses the same upstream `ceph-csi` project (`storage/storagesystem_ceph`), so the expansion contract, the `external-resizer` sidecar, and the `NodeExpandVolume` semantics described here apply directly. RWX volumes on CephFS use a different data path and are not affected.

## Resolution

Re-drive the expansion so that `ControllerExpandVolume` runs again and actually reaches the Ceph cluster. The trick is that the resizer only reconciles when it observes a spec change, so simply "saving" the current value is a no-op — the request size must be **strictly larger** than what is already recorded.

1. Restart the RBD provisioner deployment. This restarts the external-resizer sidecar too, clearing any stuck in-flight reconcile:

   ```bash
   kubectl -n <ceph-operator-namespace> rollout restart deployment <rbd-provisioner-deployment>
   ```

2. Bump the PVC request by any positive delta — 1 GiB is enough. PVC requests can only go up, so pick a value slightly above the current request:

   ```bash
   kubectl -n <monitoring-namespace> edit pvc prometheus-db-prometheus-0
   ```

   ```yaml
   spec:
     resources:
       requests:
         storage: 251Gi   # was 250Gi
   ```

3. Watch the `external-resizer` log on the RBD provisioner pod — it should now call `ControllerExpandVolume` with the new size, the RBD image should grow, and then the node plugin on the Prometheus host should run `NodeExpandVolume` with the new block device size.

4. Verify from inside the pod that `/prometheus` has actually grown:

   ```bash
   kubectl -n <monitoring-namespace> exec -it prometheus-0 -- df -h /prometheus
   ```

   The `Size` column should reflect the new value.

Prefer this over deleting and recreating the PVC: Prometheus TSDB blocks are not cheap to rebuild, and the `StatefulSet`'s controller will not automatically rebind to a replacement claim unless the operator managing the stack supports in-place PVC swap.

### When the two-layer expand is not the root cause

If the re-driven expansion still leaves the filesystem at the old size and the node plugin still logs `device size == filesystem size` at the old value, the RBD image itself is not growing. Check Ceph-side first (MON quorum, pool near-full ratio, MGR reachability) before blaming the CSI stack — the CSI driver surfaces cluster-side failures as controller-expand errors, but a MON outage or a pool at `full_ratio` will simply stall the call.

### Prevention / knobs

- Alauda Container Platform's Ceph storage system enables `allowVolumeExpansion: true` on the provided `StorageClass`es by default. If a custom `StorageClass` is in use, confirm this flag is set — otherwise the CSI driver will reject the expand up front, which is a different (and more obvious) failure.
- For PVCs with high write amplification like Prometheus, expanding *before* the filesystem is ≥ 85 % full avoids the noisy alert storm while the two-layer resize completes.

## Diagnostic Steps

1. Confirm the API-level size is what you expect. An already-expanded PVC metadata record is the signal that the first layer succeeded:

   ```bash
   kubectl -n <monitoring-namespace> describe pvc prometheus-db-prometheus-0 | grep -E 'Capacity|Status|StorageClass'
   ```

2. Compare with what the pod actually sees. If these disagree, the node plugin's view of the block device has not been refreshed:

   ```bash
   kubectl -n <monitoring-namespace> exec -it prometheus-0 -- df -h /prometheus
   ```

3. Cross-check with kubelet's exported capacity metric. A stale value here tracks the pod view, not the PVC spec:

   ```text
   kubelet_volume_stats_capacity_bytes{namespace="<monitoring-namespace>", pod=~"prometheus.*"}
   ```

4. Find the node where the Prometheus pod runs:

   ```bash
   kubectl -n <monitoring-namespace> get pod prometheus-0 -o wide
   ```

5. Find the RBD CSI node plugin pod co-located on that node:

   ```bash
   kubectl -n <ceph-operator-namespace> get pods -o wide | grep csi-rbdplugin
   ```

6. Read its `csi-rbdplugin` container log and grep for `resize`. The tell-tale signature of this bug is a `resizefs_linux.go` line where `device size` and `filesystem size` are identical **and** both match the old (not requested) capacity:

   ```bash
   kubectl -n <ceph-operator-namespace> logs <csi-rbdplugin-pod> -c csi-rbdplugin | grep resize
   ```

7. On the Ceph side, confirm the actual image size. If this still shows the old size, the `ControllerExpandVolume` call never reached Ceph — collect the `external-resizer` sidecar log from the provisioner pod to see why:

   ```bash
   kubectl -n <ceph-operator-namespace> logs <rbd-provisioner-pod> -c csi-resizer
   ```

If the resizer log shows repeated errors calling the CSI driver, restart the provisioner before re-bumping the PVC — a stuck gRPC channel will not self-recover until the sidecar is restarted.
