---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# PVC expansion stuck in Resizing because the Trident backend limitVolumeSize is below the requested size on ACP

## Issue

A PersistentVolumeClaim (PVC) on a NAS StorageClass served by NetApp Trident (driver `ontap-nas`) is expanded, for example from `5Gi` to `500Gi`, and the expansion never completes:

- `spec.resources.requests.storage` of the PVC shows the new size (`500Gi`), but `status.capacity.storage` and the bound PV still show the old size (`5Gi`).
- The PVC carries the condition `type: Resizing` and does not leave it.
- Trying to correct the size in the console is rejected because the new capacity must be larger than the value already in `spec` (for a `500Gi` request, the console asks for at least `501Gi`). The console cannot shrink the request back.
- The Trident controller log shows the resize being refused, for example:

```text
unsupported capacity range ... requested size: 536870912000 > the size limit: 214748364800
```

The StorageClass already has `allowVolumeExpansion: true`, and there is no LimitRange or ResourceQuota in the namespace that explains the rejection.

## Root Cause

Trident backends can cap the size of a single volume with the backend option `limitVolumeSize`. Trident checks every create and resize request against that cap and refuses any request above it. When a backend (for example a `TridentBackendConfig` deployed through the CSI Helm chart) is configured with `limitVolumeSize: 200g`, every PVC on that backend is limited to about 200 GiB. An expansion to `500Gi` (536870912000 bytes) is above the cap (214748364800 bytes), so the storage side never grows the volume.

Kubernetes has already accepted the larger `spec.resources.requests.storage` at this point. Kubernetes does not allow a PVC request to be lowered, so the PVC stays in `Resizing` with a request it can never reach, and the console only offers sizes above the current request.

## Resolution

Decide first which size the volume really needs:

- **The needed size fits under the backend limit** (for example `100Gi` under a `200g` cap): cancel the failed expansion and expand again within the limit, using option A or option B below.
- **The needed size is above the backend limit**: the cap is a setting of the Trident backend. Changing `limitVolumeSize` is a storage administration decision that the owner of the backend and the NAS must make. After the backend limit has been raised, the pending resize can be retried. Do not edit the Trident controller Deployment. The limit is not a controller argument.

### Option A: cancel the failed expansion and rebind the PVC to its PV

This follows the product procedure **Recover From PVC Expansion Failure** and keeps the data on the original volume.

> **Warning:** This procedure deletes the PVC object. If the PV reclaim policy is still `Delete` when the PVC is deleted, the volume and its data are deleted with it. Do it only after step 1 shows `Retain` on the PV. Stop the workload that mounts the PVC first. Rollback: as long as the PV is `Retain`, the data stays on the PV and can be bound again by a PVC that names it in `volumeName`.

1. Record the PV, its reclaim policy, and the current sizes, and save both objects:

   ```bash
   PV=$(kubectl -n <namespace> get pvc <pvc-name> -o jsonpath='{.spec.volumeName}')
   kubectl get pv "$PV" -o jsonpath='{.spec.persistentVolumeReclaimPolicy} {.spec.capacity.storage}{"\n"}'
   kubectl -n <namespace> get pvc <pvc-name> -o yaml > /tmp/<pvc-name>.yaml
   kubectl get pv "$PV" -o yaml > /tmp/"$PV".yaml
   kubectl patch pv "$PV" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
   ```

2. Scale the workload that uses the PVC to zero, then delete the PVC:

   ```bash
   kubectl -n <namespace> scale <deployment|statefulset>/<workload> --replicas=0
   kubectl -n <namespace> delete pvc <pvc-name>
   ```

3. Remove the old claim reference so the PV becomes `Available`:

   ```bash
   kubectl patch pv "$PV" --type json -p '[{"op":"remove","path":"/spec/claimRef"}]'
   kubectl get pv "$PV"
   ```

