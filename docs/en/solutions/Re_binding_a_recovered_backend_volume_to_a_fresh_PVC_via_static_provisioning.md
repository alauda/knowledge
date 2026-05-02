---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A `PersistentVolume` was deleted in the cluster but the underlying volume on the storage backend was preserved (point-in-time snapshot, vendor undelete, retention policy on the array). The data is intact on the array; only the Kubernetes object that pointed to it is gone, so workloads that referenced it are stuck.

The goal is to attach a fresh PVC back to the saved backend volume **without** going through the dynamic provisioner — letting the CSI provisioner provision a new volume would create an empty one and discard the recovered data.

## Resolution

Use static provisioning: create a `PersistentVolume` whose `csi.volumeHandle` points directly at the backend volume's identifier, and lock it to a specific PVC with `claimRef`. This bypasses the provisioner entirely; the volume is "imported", not created.

### 1. Get the backend volume identifier

Talk to the storage admin (or read it from the array directly). What you need is the same string the CSI driver normally records in `pv.spec.csi.volumeHandle` — the array's native ID for the recovered volume. Note it down along with the volume's true capacity (the PV `capacity.storage` must match), the `volumeMode` (block vs filesystem), and the access modes the backend supports.

### 2. Create the PV

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: <pv-name>
spec:
  accessModes:
    - ReadWriteMany                       # or RWO; match what the volume actually supports
  capacity:
    storage: 10Gi                          # MUST match the real backend volume size
  persistentVolumeReclaimPolicy: Retain    # safety: never let Kubernetes delete the backend volume
  storageClassName: ""                     # empty so the dynamic provisioner is not involved
  volumeMode: Block                        # or Filesystem, depending on the workload
  csi:
    driver: <csi-driver-name>              # the CSI driver that originally provisioned the volume
    volumeHandle: "<volume-id-from-step-1>"
  claimRef:                                # lock-to-claim — only this PVC can bind here
    name: <pvc-name>
    namespace: <pvc-namespace>
```

Apply with `kubectl apply -f pv.yaml`.

The two important details:

- **`storageClassName: ""`** — leaving this empty (and therefore *not* matching any real StorageClass) tells the binder this PV is for static use. A non-empty class would let dynamic provisioning interfere.
- **`claimRef`** points at the PVC that *will* exist after the next step. Even though the PVC does not exist yet, the binder treats `claimRef` as the only allowed claimant and will reject any other claim that tries to grab this PV first.

### 3. Create the PVC pointing at the PV

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: <pvc-name>                          # must equal the name in the PV's claimRef
  namespace: <pvc-namespace>
spec:
  accessModes:
    - ReadWriteMany                         # must match the PV's accessModes
  resources:
    requests:
      storage: 10Gi                          # must match the PV's capacity
  storageClassName: ""                       # same empty class as the PV
  volumeMode: Block                          # must match the PV's volumeMode
  volumeName: <pv-name>                      # explicit binding to the PV created above
```

The PVC binds to the PV in seconds; the workload that mounts the PVC sees the recovered data.

### 4. Re-attach the workload

Point the original Pod / Deployment / StatefulSet at the PVC name. With the data on the array intact and the PV/PVC bound, the volume mounts and the application carries on with its previous state.

## Caveats

This volume is now **detached from the CSI driver's lifecycle**. Operations that the driver normally orchestrates have to be done by hand against the array:

- **Resize** — the CSI external-resizer will not act on this PV. Resize has to be performed on the storage backend, then the PV/PVC `capacity` updated.
- **Snapshot** — the cluster's `VolumeSnapshot` flow goes through the CSI driver and will not produce snapshots of an imported volume. Use the array's snapshot mechanism.
- **Delete** — `Retain` is set deliberately so Kubernetes never deletes the data when the PVC goes away. Cleanup of the backend volume has to be triggered manually on the array.

If you eventually want this volume to come back under the CSI driver's management, ask the storage vendor what additional fields (`csi.controllerExpandSecretRef`, vendor-specific volume attributes, `parameters` translated to the PV's `volumeAttributes`) the driver needs to recognise the volume as one of its own. Most CSI drivers can adopt an existing volume given the right metadata, but the exact field set is driver-specific.

## Diagnostic Steps

1. Confirm the backend volume exists and is intact before creating any cluster object. The smallest evidence is the array's own listing of the volume ID, its size, and its access mode. A volume that the storage admin says is "restored" but is in fact a fresh empty allocation will mount cleanly and present an empty filesystem — the failure shows up at the application layer.

2. After applying the PV, before applying the PVC, the PV should show:

   ```bash
   kubectl get pv <pv-name>
   # STATUS  Available   (or Released if it was Released; in either case the PVC can claim it)
   ```

   It should *not* be `Bound` to anything yet.

3. After applying the PVC, both objects should be `Bound`:

   ```bash
   kubectl get pv <pv-name>
   kubectl get pvc -n <pvc-namespace> <pvc-name>
   ```

   If the PVC stays `Pending`, common causes are: capacity mismatch (PVC asks for more than the PV has), access-mode mismatch, volumeMode mismatch, or the PVC's `volumeName` does not exactly match the PV's `metadata.name`.

4. Mount the PVC into a throwaway pod and verify the data is what you expect *before* pointing production at it:

   ```bash
   kubectl run -it --rm verify --image=<utility-image> \
     --overrides='{ "spec": { "volumes": [{"name":"d","persistentVolumeClaim":{"claimName":"<pvc-name>"}}],
                              "containers":[{"name":"c","image":"<utility-image>","stdin":true,"tty":true,
                                             "volumeMounts":[{"name":"d","mountPath":"/data"}]}] } }' \
     -n <pvc-namespace> -- sh
   # ls /data, head /data/<known-file>, etc.
   ```

5. Once the workload is happy, the PV's `Retain` policy means the backend volume will outlive the PVC if the PVC is deleted. That is intentional for recovery scenarios; flip the policy to `Delete` only after a full backup of the recovered data has been taken.
