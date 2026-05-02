---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Moving an Existing PVC Between StorageClasses
## Issue

A workload's persistent volume needs to live on a different `StorageClass` than the one it was originally provisioned against. The trigger is usually one of:

- the cluster gained a faster tier (NVMe-backed CSI) and high-traffic data should move there,
- the original class was deprecated or its parameters (filesystem, fstype, encryption) need to change,
- regulatory or topological requirements demand a different backend (e.g. zone-pinned vs. multi-zone replicated),
- the cluster operator wants a uniform class across namespaces and is consolidating older claims.

The reasonable-looking instinct is to "edit the PVC's `storageClassName`". That edit is rejected by the API server, and even if it were allowed, it would not move any data.

## Root Cause

`StorageClass` is recorded on the PV at provisioning time, and the parameters that the CSI driver baked into the underlying volume (filesystem, mount options, encryption keys, replication policy, zone) cannot be retrofitted by changing a label. Kubernetes treats `PersistentVolume.spec.storageClassName` and `PersistentVolumeClaim.spec.storageClassName` as immutable for this reason — the binding is not a pointer, it is a record of how the storage was made.

A direct move of a `PV` between classes therefore has no semantic meaning: the destination class might use a different backend driver, a different replication factor, or a different filesystem layout. The only general path is to provision a new volume in the target class and copy the data across.

## Resolution

The migration is a small choreographed sequence: provision the destination, copy the data, then either re-bind the workload or rename. Pick a window when the workload can be either stopped or run with a brief read-only pause, depending on whether the source data needs to be quiesced.

1. **Create the target PVC in the new StorageClass.** Match the size to the source (or larger) and the access mode to what the consumer needs.

   ```yaml
   apiVersion: v1
   kind: PersistentVolumeClaim
   metadata:
     name: app-data-new
     namespace: app
   spec:
     accessModes: ["ReadWriteOnce"]
     storageClassName: nvme-fast
     resources:
       requests:
         storage: 100Gi
   ```

2. **Quiesce the writer.** Either scale the workload's controller (`Deployment`, `StatefulSet`) to zero, or — for stateful systems with built-in snapshot support — take an application-consistent snapshot first and copy from the snapshot. A `Job` that mounts both PVCs read-only will not catch in-flight writes; only a stopped writer does.

   ```bash
   kubectl -n app scale deployment app --replicas=0
   ```

3. **Run a one-off Job to copy data between the two volumes.** The Job mounts both PVCs and uses any standard Linux copy utility — `rsync -aHAX --numeric-ids` is the safest because it preserves attributes, hardlinks and ACLs.

   ```yaml
   apiVersion: batch/v1
   kind: Job
   metadata:
     name: pvc-migrate
     namespace: app
   spec:
     backoffLimit: 0
     template:
       spec:
         restartPolicy: Never
         containers:
           - name: copy
             image: instrumentisto/rsync-ssh:3.3
             command: ["sh", "-ec"]
             args:
               - |
                 rsync -aHAX --numeric-ids --info=progress2 \
                   /src/ /dst/
             volumeMounts:
               - { name: src, mountPath: /src }
               - { name: dst, mountPath: /dst }
         volumes:
           - name: src
             persistentVolumeClaim: { claimName: app-data }
           - name: dst
             persistentVolumeClaim: { claimName: app-data-new }
   ```

4. **Re-point the workload at the new claim.** The simplest path is to update the consuming controller's `volumes[]` entry to reference the new PVC name, then scale the workload back up. If the application contract requires the original PVC name to be kept, instead delete the old PVC, then either rename the new PVC's binding manually (advanced; involves patching the PV's `claimRef`) or re-create the workload with the new name baked in.

5. **Validate before deleting the source.** Bring the workload up against the new PVC, run an end-to-end read/write test that exercises the data, and only then reclaim the old PVC. The reclaim policy on the old PV decides whether the storage is freed (`Delete`) or kept (`Retain`) — keep the source on `Retain` until the new tier is proven.

   ```bash
   kubectl -n app scale deployment app --replicas=1
   # ... validate the workload ...
   kubectl -n app delete pvc app-data
   ```

## Diagnostic Steps

Confirm the binding state of both volumes throughout the migration:

```bash
kubectl -n app get pvc app-data app-data-new -o wide
kubectl get pv $(kubectl -n app get pvc app-data-new \
  -o jsonpath='{.spec.volumeName}') -o yaml | head
```

Compare on-disk usage between source and destination after the copy completes — a mismatch usually means a sparse file expanded into a dense one, or a filesystem-specific feature (xattrs, ACLs) was not preserved by the copy:

```bash
kubectl -n app run check --rm -it --restart=Never \
  --image=alpine:3.19 \
  --overrides='
{
  "spec": {
    "containers": [{
      "name": "check", "image": "alpine:3.19",
      "command": ["sh","-c","du -sh /src /dst && find /src | wc -l && find /dst | wc -l"],
      "volumeMounts": [
        {"name":"src","mountPath":"/src"},
        {"name":"dst","mountPath":"/dst"}
      ]
    }],
    "volumes": [
      {"name":"src","persistentVolumeClaim":{"claimName":"app-data"}},
      {"name":"dst","persistentVolumeClaim":{"claimName":"app-data-new"}}
    ]
  }
}'
```

If the destination class is a different CSI backend than the source, also confirm that the new PV reports the expected `volumeAttributes` (filesystem, encryption key id, replication factor) — these come from the destination class and any mismatch with the source is exactly the reason direct re-binding is not supported.