4. Recreate the PVC with the same name, StorageClass and access modes, `volumeName` set to the original PV, and a request that the PV can satisfy. The PV still has its old capacity (`5Gi` in the example), so the new request must not be larger than that capacity, or the PVC cannot bind:

   ```yaml
   apiVersion: v1
   kind: PersistentVolumeClaim
   metadata:
     name: <pvc-name>
     namespace: <namespace>
   spec:
     accessModes:
       - <same-access-mode-as-before>
     storageClassName: <storageclass-name>
     volumeName: <pv-name>
     resources:
       requests:
         storage: <current-pv-capacity>
   ```

5. Restore the original reclaim policy of the PV (the value recorded in step 1):

   ```bash
   kubectl patch pv "$PV" -p '{"spec":{"persistentVolumeReclaimPolicy":"<original-policy>"}}'
   ```

6. Expand the PVC again, this time to a size at or below the backend `limitVolumeSize`, and start the workload:

   ```bash
   kubectl -n <namespace> patch pvc <pvc-name> -p '{"spec":{"resources":{"requests":{"storage":"100Gi"}}}}'
   kubectl -n <namespace> scale <deployment|statefulset>/<workload> --replicas=<original-replicas>
   ```

### Option B: copy the data to a new PVC

Use this when you prefer not to touch the PV binding.

> **Warning:** The workload must be stopped while the data is copied, and the old PVC must not be deleted until the copy is verified. Rollback: keep the old PVC and point the workload back at it.

1. Stop the workload (scale its Deployment, StatefulSet or ReplicaSet to `0`).
2. Create a new PVC of the needed size (at or below the backend limit) on the same StorageClass.
3. Run a temporary Pod that mounts both PVCs and copy the data, for example with `cp -a` or `rsync -a`.
4. Verify the copy, point the workload at the new PVC (or recreate the old PVC name on the new volume), and start the workload.
5. Delete the old PVC only after the workload runs correctly on the new one.

## Diagnostic Steps

1. Compare the requested and the actual size of the PVC. A larger `spec` than `status` together with a `Resizing` condition means that the resize was accepted by Kubernetes but not done by the storage:

   ```bash
   kubectl -n <namespace> get pvc <pvc-name> \
     -o jsonpath='spec={.spec.resources.requests.storage} status={.status.capacity.storage}{"\n"}{.status.conditions}{"\n"}'
   kubectl get pv <pv-name> -o jsonpath='{.spec.capacity.storage}{"\n"}'
   ```

   Expected for this issue: `spec=500Gi status=5Gi`, a `Resizing` condition, and a PV that still shows `5Gi`.

2. Read the PVC events. An expansion that is only slow keeps showing progress. This issue shows a failed resize:

   ```bash
   kubectl -n <namespace> describe pvc <pvc-name>
   ```

3. Find the rejection in the Trident controller log:

   ```bash
   kubectl -n trident get pods
   kubectl -n trident logs <trident-controller-pod> --all-containers --tail=500 | grep -iE 'size limit|unsupported capacity range'
   ```

   Expected: `requested size: <bytes> > the size limit: <bytes>`. Divide the byte values by 1073741824 to get GiB.

4. Read the limit on the backend:

   ```bash
   kubectl -n trident get tridentbackendconfig
   kubectl -n trident get tridentbackendconfig <backend-config> -o jsonpath='{.spec.limitVolumeSize}{"\n"}'
   ```

   Expected: a value such as `200g` that is smaller than the requested size. When the backend was deployed with Helm, the same value is in the release values (`helm -n trident get values <release>`), and that is where it has to be changed so that the next upgrade does not reset it.

5. Rule out look-alikes. When the StorageClass has no `allowVolumeExpansion: true`, the expansion is refused right away instead of hanging in `Resizing`. A namespace LimitRange or ResourceQuota rejects the PVC edit itself, with an admission error:

   ```bash
   kubectl get storageclass <storageclass-name> -o jsonpath='{.allowVolumeExpansion}{"\n"}'
   kubectl -n <namespace> get limitrange,resourcequota
   ```
